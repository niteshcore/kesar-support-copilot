#!/usr/bin/env node
// Offline test of everything that is NOT an LLM call.
// It runs the same Code-node sources that are embedded in the workflow, in the same order,
// against all 25 emails. The classifier is replaced by tests/expected_classifications.json and the
// agent's draft by a canned reply, so this checks the lookup, privacy, eligibility, needs-human,
// ticket de-duplication and guardrail logic. It does NOT measure LLM quality.
//
// Run: node scripts/simulate.js            (prints a table, exits 1 if a check fails)
//      node scripts/simulate.js --md       (prints the table as markdown)
//      node scripts/simulate.js --write-expected   (refreshes tests/expected_outcomes.json)
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { ROOT, read, assemble } = require('./lib_build');

const emails = JSON.parse(read('data/test_emails.json')).emails;
const expected = JSON.parse(read('tests/expected_classifications.json'));
const fetched = {
  'Fetch Orders': { data: read('data/orders.json') },
  'Fetch FAQ': { data: read('data/faq.md') },
  'Fetch Brand Voice': { data: read('data/brand_voice.md') },
};

const SRC = {
  prepare: assemble('prepare_email.js'),
  validate: assemble('validate_classification.js', { IS_REPAIR_PASS: 'false' }),
  validateRepair: assemble('validate_classification.js', { IS_REPAIR_PASS: 'true' }),
  policy: assemble('policy_engine.js'),
  guard: assemble('guardrails_finalize.js'),
  ticket: assemble('ticket_upsert.js'),
  audit: assemble('build_audit_row.js'),
  getOrder: assemble('tool_get_order.js'),
  searchFaq: assemble('tool_search_faq.js'),
};

// Minimal stand-in for the n8n Code node runtime.
function run(src, inputItems, nodeData, query) {
  const wrap = (items) => ({ first: () => items[0], all: () => items, isExecuted: true });
  const $ = (name) => {
    if (!(name in nodeData)) return { first: () => { throw new Error('node not executed: ' + name); }, all: () => [], isExecuted: false };
    return wrap(nodeData[name].map((j) => ({ json: j })));
  };
  const out = new Function('$input', '$', 'query', src)(wrap(inputItems.map((j) => ({ json: j }))), $, query);
  return typeof out === 'string' ? out : out.map((i) => i.json);
}

function processEmail(email, opts) {
  const o = Object.assign({ version: 'v2', tickets: [], llmText: null, repairText: null, draft: null }, opts);
  const nodes = Object.assign({}, fetched, {
    Webhook: [{ body: email }],
    Config: [{ PROMPT_VERSION: o.version, CONFIDENCE_THRESHOLD: 0.75 }],
  });
  for (const k of Object.keys(fetched)) nodes[k] = [fetched[k]];

  nodes['Prepare Email'] = run(SRC.prepare, [{}], nodes);
  const llmText = o.llmText !== null ? o.llmText : JSON.stringify(expected[email.id]);
  nodes['Validate Classification'] = run(SRC.validate, [{ text: llmText }], nodes);
  let ctx = nodes['Validate Classification'][0];
  if (!ctx.cls_valid) {
    nodes['Validate Repair'] = run(SRC.validateRepair, [{ text: o.repairText === null ? '' : o.repairText }], nodes);
    ctx = nodes['Validate Repair'][0];
  }
  nodes['Policy Engine'] = run(SRC.policy, [ctx], nodes);
  ctx = nodes['Policy Engine'][0];

  let agentOut = ctx;
  const toolResults = {};
  if (ctx.classification.intent !== 'other') {
    toolResults.get_order = run(SRC.getOrder, [{}], nodes, { order_id: ctx.classification.order_id || '' });
    toolResults.search_faq = run(SRC.searchFaq, [{}], nodes, { query: ctx.classification.summary });
    const draft = o.draft !== null ? o.draft : 'Hi ' + email.from.name.split(' ')[0] + ',\n\nThank you for writing to us. (canned test draft)\n\nWarm regards,\nTeam Kesar';
    agentOut = {
      output: draft,
      intermediateSteps: [
        { action: { tool: 'get_order' }, observation: toolResults.get_order },
        { action: { tool: 'search_faq' }, observation: toolResults.search_faq },
      ],
    };
  }
  nodes['Guardrails & Finalize'] = run(SRC.guard, [agentOut], nodes);
  ctx = nodes['Guardrails & Finalize'][0];

  if (ctx.needs_ticket) {
    const row = run(SRC.ticket, o.tickets.length ? o.tickets : [{}], nodes)[0];
    nodes['Ticket Upsert Logic'] = [row];
    const i = o.tickets.findIndex((t) => t.ticket_id === row.ticket_id);
    if (i >= 0) o.tickets[i] = row;
    else o.tickets.push(row);
  }
  const audit = run(SRC.audit, [{}], nodes)[0];
  return { ctx, audit, toolResults };
}

// ---------------- run all 25 ----------------
const tickets = [];
const results = {};
for (const e of emails) results[e.id] = processEmail(e, { tickets });

