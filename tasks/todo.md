# Implementation tasks

- [x] Intake/U1 and buyer-mode contract
  - Acceptance: optional form inputs; PDF required; agreed missing-field list becomes purple U1; no buyer name required only for the explicit no-buyer option.
  - Verify: inspect form payload, RPC transitions, and missing-field rendering.
  - Files: `index.html`, `app.js`, `styles.css`, `supabase/schema.sql`, new migration.
- [x] Invoice assessment rules
  - Acceptance: inclusive confidence thresholds, VAT/discount math, vendor/TIN rules, duplicate check by TIN+number, and confidence-vs-contradiction routing match the approved spec.
  - Verify: inspect API-to-RPC payload and SQL decision conditions.
  - Files: `api/analyze-evidence.js`, `invoice-matching.js`, `supabase/schema.sql`, new migration.
- [x] Review routing and CFO supplier notes
  - Acceptance: colors/statuses, manager review before CFO for uncertain cases, CFO-only vendor note access, clear over-budget CFO route, rejected audit retention.
  - Verify: inspect status transitions, RLS/storage access, and browser rendering.
  - Files: `api.js`, `app.js`, `index.html`, `styles.css`, `supabase/schema.sql`, new migration.
- [x] Final diff review
  - Acceptance: no unrelated changes, no secrets, schema and browser/API behavior agree.
  - Verify: manual review only; tests, build and deployment were not run.
