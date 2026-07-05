# webhooks-tab-regression — a DETECTION test (FAILs by design)

expected.json says the "webhooks tab is visible on settings" check comes back
`ok: true` (the known-good outcome), but recorded-result.json is a replay where
step 1 (`expectVisible [data-testid=webhooks-tab]`) failed — the tab regressed
away. The derived check is therefore `ok: false`, mismatching expected, and the
bench flags this case **FAIL**.

That FAIL is intentional: it demonstrates the bench detects a regressed replay
instead of rubber-stamping it. If this case ever shows PASS, the bench's
derivation or diffing is broken (JSON can't carry comments, hence this file).
