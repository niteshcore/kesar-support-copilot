// ---- shared helpers (inlined into Code nodes and tools by scripts/build_workflow.js) ----
const POLICY = {
  RETURN_WINDOW_DAYS: 7, // faq.md section 4
  DEFECT_REPORT_DAYS: 2, // faq.md section 5: "within 48 hours" (orders only carry dates, so 48h = 2 calendar days)
};

function normEmail(s) {
  return String(s || '').trim().toLowerCase();
}

// The scenario timestamps carry their own +05:30 offset, so the local (IST) date is the first 10 chars.
function localDate(ts) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(ts || ''));
  return m ? m[1] : null;
}

function daysBetween(fromDate, toDate) {
  if (!fromDate || !toDate) return null;
  const a = fromDate.split('-').map(Number);
  const b = toDate.split('-').map(Number);
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
}

function weekday(date) {
  if (!date) return null;
  const p = date.split('-').map(Number);
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()
  ];
}

// Accepts whatever the HTTP Request node produced: {data: "<json text>"}, a parsed object, or an array.
function parseOrders(raw) {
  let d = raw;
  if (d && typeof d === 'object' && !Array.isArray(d) && d.data !== undefined && !d.orders) d = d.data;
  if (typeof d === 'string') d = JSON.parse(d);
  return Array.isArray(d) ? d : (d && d.orders) || [];
}

function textOf(raw) {
  if (raw && typeof raw === 'object' && raw.data !== undefined) return String(raw.data);
  return typeof raw === 'string' ? raw : JSON.stringify(raw || '');
}

function extractOrderId(s) {
  const m = /\bKC[-\s]?(\d{4})\b/i.exec(String(s || ''));
  return m ? 'KC-' + m[1] : null;
}

// The ONE place the privacy rule lives: an order is only returned when the sender's
// email address matches the order's customer_email.
function lookupOrder(orders, orderId, senderEmail) {
  const sender = normEmail(senderEmail);
  if (orderId) {
    const o = orders.find((x) => String(x.order_id).toUpperCase() === String(orderId).toUpperCase());
    if (!o) return { status: 'not_found', method: 'order_id', order: null };
    if (normEmail(o.customer_email) !== sender) return { status: 'access_denied', method: 'order_id', order: null };
    return { status: 'found', method: 'order_id', order: o };
  }
  const mine = orders.filter((x) => normEmail(x.customer_email) === sender);
  if (mine.length === 0) return { status: 'no_match', method: 'sender_email', order: null };
  if (mine.length === 1) return { status: 'found', method: 'sender_email', order: mine[0] };
  return { status: 'ambiguous', method: 'sender_email', order: null, candidates: mine.map((o) => o.order_id) };
}
// ---- end shared helpers ----
