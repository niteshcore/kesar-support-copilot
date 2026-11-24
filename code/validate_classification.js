// Nodes: "Validate Classification" (IS_REPAIR_PASS = false) and "Validate Repair" (IS_REPAIR_PASS = true)
// 1. parse the model output  2. deterministic repair  3. validate against schemas/llm_output.schema.json
// 4. first pass invalid -> the IF node sends it to one LLM repair call
// 5. repair pass still invalid -> safe fallback (intent "other", confidence 0, needs human)
const IS_REPAIR_PASS = __IS_REPAIR_PASS__;

const prev = IS_REPAIR_PASS ? $('Validate Classification').first().json : $('Prepare Email').first().json;
const inp = $input.first().json || {};

const INTENTS = ['order_status', 'product_query', 'return_refund', 'complaint', 'other'];
const SENTIMENTS = ['positive', 'neutral', 'negative', 'angry'];
const LANGS = ['en', 'hi', 'hinglish'];
const ISSUES = ['damaged', 'leaking', 'wrong_item', 'missing_item', 'change_of_mind', 'not_satisfied', 'adverse_reaction', 'none'];
const CONDITIONS = ['unopened', 'opened_or_used', 'unknown'];
const RESOLUTIONS = ['refund', 'replacement', 'none'];
const OTHER_CATS = ['spam', 'feedback', 'partnership', 'admin_request', 'unclear', 'none'];

// --- schema check (mirrors schemas/llm_output.schema.json) ---
function schemaErrors(o) {
  const errs = [];
  if (!o || typeof o !== 'object' || Array.isArray(o)) return ['output is not a JSON object'];
  for (const k of ['intent', 'secondary_intent', 'order_id', 'sentiment', 'language', 'confidence', 'summary']) {
    if (!(k in o)) errs.push('missing field: ' + k);
  }
  if ('intent' in o && !INTENTS.includes(o.intent)) errs.push('intent not in enum: ' + JSON.stringify(o.intent));
  if ('secondary_intent' in o && o.secondary_intent !== null && !INTENTS.includes(o.secondary_intent))
    errs.push('secondary_intent not in enum: ' + JSON.stringify(o.secondary_intent));
  if ('order_id' in o && o.order_id !== null && !(typeof o.order_id === 'string' && /^KC-[0-9]{4}$/.test(o.order_id)))
    errs.push('order_id must match KC-#### or be null: ' + JSON.stringify(o.order_id));
  if ('sentiment' in o && !SENTIMENTS.includes(o.sentiment)) errs.push('sentiment not in enum: ' + JSON.stringify(o.sentiment));
  if ('language' in o && !LANGS.includes(o.language)) errs.push('language not in enum: ' + JSON.stringify(o.language));
  if ('confidence' in o && !(typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1))
    errs.push('confidence must be a number 0..1: ' + JSON.stringify(o.confidence));
  if ('summary' in o && !(typeof o.summary === 'string' && o.summary.length <= 200))
    errs.push('summary must be a string of at most 200 chars');
  return errs;
}

// --- parse ---
function parseLoose(raw) {
  if (raw && typeof raw === 'object') return { obj: raw, strict: true };
  const text = String(raw || '').trim();
  if (!text) return { obj: null, strict: false };
  try {
    return { obj: JSON.parse(text), strict: true };
  } catch (e) {}
  // strip code fences / prose around the object, drop trailing commas
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a === -1 || b <= a) return { obj: null, strict: false };
  const candidate = text.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1');
  try {
    return { obj: JSON.parse(candidate), strict: false };
  } catch (e) {
    return { obj: null, strict: false };
  }
}

// --- deterministic repair: fixes formatting slips, never invents content ---
function tidy(o) {
  const repairs = [];
  const out = Object.assign({}, o);
  const enumFix = (k, allowed, map) => {
    if (typeof out[k] !== 'string') return;
    let v = out[k].trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (map && map[v]) v = map[v];
    if (v !== out[k]) {
      if (allowed.includes(v)) repairs.push(k + ' normalised');
      out[k] = v;
    }
  };
  enumFix('intent', INTENTS);
  enumFix('sentiment', SENTIMENTS);
  enumFix('language', LANGS, { english: 'en', hindi: 'hi' });
  if (typeof out.secondary_intent === 'string') {
    enumFix('secondary_intent', INTENTS);
    if (['', 'none', 'null', 'n/a'].includes(out.secondary_intent)) {
      out.secondary_intent = null;
      repairs.push('secondary_intent "' + o.secondary_intent + '" -> null');
    }
  }
  if (out.secondary_intent && out.secondary_intent === out.intent) out.secondary_intent = null;
  if (typeof out.order_id === 'string') {
    const m = /\bKC[-\s]?(\d{4})\b/i.exec(out.order_id);
    const fixed = m ? 'KC-' + m[1] : null;
    if (fixed !== out.order_id) repairs.push('order_id ' + JSON.stringify(out.order_id) + ' -> ' + JSON.stringify(fixed));
    out.order_id = fixed;
  }
  if (typeof out.confidence === 'string' && out.confidence.trim() !== '' && !isNaN(Number(out.confidence))) {
    out.confidence = Number(out.confidence);
    repairs.push('confidence string -> number');
  }
  if (typeof out.confidence === 'number' && out.confidence > 1 && out.confidence <= 100) {
    out.confidence = out.confidence / 100;
    repairs.push('confidence percent -> fraction');
  }
  if (typeof out.summary === 'string' && out.summary.length > 200) {
    out.summary = out.summary.slice(0, 197) + '...';
    repairs.push('summary truncated to 200 chars');
  }
  return { out, repairs };
}

