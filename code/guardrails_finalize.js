// Node: "Guardrails & Finalize"
// Takes the agent's draft (or nothing, for "other") and checks it against the data before it is logged.
// A failed check never silently edits facts: it flags the row needs_human and says why.
// The one exception is a privacy leak, where the draft is replaced outright.
// @include lib_shared.js

const ctx = $('Policy Engine').first().json;
const inp = $input.first().json || {};
const email = ctx.email;
const cls = ctx.classification;
const V2 = ctx.config.prompt_version === 'v2';
const isReplyBranch = cls.intent !== 'other';

const reasons = ctx.pre_reasons.slice();
const notes = [];
let error = '';

const firstName = (email.from_name || '').trim().split(/\s+/)[0] || 'there';
const SIGN_OFF = 'Warm regards,\nTeam Kesar';
const holdingReply =
  'Hi ' + firstName + ',\n\nThank you for writing to us. A team member will review your message and follow up within 24 business hours.\n\n' + SIGN_OFF;

let draft = '';
let toolsCalled = [];
let toolText = '';

if (isReplyBranch) {
  const raw = inp.output !== undefined ? inp.output : inp.text !== undefined ? inp.text : '';
  draft = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (inp.error) error = 'agent error: ' + String(inp.error.message || inp.error);

  const steps = Array.isArray(inp.intermediateSteps) ? inp.intermediateSteps : [];
  toolsCalled = steps.map((s) => (s && s.action && s.action.tool) || '').filter(Boolean);
  toolText = steps.map((s) => (typeof s.observation === 'string' ? s.observation : JSON.stringify(s.observation || ''))).join('\n');

  // The agent's own escalation marker.
  const marker = /^\s*\[NEEDS_HUMAN:?\s*([^\]]*)\]\s*/i.exec(draft);
  if (marker) {
    reasons.push('agent: ' + (marker[1].trim() || 'could not answer from the FAQ/order data'));
    draft = draft.slice(marker[0].length);
  }

  // Brand voice clean-up (form only, never facts).
  draft = draft
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  if (!draft) {
    draft = holdingReply;
    reasons.push('no usable draft from the agent, holding reply used');
  } else if (!/Team Kesar\s*$/i.test(draft)) {
    draft = draft + '\n\n' + SIGN_OFF;
    notes.push('sign-off added');
  }

  if (V2 && draft !== holdingReply) {
    const orders = parseOrders($('Fetch Orders').first().json);
    const faq = textOf($('Fetch FAQ').first().json);
    const order = ctx.lookup.status === 'found' ? orders.find((o) => o.order_id === ctx.lookup.order_id) : null;
    const violations = [];

    // 1. Privacy: if the sender does not own the order, nothing from that order may appear.
    if (ctx.lookup.status === 'access_denied') {
      const real = orders.find((o) => o.order_id === cls.order_id);
      if (real) {
        const secrets = [real.tracking_url, real.customer_email, real.courier, real.shipping_address && real.shipping_address.line1, real.shipping_address && real.shipping_address.pincode, real.shipping_address && real.shipping_address.city]
          .filter(Boolean)
          .map((s) => String(s).toLowerCase());
        const leaked = secrets.filter((s) => draft.toLowerCase().includes(s));
        if (leaked.length) {
          draft =
            'Hi ' + firstName + ',\n\nThank you for reaching out. For privacy reasons we can only share order details with the email address that was used to place the order. ' +
            'Please ask the account holder to write to us from that address and we will be glad to help.\n\n' + SIGN_OFF;
          violations.push('PRIVACY: draft contained details of an order the sender does not own; draft replaced');
        }
      }
    }

    // 2. Links: only the verified order's tracking link or a link that is in the FAQ.
    const urls = draft.match(/https?:\/\/[^\s)>\]]+/gi) || [];
    for (const u0 of urls) {
      const u = u0.replace(/[.,;:!?]+$/, '');
      const ok = (order && order.tracking_url === u) || faq.includes(u);
      if (!ok) violations.push('link not found in order data or FAQ: ' + u);
    }

    // 3. Money: every rupee amount must exist in the order or the FAQ.
    const allowed = new Set();
    (faq.match(/\d[\d,]*/g) || []).forEach((n) => allowed.add(n.replace(/,/g, '')));
    if (order) {
      [order.subtotal, order.shipping_fee, order.cod_fee, order.total].forEach((n) => allowed.add(String(n)));
      (order.items || []).forEach((i) => {
        allowed.add(String(i.unit_price));
        allowed.add(String(i.unit_price * i.qty));
      });
      (String(order.refund_status || '').match(/\d[\d,]*/g) || []).forEach((n) => allowed.add(n.replace(/,/g, '')));
    }
    const amounts = draft.match(/(?:₹|Rs\.?|INR)\s?\d[\d,]*/gi) || [];
    for (const a of amounts) {
      const n = a.replace(/[^\d]/g, '');
      if (!allowed.has(n)) violations.push('amount not found in order data or FAQ: ' + a);
    }

    // 4. Order IDs: only the ones the customer wrote. KC-1234 is the format example our own brief
    //    gives the agent ("format KC-1234"), so it is not treated as an invented ID.
    const ids = draft.match(/\bKC[-\s]?\d{4}\b/gi) || [];
    for (const id of ids) {
      const norm = extractOrderId(id);
      if (norm === 'KC-1234') continue;
      if (!ctx.pre.order_ids_in_text.includes(norm) && norm !== ctx.lookup.order_id) violations.push('order ID not from this email: ' + id);
    }

    // 5. Never announce an approved/processed refund unless the order record itself says so.
    const approval = /(refund|replacement)[^.\n]{0,60}\b(has been|have been|is|was|been)\s+(approved|processed|credited|initiated|issued|dispatched)/i;
    if (approval.test(draft) && !(order && order.refund_status)) violations.push('draft states a refund/replacement as approved or processed');

    // 6. Medical claims. Crude keyword check; a hit only asks a human to look.
    if (/\b(cure[sd]?|heal(s|ed|ing)?|treats?|treated|treating|remedy)\b/i.test(draft)) {
      notes.push('draft mentions cure/treat/heal wording: check it is a disclaimer, not a claim');
      if (!reasons.some((r) => r.startsWith('medical'))) reasons.push('medical wording in draft');
    }

    if (violations.length) {
      reasons.push('guardrail: ' + violations.join(' | '));
    }
  }

  // Found in the v2 run (E18): the classifier gave a vague "Where is it???" 0.95 confidence, so the
  // threshold alone did not catch it. A customer chasing an order we cannot find always goes to a person.
  if (V2 && cls.intent === 'order_status' && ctx.lookup.status === 'no_match') reasons.push('customer is chasing an order but none was found for this sender');
} else {
  if (cls.other_category === 'partnership') notes.push('forward to partnerships@kesarandco.example (FAQ section 9)');
  if (cls.other_category !== 'none') notes.push('category: ' + cls.other_category);
}

