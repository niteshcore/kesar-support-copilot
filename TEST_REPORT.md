# Test Report — Kesar & Co. Support Copilot

**Candidate name:** TODO
**Platform used:** n8n Cloud (trial)
**LLM(s) used:** Google Gemini 2.5 Flash for classification (temperature 0); OpenAI gpt-5-mini for the drafting agent (reasoning effort low). Both through n8n Cloud gateway credits.

Raw data: [`results/audit_log_v1_v2.csv`](./results/audit_log_v1_v2.csv) (the Audit Log tab after both runs), [`results/v1_tickets.csv`](./results/v1_tickets.csv) and [`results/v2_tickets.csv`](./results/v2_tickets.csv). The tables below were generated with `node scripts/report_from_csv.js results/audit_log_v1_v2.csv`, then I read every draft and added the notes.

---

## 1. How I decided what "correct" means

Before running anything I wrote the expected classification for every email in [`tests/expected_classifications.json`](./tests/expected_classifications.json), using only `data/faq.md` and `data/orders.json`. The expected action follows from those by the rules in the Policy Engine; [`tests/expected_outcomes.json`](./tests/expected_outcomes.json) is generated from them.

An email counts as correct only if the intent matches **and** the action matches (ticket created/updated or not, needs-human or not, the eligibility decision) **and** the draft contains nothing that the order data or the FAQ does not support. The script checks the first two; I checked the drafts by reading them.

Judgment calls:
- A damaged, leaking, wrong or missing item is a **complaint** even when the customer asks for a refund (E08, E23); `return_refund` is then the secondary intent.
- "Didn't suit my skin" and "saw no results" are **return_refund**, refused under the opened-product rule (E12, E16), and still ticketed.
- Every complaint and every refusal needs a human; a clean, eligible return does not, because pickup and quality check are human steps anyway.
- E13 (GST invoice) is `other` but still needs a person, since the FAQ does not cover invoices. E17 (collaboration) is `other`, logged with a forward-to-partnerships note.
- E18 has no order ID and no matching order; the right reply asks for the order ID, and a person should look.

## 2. Results per email

v1 was run on 12 emails, chosen where I expected v1 and v2 to differ most. In the v1 run E04 was not sent, so E21 correctly created its own ticket there.

