# Spec: Invoice assessment rules

## Objective
Use the agreed confidence thresholds and evidence to assess invoice type, buyer, vendor/TIN, invoice number, and totals. Uncertainty on a decision field goes to manager review; only a clear contradiction can be automatically rejected, except amount/invoice-number mismatches which remain yellow for manager review. Date and amount-due are informational and do not affect status.

When Azure's final-total confidence is below the applicable threshold, attempt a selective reread of only the final-total field. Accept the reread only when it includes evidence, meets the threshold, and agrees with Azure's value; otherwise preserve both reads for manager review.

## Tech stack
Existing Node API (`api/analyze-evidence.js`) and Supabase PostgreSQL RPC/migrations. No dependencies added.

## Commands
- Build: `npm run build`
- Existing tests: `npm test` (not run for this task unless requested)
- Local app: `npm start`

## Project structure
- `api/analyze-evidence.js`: Azure/OpenAI extraction and assessment.
- `invoice-matching.js`: normalized buyer/vendor/invoice comparisons.
- `supabase/schema.sql`, `supabase/migrations/`: final server-side status enforcement.

## Code style
Follow existing CommonJS API helpers, confidence/evidence field shape, and transactional Supabase RPC conventions.

## Testing strategy
Existing assessment and database tests cover confidence, matching, and status behavior. Tests are not added or run in this implementation because the user asked to begin coding, not to test or verify it. Review the final diff and threshold consistency between API and SQL.

## Boundaries
- Always: confidence thresholds are inclusive; use evidence for accepted OCR values; retain existing budget thresholds.
- Ask first: changing budget policy, using date or amount-due as an approval condition, or changing the agreed field thresholds.
- Never: infer VAT=0 from a blank/unreadable value; use OCR uncertainty alone as grounds for automatic rejection.

## Success criteria
- Unknown invoice kind defaults to VAT rules without a classification-only flag.
- If Azure final-total confidence is below threshold, reread just the total. A conflicting or still-weak reread stays yellow; do not pick a result based on the submitted form amount.
- Buyer form values are independent: A is the personal name and B is the business/entity name. Compare each OCR field only with its corresponding form field. Compare normalized name text with character edit similarity on the distinctive name; for B, ignore common legal-form prefixes, including abbreviations such as `CTY TNHH MTV`, so they do not lower similarity. Similarity ≥90% is a match with no flag; >80% and <90% is yellow for manager review; ≤80% is a clear mismatch only when OCR confidence/evidence meet the buyer threshold and a focused reread completed and confirms the mismatch. If reread is unavailable or disagrees, keep it yellow. If OCR clearly reads a name while the corresponding A/B field is blank, return U1 for applicant correction. If both A/B are blank, require explicit confirmation that the invoice has no buyer name; a clearly read buyer name is REJECTED only after a confirming reread; otherwise yellow.
- Vendor rules: known verified TIN ≥85% plus a registered alias name ≥70%; both new name and TIN ≥80%; partial cases go yellow unless a clear contradiction exists. A qualifying new vendor produces a CFO-only review note but is not added to the verified directory automatically.
- An already approved duplicate is the same TIN and invoice number, normalized for comparison. OCR identifiers require confidence ≥80% plus evidence; a manager may instead explicitly verify a low-confidence/missing identifier from the PDF, and that exact value is stored for future duplicate checks. Amount or invoice-number confidence/match issues are yellow; other clear contradictions become REJECTED and remain stored.
- Sales total ≥81%. VAT before-tax, nonzero VAT, and final total ≥90%; VAT=0 requires ≥70% plus PDF evidence explicitly showing zero. Discount, when present, requires ≥85%; when timing is unclear assume pre-tax. If computed total differs from invoice/form amount, send yellow to manager.
- Low/missing informational invoice date and amount-due do not add notes or change status.

## Open questions
None. Threshold inclusivity, discount assumption, VAT zero evidence, and informational-field handling were confirmed by the user.
