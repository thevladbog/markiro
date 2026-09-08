-- Update only the untouched built-in duplicate layout. Custom names/specs,
-- disabled state, box templates and immutable shift/job snapshots are preserved.
UPDATE "label_templates"
SET "spec" = '{
  "widthMm": 58,
  "heightMm": 40,
  "dpi": 203,
  "language": "zpl",
  "elements": [
    {
      "id": "product",
      "kind": "field",
      "xMm": 2,
      "yMm": 2,
      "field": "product.printName",
      "fontSizePt": 8,
      "bold": true,
      "maxWidthMm": 28,
      "maxLines": 3
    },
    {
      "id": "sep-name",
      "kind": "line",
      "xMm": 2,
      "yMm": 15.3,
      "x2Mm": 30,
      "y2Mm": 15.3,
      "thicknessMm": 0.3
    },
    {
      "id": "cap-date",
      "kind": "text",
      "xMm": 2,
      "yMm": 15.8,
      "text": "Дата розлива:",
      "fontSizePt": 5,
      "maxWidthMm": 14
    },
    {
      "id": "cap-expiry",
      "kind": "text",
      "xMm": 16.5,
      "yMm": 15.8,
      "text": "Годен до:",
      "fontSizePt": 5,
      "maxWidthMm": 13.5
    },
    {
      "id": "date",
      "kind": "field",
      "xMm": 2,
      "yMm": 18.8,
      "field": "date",
      "fontSizePt": 6,
      "bold": true,
      "maxWidthMm": 14
    },
    {
      "id": "expiry",
      "kind": "field",
      "xMm": 16.5,
      "yMm": 18.8,
      "field": "expiry",
      "fontSizePt": 6,
      "bold": true,
      "maxWidthMm": 13.5
    },
    {
      "id": "sep-dates",
      "kind": "line",
      "xMm": 2,
      "yMm": 22.5,
      "x2Mm": 30,
      "y2Mm": 22.5,
      "thicknessMm": 0.3
    },
    {
      "id": "cap-egais",
      "kind": "text",
      "xMm": 2,
      "yMm": 23,
      "text": "Код ЕГАИС:",
      "fontSizePt": 5,
      "maxWidthMm": 28
    },
    {
      "id": "egais",
      "kind": "field",
      "xMm": 2,
      "yMm": 25.9,
      "field": "product.egais",
      "fontSizePt": 6,
      "bold": true,
      "maxWidthMm": 28
    },
    {
      "id": "cap-marking",
      "kind": "text",
      "xMm": 2,
      "yMm": 29.5,
      "text": "Код маркировки:",
      "fontSizePt": 5,
      "maxWidthMm": 28
    },
    {
      "id": "marking",
      "kind": "field",
      "xMm": 2,
      "yMm": 32.5,
      "field": "km.code",
      "textFormat": "km_without_crypto",
      "fontSizePt": 5,
      "maxWidthMm": 28,
      "maxLines": 2
    },
    {
      "id": "sep-code",
      "kind": "line",
      "xMm": 31,
      "yMm": 2,
      "x2Mm": 31,
      "y2Mm": 38,
      "thicknessMm": 0.3
    },
    {
      "id": "km",
      "kind": "barcode",
      "xMm": 32,
      "yMm": 8,
      "format": "datamatrix",
      "data": "km.code",
      "sizeMm": 24
    }
  ]
}'::jsonb,
    "updated_at" = now()
WHERE "purpose" = 'product_duplicate'
  AND "name" = 'Дубликат Data Matrix 58×40 (203 dpi)'
  AND "spec" = '{
  "widthMm": 58,
  "heightMm": 40,
  "dpi": 203,
  "language": "zpl",
  "elements": [
    {
      "id": "km",
      "kind": "barcode",
      "xMm": 3,
      "yMm": 3,
      "format": "datamatrix",
      "data": "km.code",
      "sizeMm": 24
    },
    {
      "id": "caption",
      "kind": "text",
      "xMm": 30,
      "yMm": 4,
      "text": "DATA MATRIX",
      "fontSizePt": 8,
      "bold": true,
      "maxWidthMm": 25
    },
    {
      "id": "gtin",
      "kind": "field",
      "xMm": 30,
      "yMm": 10,
      "field": "product.gtin",
      "fontSizePt": 7,
      "maxWidthMm": 25
    },
    {
      "id": "date",
      "kind": "field",
      "xMm": 30,
      "yMm": 16,
      "field": "date",
      "fontSizePt": 8,
      "maxWidthMm": 25
    },
    {
      "id": "product",
      "kind": "field",
      "xMm": 3,
      "yMm": 30,
      "field": "product.printName",
      "fontSizePt": 9,
      "maxWidthMm": 52,
      "maxLines": 2
    }
  ]
}'::jsonb;