const raw = inp.text !== undefined ? inp.text : inp.output !== undefined ? inp.output : '';
const llmError = inp.error ? String(inp.error.message || inp.error) : '';
const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw);

const parsed = parseLoose(raw);
const strictValid = parsed.strict && parsed.obj !== null && schemaErrors(parsed.obj).length === 0;

let cls = null;
let errors = [];
let repairs = [];
if (parsed.obj === null) {
  errors = [llmError ? 'LLM call failed: ' + llmError : 'output is not parseable JSON'];
} else {
  const t = tidy(parsed.obj);
  repairs = t.repairs;
  if (!parsed.strict) repairs.unshift('stripped non-JSON wrapper');
  errors = schemaErrors(t.out);
  if (errors.length === 0) cls = t.out;
}

const notes = (prev.cls_notes || []).slice();
let fallback = false;

if (!cls && IS_REPAIR_PASS) {
  // Last resort: never block the pipeline, never guess an intent. A human triages it.
  fallback = true;
  const ids = prev.pre.order_ids_in_text;
  cls = {
    intent: 'other',
    secondary_intent: null,
    order_id: ids.length === 1 ? ids[0] : null,
    sentiment: 'neutral',
    language: 'en',
    confidence: 0,
    summary: 'Automatic classification failed. Needs manual triage.',
  };
  notes.push('classification fallback used: ' + errors.join('; '));
}

if (cls) {
  // Optional extra fields (v2 prompt). Unknown values degrade to the safe default.
  const pick = (v, allowed, dflt) => (typeof v === 'string' && allowed.includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : dflt);
  cls.issue_type = pick(cls.issue_type, ISSUES, 'none');
  cls.product_condition = pick(cls.product_condition, CONDITIONS, 'unknown');
  cls.requested_resolution = pick(cls.requested_resolution, RESOLUTIONS, 'none');
  cls.other_category = pick(cls.other_category, OTHER_CATS, 'none');
  cls.medical_question = cls.medical_question === true;
  cls.injection_suspected = cls.injection_suspected === true;
  cls.requires_response = cls.requires_response === true;

  if (prev.config.prompt_version === 'v2') {
    // "Do not guess": the order ID must literally appear in the email.
    const ids = prev.pre.order_ids_in_text;
    if (cls.order_id && !ids.includes(cls.order_id)) {
      notes.push('order_id ' + cls.order_id + ' not present in email text -> null');
      cls.order_id = null;
    }
    if (!cls.order_id && ids.length === 1) {
      cls.order_id = ids[0];
      notes.push('order_id ' + ids[0] + ' taken from regex (classifier returned null)');
    }
  }
  if (repairs.length) notes.push('deterministic repair: ' + repairs.join(', '));
}

const out = Object.assign({}, prev, {
  classification: cls,
  cls_valid: !!cls,
  cls_fallback: fallback,
  cls_errors: errors,
  cls_first_errors: IS_REPAIR_PASS ? prev.cls_errors : errors,
  cls_notes: notes,
  cls_attempts: IS_REPAIR_PASS ? 2 : 1,
  cls_raw: IS_REPAIR_PASS ? prev.cls_raw : rawText,
  cls_repair_raw: IS_REPAIR_PASS ? rawText : '',
  json_valid_first_try: IS_REPAIR_PASS ? false : strictValid,
});

if (!cls && !IS_REPAIR_PASS) {
  out.repair_system = __PROMPT:classifier_repair__;
  out.repair_user = [
    'Your previous output was rejected.',
    'Problems: ' + errors.join('; '),
    '',
    'Previous output:',
    rawText ? rawText.slice(0, 2000) : '(empty)',
    '',
    'Original request:',
    prev.classifier_user,
  ].join('\n');
}

return [{ json: out }];
