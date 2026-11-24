// Agent tool: get_order
// Behaves like an order API with built-in authorisation: the sender's email comes from the workflow
// (never from the model), so the agent cannot fetch an order that belongs to somebody else,
// whatever the email text asks for.
// @include lib_shared.js

const ctx = $('Policy Engine').first().json;
const orders = parseOrders($('Fetch Orders').first().json);
const q = String(query && typeof query === 'object' ? query.order_id || '' : query || '');
const orderId = extractOrderId(q);
const r = lookupOrder(orders, orderId, ctx.email.from_email);

if (r.status === 'found') {
  const o = r.order;
  const received = localDate(ctx.email.received_at);
  return JSON.stringify({
    result: 'FOUND',
    matched_by: r.method,
    order: o,
    computed: {
      email_received_date: received,
      days_since_delivery: o.delivered_date ? daysBetween(o.delivered_date, received) : null,
      days_until_estimated_delivery: !o.delivered_date && o.estimated_delivery ? daysBetween(received, o.estimated_delivery) : null,
    },
  });
}
if (r.status === 'access_denied') {
  return JSON.stringify({
    result: 'ACCESS_DENIED',
    message: 'The sender is not the customer on this order. Do not share or confirm any detail about it.',
  });
}
if (r.status === 'not_found') {
  return JSON.stringify({ result: 'ORDER_NOT_FOUND', message: 'No order with ID ' + orderId + ' exists. Do not guess any details.' });
}
if (r.status === 'ambiguous') {
  return JSON.stringify({ result: 'MULTIPLE_ORDERS', order_ids: r.candidates, message: 'Ask the customer which order they mean.' });
}
return JSON.stringify({
  result: 'NO_ORDER_FOR_SENDER',
  message: 'No order ID was given and no order exists under the sender\'s email address. Ask for the order ID.',
});