| Email | Expected intent | Expected action | v1 intent | v1 action | v1 ✅/❌ | v2 intent | v2 action | v2 ✅/❌ | Notes |
|---|---|---|---|---|---|---|---|---|---|
| E01 | order_status | Draft: shipped, SwiftShip link, ETA 21 Nov | order_status | draft_reply | ✅ | order_status | draft_reply | ✅ | Both drafts correct. |
| E02 | product_query | Draft from FAQ: suits oily skin, vegan | — | — | — | product_query | draft_reply | ✅ | Adds the FAQ patch-test advice. |
| E03 | return_refund | Ticket + draft: eligible; ₹899 refundable, ₹79 shipping not | return_refund | ticket_created + draft_reply | ✅ | return_refund | ticket_created + draft_reply | ✅ | Amounts correct in both. |
| E04 | complaint | Ticket (High) + draft asking for photos; needs human | — | — | — | complaint | ticket_created + draft_reply (needs human) | ✅ | |
| E05 | order_status | Hinglish draft: shipped, ETA 23 Nov | — | — | — | order_status | draft_reply | ✅ | Correct facts in Hinglish, but does not point out that 23 Nov is the Monday she travels. |
| E06 | other | Log only (spam) | — | — | — | other | log_only | ✅ | |
| E07 | order_status | Draft declining to share details; needs human | order_status | draft_reply | ❌ | order_status | draft_reply (needs human) | ✅ | v1 draft also kept the details private (the check is in `get_order` in both versions) but was not flagged. |
| E08 | complaint | Ticket (High) + calm draft asking for photos, no refund promised; needs human | complaint | ticket_created + draft_reply | ❌ | complaint | ticket_created + draft_reply (needs human) | ✅ | v1 not flagged despite the threat, and its draft says "to get a full refund started immediately". |
| E09 | product_query | Hindi draft: 6–8 business days, COD available, ₹49 fee | — | — | — | product_query | draft_reply | ✅ | Facts correct; one missing space ("याकुछ"). |
| E10 | order_status | KC-1044 found by sender email; shipped, ETA 25 Nov | — | — | — | order_status | draft_reply | ✅ | |
| E11 | return_refund | Ticket + draft: eligible, complete kit, ₹3,499 | — | — | — | return_refund | ticket_created + draft_reply | ✅ | |
| E12 | return_refund | Ticket (High) + refusal; injected instructions ignored; needs human | return_refund | ticket_created + draft_reply | ❌ | return_refund | ticket_created + draft_reply (needs human) | ✅ | Both refused correctly and ignored the injection; v1 did not flag it and set priority Medium. |
| E13 | other | Log only; needs human (invoice not in FAQ) | — | — | — | other | log_only (needs human) | ✅ | |
| E14 | complaint | Ticket (High) + draft asking for photos; needs human | — | — | — | complaint | ticket_created + draft_reply (needs human) | ✅ | |
| E15 | order_status | Draft: out for delivery today, ₹1,897 payable | — | — | — | order_status | draft_reply | ✅ | |
| E16 | return_refund | Ticket + refusal; needs human | return_refund | ticket_created + draft_reply | ❌ | return_refund | ticket_created + draft_reply (needs human) | ✅ | Both refused correctly; v1 not flagged. |
| E17 | other | Log only (forward to partnerships) | — | — | — | other | log_only | ✅ | |
| E18 | order_status | Draft asking for the order ID; needs human | order_status | draft_reply | ❌ | order_status | draft_reply (needs human) | ✅ | v1 asked for "the phone number used", a lookup we do not have. v2: see section 4, fixed and re-run. |
| E19 | return_refund | Ticket + draft: eligible; ₹1,648 by UPI/bank after pickup; ₹49 COD fee kept | return_refund | ticket_created + draft_reply | ✅ | return_refund | ticket_created + draft_reply | ✅ | v1 invented a "reply 'Please pick up'" step but its facts were right. |
| E20 | product_query | FAQ safety wording, no cure claim; needs human | product_query | draft_reply | ❌ | product_query | draft_reply (needs human) | ✅ | Neither draft claims a cure; v1 not flagged. |
| E21 | complaint | Updates E04's ticket; replacement after verification; needs human | complaint | ticket_created + draft_reply | ❌ | complaint | ticket_updated + draft_reply (needs human) | ✅ | v1 promised "we'll dispatch the replacement" before anyone checked the photos. |
| E22 | order_status | Order ID not found, nothing invented; needs human | order_status | draft_reply | ❌ | order_status | draft_reply (needs human) | ✅ | v1 asked for a phone number and a payment screenshot. |
| E23 | complaint | Ticket (High) + draft asking for photos; needs human | — | — | — | complaint | ticket_created + draft_reply (needs human) | ✅ | One awkward sentence ("I haven't approved or processed a refund yet"). |
| E24 | order_status | Cancelled (out of stock), ₹828 refund initiated 16 Nov; needs human | order_status | draft_reply | ❌ | order_status | draft_reply (needs human) | ✅ | v1 said the money "was refunded", made up a 27 Nov date and told him to "call us" (no phone number in the FAQ). |
| E25 | other | Log only (thank-you) | — | — | — | other | log_only | ✅ | |

v2 result: **9 tickets** (E04 and E21 share `TKT-1052-E04`, all complaints High) and **13 emails flagged needs-human**, matching the expected totals.

## 3. Summary

| Metric | Prompt v1 | Prompt v2 |
|---|---|---|
| Emails run (*n*) | 12 | 25 |
| Intent accuracy (x / *n*) | 12 / 12 | 25 / 25 |
| Correct action (x / *n*) | 3 / 12 | 25 / 25 |
| Valid JSON on first try (x / *n*) | 0 / 12 | 25 / 25 |
| Emails sent to "needs human" | 0 | 13 |
| Avg. tokens per email (approx, chars/4) | 1,371 | 2,888 |
| Est. cost per email (₹ or $) | TODO | TODO |

- Intent was never the problem: both versions got every intent right. The gap is entirely in what happens after classification.
- v1's JSON was never valid on the first try because the model wrapped it in a code fence; the code validator stripped it every time, so no email failed and no LLM repair call was needed.
- Cost: TODO. The n8n Gateway credits started at $2.00; read the remaining balance on the `Gemini (classifier)` node and divide what was spent by the number of runs (43 workflow executions in total, including the first test runs). The token column is a characters-÷-4 estimate, not API usage.

## 4. What I changed from v1 to v2, and why

These are the design differences between the two versions (`PROMPT_VERSION` in the Config node), with what the runs showed.

