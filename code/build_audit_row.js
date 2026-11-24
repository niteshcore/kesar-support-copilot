// Node: "Build Audit Row"
// One row per email for the Audit Log tab. First 18 columns are the assignment template; the rest are extras.
const ctx = $('Guardrails & Finalize').first().json;
const email = ctx.email;
const cls = ctx.classification;

let ticketId = '';
let action = ctx.action_base;
if (ctx.needs_ticket && $('Ticket Upsert Logic').isExecuted) {
  const t = $('Ticket Upsert Logic').first().json;
  ticketId = t.ticket_id;
  action = (t.created_at === t.updated_at ? 'ticket_created' : 'ticket_updated') + ' + draft_reply';
}
if (ctx.needs_human) action += ' (needs human)';

return [
  {
    json: {
      email_id: email.id,
      received_at: email.received_at,
      from_email: email.from_email,
      intent: cls.intent,
      secondary_intent: cls.secondary_intent || '',
      order_id: cls.order_id || ctx.lookup.order_id || '',
      language: cls.language,
      sentiment: cls.sentiment,
      confidence: cls.confidence,
      order_found: cls.intent === 'other' && !cls.order_id ? 'n/a' : ctx.lookup.status === 'found' ? 'yes' : 'no (' + ctx.lookup.status + ')',
      action_taken: action,
      needs_human: ctx.needs_human ? 'TRUE' : 'FALSE',
      ticket_id: ticketId,
      reply_draft: ctx.reply_draft,
      prompt_version: ctx.config.prompt_version,
      processed_at: new Date().toISOString(),
      error: ctx.final_error,
      notes: ctx.final_notes.join(' | '),
      // extras
      needs_human_reason: ctx.needs_human_reasons.join(' | '),
      decision_code: ctx.decision.code,
      tools_called: ctx.tools_called.join(', '),
      json_valid_first_try: ctx.json_valid_first_try ? 'TRUE' : 'FALSE',
      approx_tokens: ctx.approx_tokens,
      summary: cls.summary,
    },
  },
];