const rows = emails.map((e) => {
  const r = results[e.id];
  return {
    id: e.id,
    intent: r.audit.intent,
    order: r.audit.order_id || '-',
    lookup: r.ctx.lookup.status,
    decision: r.audit.decision_code,
    human: r.audit.needs_human === 'TRUE' ? 'yes' : 'no',
    ticket: r.audit.ticket_id || '-',
    action: r.audit.action_taken,
    why: r.audit.needs_human_reason || '',
  };
});

if (process.argv.includes('--write-expected')) {
  const exp = {};
  for (const r of rows) exp[r.id] = { intent: r.intent, decision: r.decision, needs_human: r.human === 'yes', ticket: r.ticket !== '-', action: r.action };
  fs.writeFileSync(path.join(ROOT, 'tests', 'expected_outcomes.json'), JSON.stringify(exp, null, 2) + '\n');
}
if (process.argv.includes('--md')) {
  console.log('| Email | Intent | Order | Lookup | Decision | Needs human | Ticket | Why needs human |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log('| ' + [r.id, r.intent, r.order, r.lookup, r.decision, r.human, r.ticket, r.why.replace(/\|/g, ';')].join(' | ') + ' |');
} else {
  for (const r of rows) console.log([r.id, r.intent.padEnd(13), r.order.padEnd(7), r.lookup.padEnd(13), r.decision.padEnd(27), r.human.padEnd(3), r.ticket.padEnd(15), r.why].join('  '));
  console.log('\ntickets: ' + tickets.length + ', needs human: ' + rows.filter((r) => r.human === 'yes').length + ' / ' + rows.length);
}

// ---------------- checks ----------------
const R = (id) => results[id];
const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push([true, name]);
  } catch (err) {
    checks.push([false, name + ' -> ' + err.message.split('\n')[0]]);
  }
};

check('E07 privacy: order not released to a non-owner', () => {
  assert.strictEqual(R('E07').ctx.lookup.status, 'access_denied');
  assert.ok(R('E07').toolResults.get_order.includes('ACCESS_DENIED'));
  assert.ok(!R('E07').toolResults.get_order.includes('track.example.com'));
  assert.ok(!JSON.stringify(R('E07').ctx).includes('Chennai'));
});
check('E10 order found by sender email', () => {
  assert.strictEqual(R('E10').ctx.lookup.order_id, 'KC-1044');
  assert.ok(R('E10').toolResults.get_order.includes('KC-1044'));
});
check('E22 unknown order ID is not invented', () => {
  assert.strictEqual(R('E22').ctx.lookup.status, 'not_found');
  assert.strictEqual(R('E22').audit.needs_human, 'TRUE');
});
check('E03 / E11 / E19 eligible returns', () => {
  for (const id of ['E03', 'E11', 'E19']) assert.strictEqual(R(id).audit.decision_code, 'RETURN_ELIGIBLE', id);
  assert.ok(R('E03').ctx.agent_user.includes('INR 899'));
  assert.ok(R('E19').ctx.agent_user.includes('INR 1648'));
});
check('E12 / E16 used products are not eligible', () => {
  for (const id of ['E12', 'E16']) assert.strictEqual(R(id).audit.decision_code, 'RETURN_NOT_ELIGIBLE_USED', id);
});
check('E12 injection flagged, ticket still created, priority High', () => {
  assert.ok(R('E12').ctx.injection_suspected);
  assert.ok(R('E12').audit.ticket_id);
  assert.strictEqual(tickets.find((t) => t.order_id === 'KC-1055').priority, 'High');
});
check('E04 + E21 share one ticket', () => {
  assert.strictEqual(R('E04').audit.ticket_id, R('E21').audit.ticket_id);
  const t = tickets.filter((x) => x.order_id === 'KC-1052');
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].email_ids, 'E04, E21');
  assert.ok(R('E21').audit.action_taken.startsWith('ticket_updated'));
  assert.strictEqual(R('E04').audit.decision_code, 'DEFECT_NEEDS_PHOTOS');
  assert.strictEqual(R('E21').audit.decision_code, 'DEFECT_PENDING_VERIFICATION');
});
check('every return/complaint has a ticket, nothing else does', () => {
  for (const e of emails) {
    const a = R(e.id).audit;
    assert.strictEqual(!!a.ticket_id, ['return_refund', 'complaint'].includes(a.intent), e.id);
  }
  assert.strictEqual(tickets.length, 9);
});
check('complaints are High priority', () => {
  for (const t of tickets.filter((x) => x.intent === 'complaint')) assert.strictEqual(t.priority, 'High', t.ticket_id);
});
check('"other" emails get no reply draft', () => {
  for (const id of ['E06', 'E13', 'E17', 'E25']) assert.strictEqual(R(id).audit.reply_draft, '', id);
});
check('re-processing an email does not duplicate its ticket note', () => {
  const before = JSON.stringify(tickets.find((t) => t.order_id === 'KC-1052').notes);
  processEmail(emails.find((e) => e.id === 'E21'), { tickets });
  assert.strictEqual(tickets.filter((t) => t.order_id === 'KC-1052').length, 1);
  assert.strictEqual(JSON.stringify(tickets.find((t) => t.order_id === 'KC-1052').notes), before);
});

