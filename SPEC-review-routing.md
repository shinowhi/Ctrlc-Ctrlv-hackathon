# Spec: Review routing and status display

## Objective
Route U1, low-confidence review, clear AI contradictions, clear invoices, and over-budget invoices to the appropriate existing applicant, treasurer, and CFO roles. Preserve audit history and show manager-cleared values to CFO without unresolved yellow flags.

## Tech stack
Existing static HTML/JavaScript frontend, Node API, Supabase RPCs, RLS, and PostgreSQL migrations.

## Commands
- Build: `npm run build`
- Existing tests: `npm test` (not run for this task unless requested)
- Local app: `npm start`

## Project structure
- `app.js`, `styles.css`, `index.html`: queue, detail, and colors.
- `api.js`: RPC and signed-file calls.
- `supabase/schema.sql`, `supabase/migrations/`: status transitions, CFO notes, RLS, and audit.

## Code style
Follow existing role/status maps, audit-triggered RPC transitions, escaped HTML rendering, and migration style.

## Testing strategy
Existing browser and PGlite-backed tests cover queue transitions and policies. Tests are not added or run in this implementation because the user asked to begin coding, not to test or verify it. Review the final diff and status-policy parity.

## Boundaries
- Always: keep existing per-invoice 20,000,000 VND and daily 100,000,000 VND limits; map the existing `treasurer` role to manager.
- Ask first: changing budgets, sending unresolved yellow cases to CFO, or exposing CFO-only supplier notes to applicants/treasurers.
- Never: delete rejected requests or allow browser clients to assign status/role directly.

## Success criteria
- U1/missing applicant fields: purple, NEEDS_INFO, returned to applicant.
- Low-confidence decision fields and amount/invoice-number mismatches: yellow, TREASURER_REVIEW.
- Only clear contradictions automatically become red/REJECTED; preserve PDF and audit event.
- AI-clear requests display green. Clear over-budget requests go to CFO; workflow badge is blue while waiting.
- A manager resolves yellow cases first. Manager-confirmed values are shown to CFO without unresolved yellow warnings. A manager-cleared over-budget case proceeds to CFO.
- A qualifying new-vendor note is stored in a CFO-only section with vendor name, TIN, and invoice PDF access. CFO can mark a note reviewed; it leaves the pending list and no longer grants access to the request PDF through the note.

## Open questions
None. Colors, roles, manager-before-CFO behavior, note visibility, and current budget limits were confirmed by the user.
