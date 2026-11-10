# Example Co Invoice System (locked design)

the owner's a client invoices MUST always look identical to `invoice-sample-GN-2026-08.pdf`
(compact navy-header design: badge shield logo top-left, Issue/Due/Billing dates
top-right, boxed From/Bill-To cards, dark navy table header, shaded totals box,
bordered timesheet-breakdown + payment cards, single page).

## Generate a new invoice

```
python3 scripts/gen-invoice.py \
  --no GN-2026-09 --issue "23 July 2026" --due "25 July 2026" \
  --period "18 Jul - 22 Jul 2026" --breakdown-title "18 to 22 July 2026" \
  --desc "Software engineering consulting. Billing period 18 - 22 July 2026." \
  --rate 210 \
  --row "18 - 19 Jul|Work summary|12.34" \
  --row "21 - 22 Jul|Work summary|9.10"
```

Outputs `/tmp/Example Co_Invoice_<no>.pdf`. Total hours + amount are computed from
the row hours automatically, so line item / subtotal / total / breakdown always
reconcile - never hand-type them.

## Rules (do not break)
- Grouped DATE RANGES in the breakdown, never per-day rows.
- No "reconciliation" / credit line on the invoice face.
- Each invoice bills (timesheet total so far - already invoiced) so cumulative
  billed always equals tracked timesheet hours. Invoice 1 (GN-2026-07) = 56.47h.
- Undercharge is fine; never overcharge a day >15 min vs raw sessions.
- Rate default R210/hr. From/Bill-To/banking are fixed in invoice-template.html.

Files:
- `invoice-template.html`  - the locked layout with {{PLACEHOLDERS}}
- `../scripts/gen-invoice.py` - fills it + renders PDF
- `invoice-sample-GN-2026-08.pdf/.html` - the gold-standard reference output
