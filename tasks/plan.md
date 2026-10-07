# Implementation plan: FinRef payment rules

1. **Applicant intake/U1** — extend buyer selection; make data inputs optional at first submit; keep PDF mandatory; persist incomplete fields and route to NEEDS_INFO; allow resubmission.
2. **Assessment** — align API and database thresholds, buyer intent, vendor/TIN branches, approved duplicate key, sales/VAT arithmetic, confidence flags, selective final-total reread, and new-vendor note creation.
3. **Review routing/UI** — implement yellow manager resolution, automatic rejection for clear contradictions, CFO transition after resolution, CFO vendor notes, and agreed colors/status labels.
4. **Closeout review** — inspect all changed files and diff for consistency. No tests/build are run unless requested.

## Risks and mitigations
- Incomplete submissions require nullable payment amounts while awaiting U1. Never treat a placeholder as a real payable amount; exclude incomplete rows from amount-based CFO/daily calculations.
- Status decisions must be enforced in the server RPC, not only in browser code.
- Use additive migration changes and preserve old audit/PDF data.
- API and SQL thresholds must match exactly.

## Verification checkpoints
- Intake RPC preserves an incomplete request as NEEDS_INFO and transitions complete resubmissions to analysis.
- Assessment returns one consistent classification for every agreed confidence/mismatch case.
- CFO visibility, note access, and manager/CFO transitions are enforced server-side and match the UI.
- Manual code/diff review only; no tests, build or deployment without user request.
