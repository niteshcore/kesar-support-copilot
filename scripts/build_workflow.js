#!/usr/bin/env node
// Builds workflow/kesar_support_copilot.json from code/*.js and prompts/*.md.
// Run: node scripts/build_workflow.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT, assemble } = require('./lib_build');

const RAW = 'https://raw.githubusercontent.com/abhishek-patel-cadient/kesar-ai-copilot-assignment/refs/heads/main/data/';
const uid = (name) => {
  const h = crypto.createHash('md5').update('kesar:' + name).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), '4' + h.slice(13, 16), 'a' + h.slice(17, 20), h.slice(20, 32)].join('-');
};

const nodes = [];
const connections = {};
const add = (name, type, typeVersion, position, parameters, extra) => {
  nodes.push(Object.assign({ parameters, id: uid(name), name, type, typeVersion, position }, extra || {}));
  return name;
};
const link = (from, to, outIndex = 0, kind = 'main') => {
  connections[from] = connections[from] || {};
  connections[from][kind] = connections[from][kind] || [];
  while (connections[from][kind].length <= outIndex) connections[from][kind].push([]);
  connections[from][kind][outIndex].push({ node: to, type: kind, index: 0 });
};
const note = (name, content, position, width, height, color) =>
  add(name, 'n8n-nodes-base.stickyNote', 1, position, { content, width, height, color });

const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 };
const code = (name, file, pos, vars, extra) => add(name, 'n8n-nodes-base.code', 2, pos, { jsCode: assemble(file, vars) }, extra);
const http = (name, key, pos) =>
  add(
    name,
    'n8n-nodes-base.httpRequest',
    4.2,
    pos,
    {
      url: `={{ $('Config').first().json.${key} }}`,
      options: { response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } },
    },
    RETRY
  );
const sheetRef = (tab) => ({
  documentId: { __rl: true, mode: 'id', value: "={{ $('Config').first().json.GOOGLE_SHEET_ID }}" },
  sheetName: { __rl: true, mode: 'name', value: tab },
});
const boolCond = (expr) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id: uid(expr), leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and',
  },
  looseTypeValidation: true,
  options: {},
});

// ---------- 1. intake ----------
add('Webhook', 'n8n-nodes-base.webhook', 2, [0, 300], { httpMethod: 'POST', path: 'support-email', responseMode: 'lastNode', options: {} }, { webhookId: uid('webhook') });

const cfg = (name, value, type) => ({ id: uid('cfg:' + name), name, value, type });
add('Config', 'n8n-nodes-base.set', 3.4, [220, 300], {
  assignments: {
    assignments: [
      cfg('PROMPT_VERSION', 'v2', 'string'),
      cfg('CONFIDENCE_THRESHOLD', 0.75, 'number'),
      cfg('GOOGLE_SHEET_ID', '14uz7z-TBI9m4w1qoEyQqLWwFDD-tvAIICsP-F21Kygo', 'string'),
      cfg('ORDERS_URL', RAW + 'orders.json', 'string'),
      cfg('FAQ_URL', RAW + 'faq.md', 'string'),
      cfg('BRAND_VOICE_URL', RAW + 'brand_voice.md', 'string'),
    ],
  },
  includeOtherFields: true,
  options: {},
});
http('Fetch Orders', 'ORDERS_URL', [440, 300]);
http('Fetch FAQ', 'FAQ_URL', [660, 300]);
http('Fetch Brand Voice', 'BRAND_VOICE_URL', [880, 300]);
code('Prepare Email', 'prepare_email.js', [1100, 300]);

// ---------- 2. classify + validate / repair / fallback ----------
const chain = (name, pos, textKey, sysKey) =>
  add(
    name,
    '@n8n/n8n-nodes-langchain.chainLlm',
    1.7,
    pos,
    {
      promptType: 'define',
      text: `={{ $json.${textKey} }}`,
      messages: { messageValues: [{ message: `={{ $json.${sysKey} }}` }] },
      batching: {},
    },
    Object.assign({ onError: 'continueRegularOutput' }, RETRY)
  );
const gemini = (name, pos, temperature) =>
  add(name, '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', 1, pos, {
    modelName: 'models/gemini-2.5-flash',
    options: { temperature, maxOutputTokens: 2048 },
  });