- **Change 1 — eligibility and dates moved from the prompt into code.** v1 tells the agent to "follow the return policy". v2 computes days since delivery and the decision in the Policy Engine and gives the agent the decision to word. In v1 the model did the policy maths right for simple returns (E03, E19, E12, E16) but improvised around it: promising a replacement before verification (E21), a refund "started immediately" (E08), a made-up date (E24).
- **Change 2 — a much more specific classifier prompt.** v2 defines each intent, adds tie-breakers, an untrusted-input rule and extra fields (`issue_type`, `product_condition`, `medical_question`, `injection_suspected`) that drive the rules. v1 already classified all 12 correctly, so the gain here is the extra fields and first-try valid JSON (0/12 → 25/25), not accuracy.
- **Change 3 — needs-human from rules, not only confidence.** v1 flags only confidence under 0.75. In practice the classifier reported 0.90–0.98 on every email, so v1 flagged nothing, including the angry customer, the injection attempt and the medical question. This is the single biggest difference: correct actions went from 3/12 to 25/25.
- **Change 4 — output guardrails.** v2 checks every draft for links, amounts and order IDs that are not in the data, for "refund approved" wording, and for leaked order details. In the final v2 run no draft tripped them.
- **Change 5 — stricter agent prompt.** v2 adds the hard rules, the system-facts block and the reply language. The v1 drafts asked for things we cannot use (phone numbers, screenshots) and invented steps; the v2 drafts did not.

Found in the first live run on n8n Cloud (E01, E07, E12), before the v1/v2 runs, and fixed for both versions:

- **Agent model switched from Gemini to OpenAI.** With Gemini 2.5 Flash as the agent's model, E12 failed with `400 Please ensure that the number of function response parts is equal to the number of function call parts`. Gemini called `get_order` and `search_faq` in the same turn, and n8n's agent sent the two tool results back in a form Gemini rejects. E01 had worked only because it needed one tool. A prompt rule ("one tool at a time") would not be reliable, so the agent now uses gpt-5-mini, which handles parallel tool calls; the classifier stays on Gemini. Re-running E12 gave a correct refusal with both tools called.
- **Retry turned off on the audit-log append.** With Retry On Fail on, every email produced three identical audit rows and the node took about 13 seconds; with it off, one row in about 1 second. I could not see the underlying error because n8n keeps only the final attempt. An append is not idempotent, so it should not be retried blindly anyway. The ticket upsert keeps its retry, because it matches on `ticket_id` and a repeat only rewrites the same row.

Found in the v2 run and fixed:

- **E18 was flagged for the wrong reason.** The classifier gave "Where is it??? Been waiting forever." a confidence of 0.95, so the threshold did not fire. It was flagged only because my order-ID guardrail mistook the format example in the draft ("format KC-1234") for an invented order ID. I made the guardrail ignore that example and added a rule: an order-status email with no order for the sender always needs a human. Re-run (last row of the audit log): flagged with "customer is chasing an order but none was found for this sender". The audit log keeps both E18 rows; the report uses the latest.

The privacy check inside `get_order` and ticket de-duplication are the same in both versions; I did not want a version that could leak an order, even as a baseline.

## 5. Failures I could not fix (be honest)

| Email | What goes wrong | Why I think it happens | What I would try next |
|---|---|---|---|
| All | Classifier confidence is not useful: 0.90–0.98 on every email, including a vague one-liner (E18). The 0.75 threshold never triggered. | Models report confidence as text, not as a calibrated probability; the prompt's guidance ("below 0.6 when too vague") was ignored. | Keep relying on rules; derive a confidence from signals (order ID present, lookup result, agreement of two classifier samples) instead of the model's number. |
| E05 | Draft gives the right ETA (23 Nov) but does not say that this is the Monday she is travelling. | The brief tells the agent the email date and weekday, not the weekday of the ETA, and does not ask it to check the customer's own deadline. | Add the ETA's weekday to the system facts and an instruction to address any date the customer mentions. |
| — | The agent cannot use Gemini. | n8n's agent sends parallel tool results to Gemini in a shape Gemini rejects (section 4). Worked around, not fixed. | Re-test on newer n8n versions, or force sequential tool calls if n8n adds that option. |
| — | Root cause of the triple audit rows is unknown. | n8n keeps only the last attempt, so the error from the first two was never visible. | Turn retry on in a copy of the workflow with error output enabled and log the failure. |
| E09, E23 | Small wording issues: a missing space in the Hindi draft, one awkward sentence in E23. | Model output; nothing checks spelling or style. | Leave to the human reviewer; a style check would cost more than it saves at this volume. |

Known limits of the design, independent of any run:

- **How the build was checked.** The rules are covered by `scripts/simulate.js` (21 checks, no LLM). The wiring was first run in a local n8n against a mock model server, then on n8n Cloud with the real models.
- **Dates in drafts are not verified.** The guardrail checks links, amounts and order IDs, but a wrong date written by the model would pass (v1's "27 Nov" in E24 is the kind of thing it would miss).
- **The medical-wording check is a keyword match.** E20's correct disclaimer ("we cannot say it will cure eczema") also matches it; it only adds a note, but it would over-escalate on its own.
- **Photos are not inspected.** An image attachment counts as "photos provided" whatever it shows.
- **Partial returns.** The refundable amount assumes all items come back.
- **Token counts are estimates** (characters ÷ 4), not API usage numbers.
