# Invoice print variants

Issuing or regenerating an invoice creates a new revision containing clean HTML
and PDF files. For the supplier whose tax ID matches
`SIGNED_PRINT_SELLER_TAX_ID`, that same revision also contains signed and sealed
HTML and PDF files. The signature and seal must never be applied to another
supplier. The legacy `printVariant` request field remains accepted; it no longer
limits generation to one variant. Explicitly requesting a signed form for an
unauthorized supplier is still rejected.

Each variant has its own document ID, status, checksum and object key. Downloads
include the revision and variant in the PDF filename. A failed file does not hide
the other ready files. The SaaS invoice detail lists every file in each revision.

Ready historical files retain their stored bytes and object keys. To obtain the
corrected logo and print layout for an existing invoice, generate a new revision;
previous ready revisions remain available.

## Rollout and verification

Migration `0196_invoice_document_variants` changes document uniqueness from
invoice/revision/format to invoice/revision/format/variant. Apply it together with
the API update using the normal protected deployment workflow. An older API
binary uses the former conflict target and cannot generate invoice files after
this migration; rolling back only the binary does not restore compatibility.
Do not restore the old constraint after two variants have been stored.

The full logo is a bundled PNG, so PDF generation does not depend on a host font
to render the product name. Printed HTML has one fixed header and footer, with a
transparent page container so continuation-page backgrounds cannot cover them.
The barcode caption is black regular-weight text.

For print acceptance, check both variants and a multipage invoice in Chromium's
print preview, then print a sample on the intended printer. Automated rendering
and PDF inspection do not establish physical printer acceptance.