chain('Classify Email', [1320, 300], 'classifier_user', 'classifier_system');
gemini('Gemini (classifier)', [1400, 520], 0);
code('Validate Classification', 'validate_classification.js', [1680, 300], { IS_REPAIR_PASS: 'false' });
add('Valid JSON?', 'n8n-nodes-base.if', 2.2, [1900, 300], boolCond('={{ $json.cls_valid }}'));
chain('Repair Classification', [2120, 480], 'repair_user', 'repair_system');
code('Validate Repair', 'validate_classification.js', [2480, 480], { IS_REPAIR_PASS: 'true' });

// ---------- 3. hard rules + routing ----------
code('Policy Engine', 'policy_engine.js', [2720, 300]);
const INTENTS = ['order_status', 'product_query', 'return_refund', 'complaint', 'other'];
add('Route by Intent', 'n8n-nodes-base.switch', 3.2, [2940, 260], {
  rules: {
    values: INTENTS.map((intent) => ({
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: uid('route:' + intent), leftValue: '={{ $json.classification.intent }}', rightValue: intent, operator: { type: 'string', operation: 'equals' } }],
        combinator: 'and',
      },
      renameOutput: true,
      outputKey: intent,
    })),
  },
  options: {},
});

// ---------- 4. AI agent with tools ----------
add(
  'Draft Reply (AI Agent)',
  '@n8n/n8n-nodes-langchain.agent',
  3,
  [3240, 180],
  {
    promptType: 'define',
    text: '={{ $json.agent_user }}',
    options: { systemMessage: '={{ $json.agent_system }}', maxIterations: 6, returnIntermediateSteps: true, enableStreaming: false },
  },
  Object.assign({ onError: 'continueRegularOutput' }, RETRY)
);
// Drafting runs on OpenAI: with Gemini, n8n's agent fails (400 "number of function response parts")
// whenever the model calls get_order and search_faq in the same turn.
add('OpenAI (agent)', '@n8n/n8n-nodes-langchain.lmChatOpenAi', 1.3, [3180, 420], {
  model: { __rl: true, mode: 'list', value: 'gpt-5-mini' },
  options: { reasoningEffort: 'low' },
});
const tool = (name, file, pos, description, schema) =>
  add(name, '@n8n/n8n-nodes-langchain.toolCode', 1.3, pos, {
    description,
    language: 'javaScript',
    jsCode: assemble(file),
    specifyInputSchema: true,
    schemaType: 'manual',
    inputSchema: JSON.stringify(schema, null, 2),
  });
tool(
  'get_order',
  'tool_get_order.js',
  [3340, 420],
  'Look up a Kesar & Co. order. Pass the order ID from the email (format KC-1234), or an empty string to look up by the sender\'s email address. Returns status, items, amounts, courier, tracking link and dates, but only if the order belongs to the person who sent the email. Call this before stating anything about an order.',
  { type: 'object', properties: { order_id: { type: 'string', description: 'Order ID such as KC-1041, or an empty string to look up by sender email' } }, required: ['order_id'] }
);
tool(
  'search_faq',
  'tool_search_faq.js',
  [3500, 420],
  'Search the official Kesar & Co. FAQ and policy document: shipping times and fees, cash on delivery, cancellation, returns, damaged/wrong/missing items, refunds, product facts, product safety, contact details. Pass a short English keyword query. This is the only permitted source for policy and product answers.',
  { type: 'object', properties: { query: { type: 'string', description: 'Short English keywords, e.g. "returns unopened seal" or "cash on delivery limit"' } }, required: ['query'] }
);

