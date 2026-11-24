// Node: "Ticket Upsert Logic"
// Input: every row of the Tickets tab. Output: ONE row for "Append or Update Row" (matched on ticket_id).
// An open ticket for the same order is reused (email ID + note appended) instead of creating a duplicate.
const ctx = $('Guardrails & Finalize').first().json;
const rows = $input.all().map((i) => i.json).filter((r) => r && r.ticket_id);

const email = ctx.email;
const cls = ctx.classification;
const now = new Date().toISOString();

// Use the order ID the customer wrote even when we could not verify it, so follow-ups still group together.
const orderId = ctx.lookup.order_id || cls.order_id || '';
const isOpen = (r) => String(r.status || '').trim().toLowerCase() !== 'closed';
const sameCase = (r) =>
  orderId
    ? String(r.order_id || '').trim().toUpperCase() === orderId
    : !String(r.order_id || '').trim() && String(r.customer_email || '').trim().toLowerCase() === email.from_email;

const existing = rows.find((r) => isOpen(r) && sameCase(r));

const note =
  '[' + now.slice(0, 16).replace('T', ' ') + 'Z ' + email.id + '] ' + cls.summary +
  ' | ' + ctx.decision.code +
  (ctx.lookup.status !== 'found' ? ' | order ' + ctx.lookup.status : '') +
  (email.attachments.length ? ' | attachments: ' + email.attachments.join(', ') : '') +
  (ctx.needs_human ? ' | needs human: ' + ctx.needs_human_reasons.join('; ') : '');

const RANK = { Low: 1, Medium: 2, High: 3 };
let row;
if (existing) {
  const ids = String(existing.email_ids || '').split(/[,\s]+/).filter(Boolean);
  const already = ids.includes(email.id);
  if (!already) ids.push(email.id);
  const oldP = String(existing.priority || 'Medium');
  row = {
    ticket_id: String(existing.ticket_id),
    created_at: String(existing.created_at || ''),
    updated_at: now,
    order_id: String(existing.order_id || ''),
    customer_email: String(existing.customer_email || ''),
    email_ids: ids.join(', '),
    intent: String(existing.intent || cls.intent),
    priority: (RANK[ctx.ticket_priority] || 0) > (RANK[oldP] || 0) ? ctx.ticket_priority : oldP,
    status: String(existing.status || 'Open'),
    summary: String(existing.summary || cls.summary),
    notes: already ? String(existing.notes || '') : (existing.notes ? String(existing.notes) + '\n' : '') + note,
  };
} else {
  row = {
    ticket_id: 'TKT-' + (orderId ? orderId.replace('KC-', '') : 'NOORDER') + '-' + email.id,
    created_at: now,
    updated_at: now,
    order_id: orderId,
    customer_email: email.from_email,
    email_ids: email.id,
    intent: cls.intent,
    priority: ctx.ticket_priority,
    status: 'Open',
    summary: cls.summary,
    notes: note,
  };
}

return [{ json: row }];
