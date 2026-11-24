# Test Report — Kesar & Co. Support Copilot

> **Status: the v1 and v2 columns below are empty until the workflow has been run with a real LLM.**
> Fill them with `node scripts/report_from_csv.js audit_export.csv` (see README section 3), then read every reply draft and overrule any tick where the draft itself is wrong.

**Candidate name:** TODO
**Platform used:** n8n (TODO: Cloud / self-hosted, version)
**LLM(s) used:** Google Gemini 2.5 Flash for classification (temperature 0); OpenAI gpt-5-mini for the drafting agent (reasoning effort low). Both through n8n Cloud gateway credits.

---

## 1. How I decided what "correct" means

Before running anything I wrote the expected classification for every email in [`tests/expected_classifications.json`](./tests/expected_classifications.json), using only `data/faq.md` and `data/orders.json`. The expected action follows from those by the rules in the Policy Engine; [`tests/expected_outcomes.json`](./tests/expected_outcomes.json) is generated from them.

An email counts as correct only if the intent matches **and** the action matches: ticket created/updated or not, needs-human or not, and the eligibility decision.

Judgment calls:
- A damaged, leaking, wrong or missing item is a **complaint** even when the customer asks for a refund (E08, E23); `return_refund` is then the secondary intent.
- "Didn't suit my skin" and "saw no results" are **return_refund**, refused under the opened-product rule (E12, E16), and still ticketed.
- Every complaint and every refusal needs a human; a clean, eligible return does not, because pickup and quality check are human steps anyway.
- E13 (GST invoice) is `other` but still needs a person, since the FAQ does not cover invoices. E17 (collaboration) is `other`, logged with a forward-to-partnerships note.
- E18 has no order ID and no matching order; the right reply asks for the order ID.

## 2. Results per email

| Email | Expected intent | Expected action | v1 intent | v1 action | v1 ✅/❌ | v2 intent | v2 action | v2 ✅/❌ | Notes |
|---|---|---|---|---|---|---|---|---|---|
| E01 | order_status | Draft reply: shipped, SwiftShip link, ETA 21 Nov | | | | | | | |
| E02 | product_query | Draft reply from FAQ: suits oily skin, vegan | | | | | | | |
| E03 | return_refund | Ticket + draft: eligible (4 days, sealed); ₹899 refundable, ₹79 shipping not | | | | | | | |
| E04 | complaint | Ticket (High) + draft asking for photos; needs human | | | | | | | |
| E05 | order_status | Draft reply in Hinglish: shipped, ETA 23 Nov, no earlier promise | | | | | | | |
| E06 | other | Log only (spam) | | | | | | | |
| E07 | order_status | Draft declining to share details (sender is not the customer); needs human | | | | | | | |
| E08 | complaint | Ticket (High) + calm draft asking for photos, no refund promised; needs human | | | | | | | |
| E09 | product_query | Draft reply in Hindi from FAQ: 6–8 business days, COD available (order under ₹5,000, ₹49 fee) | | | | | | | |
| E10 | order_status | Order KC-1044 found by sender email; draft reply: shipped, ETA 25 Nov | | | | | | | |
| E11 | return_refund | Ticket + draft: eligible (5 days, sealed, complete kit); ₹3,499 | | | | | | | |
| E12 | return_refund | Ticket (High) + draft refusing (used, 8 days); embedded instructions ignored; needs human | | | | | | | |
| E13 | other | Log only, no draft; needs human (invoice request, not in FAQ) | | | | | | | |
| E14 | complaint | Ticket (High) + draft asking for photos, wrong-item policy; needs human | | | | | | | |
| E15 | order_status | Draft reply: out for delivery today, ₹1,897 payable in cash | | | | | | | |
| E16 | return_refund | Ticket + draft refusing (used, 15 days); needs human | | | | | | | |
| E17 | other | Log only (forward to partnerships address) | | | | | | | |
| E18 | order_status | Draft asking for the order ID; needs human (low confidence) | | | | | | | |
| E19 | return_refund | Ticket + draft: eligible (3 days, sealed); ₹1,648 by UPI/bank after pickup, ₹49 COD fee not refundable | | | | | | | |
| E20 | product_query | Draft with FAQ safety wording only, no cure claim; needs human | | | | | | | |
| E21 | complaint | **Updates** E04's ticket (no new ticket); draft: photos received, replacement after verification; needs human | | | | | | | |
| E22 | order_status | Draft: order ID not found, nothing invented; needs human | | | | | | | |
| E23 | complaint | Ticket (High) + draft asking for photos, missing-item policy; needs human | | | | | | | |
| E24 | order_status | Draft: order was cancelled (out of stock), refund of ₹828 initiated 16 Nov; needs human | | | | | | | |
| E25 | other | Log only (thank-you) | | | | | | | |

