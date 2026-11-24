// Agent tool: search_faq
// Splits faq.md by its "## " headings and returns the best-matching sections, verbatim.
// Keyword scoring is enough for a 9-section FAQ and keeps every answer traceable to a section.
// @include lib_shared.js

const faq = textOf($('Fetch FAQ').first().json);
const q = String(query && typeof query === 'object' ? query.query || '' : query || '').toLowerCase();

const parts = faq.split(/^## /m);
const intro = parts[0].trim();
const sections = parts.slice(1).map((p) => {
  const nl = p.indexOf('\n');
  return { title: p.slice(0, nl).trim(), text: ('## ' + p).replace(/\n---\s*$/, '').trim() };
});

const STOP = new Set('the a an is are was were be to of and or for in on at it this that my your our with can could would will do does how what when where which who i me we you they have has had not no if as by from about any get please tell know want need'.split(' '));
const SYN = {
  cod: ['cash', 'delivery', 'cod'],
  cash: ['cod'],
  deliver: ['shipping', 'dispatch', 'delivery'],
  delivery: ['shipping', 'dispatch'],
  ship: ['shipping', 'dispatch'],
  shipping: ['delivery', 'dispatch'],
  international: ['outside', 'india'],
  abroad: ['outside', 'india'],
  cancel: ['cancellation', 'cancelled', 'dispatch'],
  return: ['returns', 'unopened', 'seal', 'pickup'],
  refund: ['refunds', 'refunded'],
  broken: ['damaged'],
  cracked: ['damaged'],
  leak: ['leaking'],
  spilled: ['damaged', 'leaking'],
  wrong: ['wrong', 'item'],
  missing: ['missing', 'item'],
  replacement: ['replacement', 'damaged'],
  photo: ['photos'],
  ingredient: ['products', 'vegan'],
  skin: ['products', 'skin'],
  eczema: ['medical', 'condition', 'dermatologist', 'safety'],
  acne: ['medical', 'condition', 'dermatologist', 'acne'],
  pregnant: ['pregnancy', 'medical', 'doctor'],
  allergy: ['allergies', 'patch', 'doctor'],
  reaction: ['reaction', 'doctor', 'safety'],
  medical: ['medical', 'safety', 'doctor'],
  cure: ['cure', 'medical', 'safety'],
  contact: ['contact', 'hours', 'email'],
  collab: ['partnership', 'influencers'],
  wholesale: ['partnership', 'wholesale'],
  upi: ['upi', 'bank', 'refunds'],
};
const stem = (w) => w.replace(/(ing|ed|es|s)$/, '');

const tokens = [];
for (const w of q.split(/[^a-z0-9₹]+/).filter((x) => x.length > 2 && !STOP.has(x))) {
  for (const t of [w].concat(SYN[w] || [], SYN[stem(w)] || [])) {
    const s = stem(t);
    if (s.length > 2 && !tokens.includes(s)) tokens.push(s);
  }
}

const scored = sections
  .map((s) => {
    const body = s.text.toLowerCase();
    const title = s.title.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (title.includes(t)) score += 3;
      else if (body.includes(t)) score += 1;
    }
    return { s, score };
  })
  .filter((x) => x.score > 0)
  .sort((a, b) => b.score - a.score);

if (!scored.length) {
  return (
    'NO_MATCH: the FAQ has no section matching "' + q.slice(0, 120) + '". Available sections: ' +
    sections.map((s) => s.title).join(' | ') +
    '. Search again in English with words from a section title, or, if none of them covers the question, do not answer it: escalate with [NEEDS_HUMAN].'
  );
}

const top = scored.slice(0, 3).map((x) => x.s.text);
return 'FAQ excerpts (the only permitted source for policy and product facts):\n\n' + intro.split('\n').slice(-1)[0] + '\n\n' + top.join('\n\n');
