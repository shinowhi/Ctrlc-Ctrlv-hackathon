# Capability Map: FinRef invoice decision rules

| Module id | Responsibility | Depends on |
|---|---|---|
| intake-u1 | Let applicants submit an invoice PDF with optional form fields, validate completeness after submit, capture buyer-name intent, and return incomplete requests as U1. | — |
| invoice-assessment | Apply OCR confidence, buyer/vendor/TIN matching, duplicate, invoice-kind, sales/VAT, discount, and amount rules; create a CFO review note for a qualifying new vendor. | intake-u1 |
| review-routing | Persist clear rejection, manager review, applicant correction, approval-ready, and CFO states; show agreed colors and manager verification in the CFO view. | intake-u1, invoice-assessment |

Build order: `intake-u1` → `invoice-assessment` → `review-routing`.
