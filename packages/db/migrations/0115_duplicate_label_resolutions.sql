-- Add missing stock presets for both printer resolutions. Keep custom/disabled
-- templates and box defaults; existing shift/job snapshots are never rewritten.
INSERT INTO "label_templates" ("id", "tenant_id", "name", "purpose", "spec", "enabled")
SELECT gen_random_uuid(), org.id, preset.name, 'product_duplicate', preset.spec, true
FROM "organization" org
CROSS JOIN (VALUES
('Дубликат Data Matrix 58×40 (203 dpi)', '{
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
}'::jsonb),
('Дубликат Data Matrix 58×40 (300 dpi)', '{
  "widthMm": 58,
  "heightMm": 40,
  "dpi": 300,
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
}'::jsonb)
) AS preset(name, spec)
WHERE NOT EXISTS (
  SELECT 1 FROM "label_templates" existing
  WHERE existing.tenant_id = org.id
    AND existing.purpose = 'product_duplicate'
    AND existing.name = preset.name
);
