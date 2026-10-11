# Spec: Applicant intake and U1

## Objective
Allow applicants to submit an invoice PDF even if one or more form fields are blank. Validate missing form data after submission, persist the request as U1/NEEDS_INFO, mark missing fields purple, and allow the applicant to complete and resubmit it. The invoice PDF remains required to submit. Buyer form values are split into A (personal name) and B (business/entity name); both may be blank only when the applicant confirms “Hóa đơn không ghi tên người mua.”

## Tech stack
Existing static HTML/JavaScript frontend, Node API, and Supabase PostgreSQL RPC/migrations. Do not add dependencies.

## Commands
- Build: `npm run build`
- Existing tests: `npm test` (not run for this task unless requested)
- Local app: `npm start`

## Project structure
- `index.html`, `app.js`, `styles.css`: intake form and browser workflow.
- `api.js`: Supabase browser client.
- `supabase/schema.sql`, `supabase/migrations/`: persistence and authorization.

## Code style
Follow the existing plain JavaScript and SQL conventions. Keep browser code in the existing IIFE and send writes through Supabase RPCs.

## Testing strategy
The existing Node test suite covers browser rules and database RPC behavior. Tests are not added or run in this implementation because the user asked to begin coding, not to test or verify it. Review the final diff and schema contract.

## Boundaries
- Always: keep the PDF required; allow blank form fields before submission; use U1/NEEDS_INFO for the agreed missing-field list.
- Ask first: changing which fields U1 requires, storing a missing amount as a meaningful payment value, or changing the PDF upload rule.
- Never: approve an incomplete request or infer the missing buyer name from OCR.

## Success criteria
- The form does not block submission for missing text/select/date/amount fields, but still blocks without a PDF.
- On submit, required missing fields are stored and shown purple; the request returns to the applicant without running invoice assessment.
- Required fields after submit are requester, requester type, department, budget code, purpose, vendor, invoice number, invoice date, and amount. If both buyer-name fields A and B are blank, the no-buyer-name confirmation is required. A/B may otherwise be filled independently.
- During invoice assessment, if OCR clearly reads a personal or organization name whose matching A/B form field is blank, return U1 and mark that matching field purple so the applicant can add it. Uncertain OCR is yellow for manager review.
- Resubmission with missing fields stays in U1; a complete resubmission returns to manager/AI review.

## Open questions
None. The field list and PDF requirement were confirmed by the user.
