#!/usr/bin/env node
// Turns an export of the "Audit Log" tab into the results table for TEST_REPORT.md.
//
//   1. Google Sheets: open the Audit Log tab -> File -> Download -> CSV -> save as audit_export.csv
//   2. node scripts/report_from_csv.js audit_export.csv
//
// It compares each row with tests/expected_outcomes.json (intent, ticket yes/no, needs-human yes/no,
// decision code) and prints the markdown rows plus the summary numbers.
// It canNOT judge whether a reply draft reads well or is factually right: read the drafts yourself
// and overrule a tick where the draft is wrong.
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/report_from_csv.js <audit_log_export.csv>');
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.some((x) => x !== '')).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
}

const ROOT = path.resolve(__dirname, '..');
const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'expected_outcomes.json'), 'utf8'));
const rows = parseCsv(fs.readFileSync(file, 'utf8'));

// last row wins when an email was run more than once in the same version
const byVersion = { v1: {}, v2: {} };
for (const r of rows) {
  const v = String(r.prompt_version || '').toLowerCase();
  if (byVersion[v] && r.email_id) byVersion[v][r.email_id] = r;
}

const truthy = (s) => String(s).trim().toUpperCase() === 'TRUE';
function judge(id, r) {
  if (!r) return null;
  const e = expected[id];
  const intentOk = r.intent === e.intent;
  const problems = [];
  if (!!r.ticket_id !== e.ticket) problems.push(e.ticket ? 'ticket missing' : 'unexpected ticket');
  if (truthy(r.needs_human) !== e.needs_human) problems.push(e.needs_human ? 'should need human' : 'should not need human');
  if (r.decision_code && r.decision_code !== 'NOT_COMPUTED' && r.decision_code !== e.decision) problems.push('decision ' + r.decision_code + ' (expected ' + e.decision + ')');
  if (/agent error|fallback used/.test(r.error || '')) problems.push('error logged');
  return { intentOk, actionOk: problems.length === 0, problems, action: r.action_taken, intent: r.intent };
}

const ids = Object.keys(expected);
const tick = (b) => (b ? '✅' : '❌');
console.log('| Email | Expected intent | Expected action | v1 intent | v1 action | v1 ✅/❌ | v2 intent | v2 action | v2 ✅/❌ | Notes |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
const stats = { v1: { n: 0, intent: 0, action: 0, first: 0, human: 0, tokens: 0 }, v2: { n: 0, intent: 0, action: 0, first: 0, human: 0, tokens: 0 } };
for (const id of ids) {
  const e = expected[id];
  const cols = [id, e.intent, e.action];
  const notes = [];
  for (const v of ['v1', 'v2']) {
    const r = byVersion[v][id];
    const j = judge(id, r);
    if (!j) { cols.push('—', '—', '—'); continue; }
    const s = stats[v];
    s.n++;
    if (j.intentOk) s.intent++;
    if (j.actionOk) s.action++;
    if (truthy(r.json_valid_first_try)) s.first++;
    if (truthy(r.needs_human)) s.human++;
    s.tokens += Number(r.approx_tokens) || 0;
    cols.push(j.intent, j.action, tick(j.intentOk && j.actionOk));
    if (j.problems.length) notes.push(v + ': ' + j.problems.join(', '));
    if (!j.intentOk) notes.push(v + ': intent ' + j.intent);
  }
  cols.push(notes.join('; '));
  console.log('| ' + cols.join(' | ') + ' |');
}

console.log('\n| Metric | Prompt v1 | Prompt v2 |');
console.log('|---|---|---|');
const line = (label, f) => console.log('| ' + label + ' | ' + f(stats.v1) + ' | ' + f(stats.v2) + ' |');
line('Emails run (*n*)', (s) => s.n);
line('Intent accuracy (x / *n*)', (s) => (s.n ? s.intent + ' / ' + s.n : '—'));
line('Correct action (x / *n*)', (s) => (s.n ? s.action + ' / ' + s.n : '—'));
line('Valid JSON on first try (x / *n*)', (s) => (s.n ? s.first + ' / ' + s.n : '—'));
line('Emails sent to "needs human"', (s) => (s.n ? s.human : '—'));
line('Avg. tokens per email (approx, chars/4)', (s) => (s.n ? Math.round(s.tokens / s.n) : '—'));