// classifier output handling
const E01 = emails[0];
check('fenced JSON is repaired without an LLM retry', () => {
  const r = processEmail(E01, { llmText: '```json\n' + JSON.stringify(expected.E01) + '\n```' });
  assert.strictEqual(r.ctx.cls_attempts, 1);
  assert.strictEqual(r.audit.json_valid_first_try, 'FALSE');
  assert.strictEqual(r.audit.intent, 'order_status');
});
check('invalid enum goes to the LLM repair call', () => {
  const bad = Object.assign({}, expected.E01, { intent: 'shipping_question' });
  const r = processEmail(E01, { llmText: JSON.stringify(bad), repairText: JSON.stringify(expected.E01) });
  assert.strictEqual(r.ctx.cls_attempts, 2);
  assert.strictEqual(r.audit.intent, 'order_status');
});
check('garbage twice falls back to other + needs human', () => {
  const r = processEmail(E01, { llmText: 'Sure! Here you go', repairText: 'I cannot' });
  assert.strictEqual(r.audit.intent, 'other');
  assert.strictEqual(r.audit.needs_human, 'TRUE');
  assert.strictEqual(r.audit.confidence, 0);
});
check('a guessed order ID is removed', () => {
  const r = processEmail(emails.find((e) => e.id === 'E10'), { llmText: JSON.stringify(Object.assign({}, expected.E10, { order_id: 'KC-1044' })) });
  assert.ok(r.audit.notes.includes('not present in email text'));
});

check('E18 with an overconfident classifier still needs a human, and the KC-1234 example is not flagged', () => {
  const r = processEmail(emails.find((e) => e.id === 'E18'), {
    llmText: JSON.stringify(Object.assign({}, expected.E18, { confidence: 0.95 })),
    draft: 'Hi Rahul,\n\nPlease send your order ID (format KC-1234).\n\nWarm regards,\nTeam Kesar',
  });
  assert.strictEqual(r.audit.needs_human, 'TRUE');
  assert.ok(r.audit.needs_human_reason.includes('none was found'), r.audit.needs_human_reason);
  assert.ok(!r.audit.needs_human_reason.includes('KC-1234'), r.audit.needs_human_reason);
});

// guardrails on a bad draft
check('guardrails catch an invented link, amount and approval', () => {
  const r = processEmail(emails.find((e) => e.id === 'E12'), {
    draft: 'Hi Manish,\n\nYour refund of Rs 9,999 has been approved. Track it at https://evil.example/claim\n\nWarm regards,\nTeam Kesar',
  });
  const why = r.audit.needs_human_reason;
  assert.ok(why.includes('link not found'), why);
  assert.ok(why.includes('amount not found'), why);
  assert.ok(why.includes('approved or processed'), why);
});
check('guardrails replace a draft that leaks another customer\'s order', () => {
  const r = processEmail(emails.find((e) => e.id === 'E07'), {
    draft: 'Hi Arjun,\n\nIt is on the way to Chennai: https://track.example.com/SS7781046\n\nWarm regards,\nTeam Kesar',
  });
  assert.ok(!r.audit.reply_draft.includes('track.example.com'));
  assert.ok(!r.audit.reply_draft.includes('Chennai'));
  assert.ok(r.audit.needs_human_reason.includes('PRIVACY'));
});
check('a correct draft with the real tracking link passes clean', () => {
  const r = processEmail(E01, { draft: 'Hi Ananya,\n\nYour order KC-1041 has shipped with SwiftShip: https://track.example.com/SS7781041\n\nWarm regards,\nTeam Kesar' });
  assert.strictEqual(r.audit.needs_human, 'FALSE', r.audit.needs_human_reason);
});
check('FAQ search finds the right section', () => {
  const faq = (q) => run(SRC.searchFaq, [{}], { 'Fetch FAQ': [fetched['Fetch FAQ']] }, { query: q });
  assert.ok(faq('cash on delivery limit').includes('## 2. Cash on Delivery'));
  assert.ok(faq('returns unopened seal').includes('## 4. Returns'));
  assert.ok(faq('saffron serum oily skin vegan').includes('## 7. Products'));
  assert.ok(faq('eczema cure').includes('## 8. Product Safety'));
  assert.ok(faq('shipping time north-east').includes('## 1. Shipping'));
  assert.ok(faq('gst invoice gstin').startsWith('NO_MATCH'));
});
check('v1 baseline runs end to end', () => {
  const r = processEmail(emails.find((e) => e.id === 'E12'), { version: 'v1' });
  assert.strictEqual(r.audit.prompt_version, 'v1');
  assert.strictEqual(r.audit.decision_code, 'NOT_COMPUTED');
});

const failed = checks.filter((c) => !c[0]);
if (!process.argv.includes('--md')) {
  console.log('');
  for (const [ok, name] of checks) console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  console.log('\n' + (checks.length - failed.length) + ' / ' + checks.length + ' checks passed');
}
process.exit(failed.length ? 1 : 0);