// Rough size estimate only (characters / 4). Real token counts are not exposed by the agent node.
const approxTokens = Math.round(
  ((ctx.classifier_system || '').length + (ctx.classifier_user || '').length + (ctx.cls_raw || '').length + (ctx.cls_repair_raw || '').length +
    (isReplyBranch ? (ctx.agent_system || '').length + (ctx.agent_user || '').length + toolText.length + draft.length : 0)) / 4
);

if (ctx.decision.explanation) notes.unshift(ctx.decision.code + ': ' + ctx.decision.explanation);
if (cls.intent !== 'other') notes.push('order lookup: ' + ctx.lookup.status + ' (by ' + ctx.lookup.method.replace('_', ' ') + ')');
(ctx.cls_notes || []).forEach((n) => notes.push(n));
if (ctx.cls_attempts > 1) error = (error ? error + ' | ' : '') + 'classifier first output invalid (' + (ctx.cls_first_errors || []).join('; ') + '), ' + (ctx.cls_fallback ? 'repair call also failed, fallback used' : 'fixed by one repair call');

const out = Object.assign({}, ctx, {
  reply_draft: draft,
  needs_human: reasons.length > 0,
  needs_human_reasons: reasons,
  action_base: isReplyBranch ? 'draft_reply' : 'log_only',
  tools_called: toolsCalled,
  approx_tokens: approxTokens,
  final_notes: notes,
  final_error: error,
});
// keep the logged item small
delete out.agent_system;
delete out.classifier_system;

return [{ json: out }];