// ---------- 5. guardrails, tickets, audit log ----------
code('Guardrails & Finalize', 'guardrails_finalize.js', [3720, 300]);
add('Needs Ticket?', 'n8n-nodes-base.if', 2.2, [3940, 300], boolCond('={{ $json.needs_ticket }}'));
add(
  'Read Tickets',
  'n8n-nodes-base.googleSheets',
  4.5,
  [4160, 160],
  Object.assign({ resource: 'sheet', operation: 'read' }, sheetRef('Tickets'), { options: {} }),
  Object.assign({ alwaysOutputData: true }, RETRY)
);
code('Ticket Upsert Logic', 'ticket_upsert.js', [4380, 160]);
add(
  'Upsert Ticket',
  'n8n-nodes-base.googleSheets',
  4.5,
  [4600, 160],
  Object.assign({ resource: 'sheet', operation: 'appendOrUpdate' }, sheetRef('Tickets'), {
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['ticket_id'], schema: [] },
    options: { cellFormat: 'RAW', handlingExtraData: 'ignoreIt' },
  }),
  RETRY
);
code('Build Audit Row', 'build_audit_row.js', [4840, 300]);
add(
  'Append Audit Log',
  'n8n-nodes-base.googleSheets',
  4.5,
  [5060, 300],
  Object.assign({ resource: 'sheet', operation: 'append' }, sheetRef('Audit Log'), {
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
    options: { cellFormat: 'RAW', handlingExtraData: 'insertInNewColumn' },
  })
  // No Retry On Fail here: an append is not idempotent, and with retries on, every run wrote the row three times.
);

// ---------- wiring ----------
['Webhook', 'Config', 'Fetch Orders', 'Fetch FAQ', 'Fetch Brand Voice', 'Prepare Email', 'Classify Email', 'Validate Classification', 'Valid JSON?'].reduce((a, b) => (link(a, b), b));
link('Valid JSON?', 'Policy Engine', 0);
link('Valid JSON?', 'Repair Classification', 1);
link('Repair Classification', 'Validate Repair');
link('Validate Repair', 'Policy Engine');
link('Policy Engine', 'Route by Intent');
[0, 1, 2, 3].forEach((i) => link('Route by Intent', 'Draft Reply (AI Agent)', i));
link('Route by Intent', 'Guardrails & Finalize', 4);
link('Draft Reply (AI Agent)', 'Guardrails & Finalize');
link('Guardrails & Finalize', 'Needs Ticket?');
link('Needs Ticket?', 'Read Tickets', 0);
link('Needs Ticket?', 'Build Audit Row', 1);
link('Read Tickets', 'Ticket Upsert Logic');
link('Ticket Upsert Logic', 'Upsert Ticket');
link('Upsert Ticket', 'Build Audit Row');
link('Build Audit Row', 'Append Audit Log');
link('Gemini (classifier)', 'Classify Email', 0, 'ai_languageModel');
link('Gemini (classifier)', 'Repair Classification', 0, 'ai_languageModel');
link('OpenAI (agent)', 'Draft Reply (AI Agent)', 0, 'ai_languageModel');
link('get_order', 'Draft Reply (AI Agent)', 0, 'ai_tool');
link('search_faq', 'Draft Reply (AI Agent)', 0, 'ai_tool');

// ---------- canvas notes ----------
note('Note: intake', '## 1. Intake\nOne email per webhook call. **Config** holds the prompt version (v1/v2), the confidence threshold and the Google Sheet ID. Orders, FAQ and brand voice are fetched fresh.', [-40, 80], 1280, 160, 7);
note('Note: classify', '## 2. Classify + validate\nLLM returns JSON. Code validates it against the schema, repairs formatting slips, asks the LLM once more if still invalid, then falls back to `other` + needs human.', [1280, 80], 1340, 160, 4);
note('Note: rules', '## 3. Hard rules in code\nOrder lookup, privacy check, date maths, return eligibility, needs-human reasons. The LLM never decides these.', [2660, 80], 440, 160, 3);
note('Note: agent', '## 4. AI agent drafts the reply\nTools: `get_order` (only returns the sender\'s own order) and `search_faq`. "other" skips the agent.', [3140, 20], 520, 130, 5);
note('Note: output', '## 5. Guardrails, tickets, audit log\nDraft is checked against the data. Returns and complaints upsert a ticket (one open ticket per order). Every email gets an audit row.', [3680, 20], 1560, 110, 6);

const workflow = {
  name: 'Kesar & Co. Support Copilot',
  nodes,
  connections,
  active: false,
  settings: { executionOrder: 'v1' },
  pinData: {},
  meta: { templateCredsSetupCompleted: false },
  tags: [],
};

const outFile = path.join(ROOT, 'workflow', 'kesar_support_copilot.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(workflow, null, 2) + '\n');
console.log('wrote ' + path.relative(ROOT, outFile) + ' (' + nodes.length + ' nodes)');