Expected totals for a perfect v2 run: **9 tickets** (10 ticketed emails, E04 and E21 sharing one) and **13 emails flagged needs-human**.

## 3. Summary

| Metric | Prompt v1 | Prompt v2 |
|---|---|---|
| Emails run (*n*) | TODO | 25 |
| Intent accuracy (x / *n*) | TODO | TODO |
| Correct action (x / *n*) | TODO | TODO |
| Valid JSON on first try (x / *n*) | TODO | TODO |
| Emails sent to "needs human" | TODO | TODO |
| Avg. tokens per email (approx, chars/4) | TODO | TODO |
| Est. cost per email (₹ or $) | TODO | TODO |

Suggested v1 subset (the emails where v1 and v2 should differ most): E01, E03, E07, E08, E12, E16, E18, E19, E20, E21, E22, E24.

## 4. What I changed from v1 to v2, and why

These are the design differences between the two versions in this repo (`PROMPT_VERSION` in the Config node). TODO: after running both, add what the results showed for each change.

- **Change 1 — eligibility and dates moved from the prompt into code.** v1 tells the agent to "follow the return policy" and leaves the 7-day and 48-hour maths to the model. v2 computes days since delivery and the decision in the Policy Engine and gives the agent the decision to word.
- **Change 2 — a much more specific classifier prompt.** v1 lists the fields in a few lines. v2 defines each intent, adds tie-breakers (defect + refund = complaint), confidence calibration, an explicit untrusted-input rule, and extra fields (`issue_type`, `product_condition`, `medical_question`, `injection_suspected`) that drive the rules.
- **Change 3 — needs-human from rules, not only confidence.** v1 flags only when confidence is under 0.75. v2 adds the rule-based reasons listed in README section 5.
- **Change 4 — output guardrails.** v2 checks every draft for links, amounts and order IDs that are not in the data, for "refund approved" wording, and for leaked order details. v1 logs the draft as written.
- **Change 5 — stricter agent prompt.** v2 adds the hard rules, the system-facts block, the reply language and the `[NEEDS_HUMAN]` escape hatch.

Found in the first live run on n8n Cloud (E01, E07, E12), before the v1/v2 runs, and fixed for both versions:

- **Agent model switched from Gemini to OpenAI.** With Gemini 2.5 Flash as the agent's model, E12 failed with `400 Please ensure that the number of function response parts is equal to the number of function call parts`. Gemini called `get_order` and `search_faq` in the same turn, and n8n's agent sent the two tool results back in a form Gemini rejects. E01 had worked only because it needed one tool. A prompt rule ("one tool at a time") would not be reliable, so the agent now uses gpt-5-mini, which handles parallel tool calls; the classifier stays on Gemini. Re-running E12 gave a correct refusal with both tools called.
- **Retry turned off on the audit-log append.** With Retry On Fail on, every email produced three identical audit rows and the node took about 13 seconds; with it off, one row in about 1 second. I could not see the underlying error because n8n keeps only the final attempt. An append is not idempotent, so it should not be retried blindly anyway. The ticket upsert keeps its retry, because it matches on `ticket_id` and a repeat only rewrites the same row.

The privacy check inside `get_order` and ticket de-duplication are the same in both versions; I did not want a version that could leak an order, even as a baseline.

## 5. Failures I could not fix (be honest)

TODO: fill this from your real run. One row per email that is still wrong in v2.

| Email | What goes wrong | Why I think it happens | What I would try next |
|---|---|---|---|
| | | | |

Known limits of the design, independent of any run:

- **How the build was checked.** The rules are covered by `scripts/simulate.js` (20 checks, no LLM). The wiring was first run in a local n8n against a mock model server, then on n8n Cloud with the real models. Classification accuracy and draft quality are only known from the runs recorded above.
- **Dates in drafts are not verified.** The guardrail checks links, amounts and order IDs, but a wrong date written by the model would pass.
- **The medical-wording check is a keyword match.** It flags correct disclaimers too ("not intended to treat"), so it over-escalates.
- **Photos are not inspected.** An image attachment counts as "photos provided" whatever it shows.
- **Partial returns.** The refundable amount assumes all items come back.
- **Token counts are estimates** (characters ÷ 4), not API usage numbers.
