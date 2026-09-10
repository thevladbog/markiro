-- Keep saved shift snapshots and user-authored templates intact. Only the exact
-- previous stock layout is upgraded in place; its id and enabled state survive.
DO $migration$
DECLARE
  previous_spec jsonb := '{
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
}'::jsonb;
  short_spec jsonb := '{
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
      "maxWidthMm": 30,
      "maxLines": 3
    },
    {
      "id": "sep-name",
      "kind": "line",
      "xMm": 2,
      "yMm": 15.3,
      "x2Mm": 32,
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
      "maxWidthMm": 15
    },
    {
      "id": "cap-expiry",
      "kind": "text",
      "xMm": 17.5,
      "yMm": 15.8,
      "text": "Годен до:",
      "fontSizePt": 5,
      "maxWidthMm": 14.5
    },
    {
      "id": "date",
      "kind": "field",
      "xMm": 2,
      "yMm": 18.8,
      "field": "date",
      "fontSizePt": 6,
      "bold": true,
      "maxWidthMm": 15
    },
    {
      "id": "expiry",
      "kind": "field",
      "xMm": 17.5,
      "yMm": 18.8,
      "field": "expiry",
      "fontSizePt": 6,
      "bold": true,
      "maxWidthMm": 14.5
    },
    {
      "id": "sep-dates",
      "kind": "line",
      "xMm": 2,
      "yMm": 22.5,
      "x2Mm": 32,
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
      "maxWidthMm": 30
    },
    {
      "id": "egais",
      "kind": "field",
      "xMm": 2,
      "yMm": 25.9,
      "field": "product.egais",
      "fontSizePt": 6,
      "bold": true,
      "maxWidthMm": 30
    },
    {
      "id": "cap-marking",
      "kind": "text",
      "xMm": 2,
      "yMm": 29.5,
      "text": "Код маркировки:",
      "fontSizePt": 5,
      "maxWidthMm": 30
    },
    {
      "id": "marking",
      "kind": "field",
      "xMm": 2,
      "yMm": 32.5,
      "field": "km.code",
      "textFormat": "km_without_crypto",
      "fontSizePt": 5,
      "maxWidthMm": 30,
      "maxLines": 2
    },
    {
      "id": "sep-code",
      "kind": "line",
      "xMm": 33,
      "yMm": 2,
      "x2Mm": 33,
      "y2Mm": 38,
      "thicknessMm": 0.3
    },
    {
      "id": "km",
      "kind": "barcode",
      "xMm": 34,
      "yMm": 9,
      "format": "datamatrix",
      "data": "km.code",
      "sizeMm": 22
    }
  ]
}'::jsonb;
  full_spec jsonb := '{
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
      "field": "product.name",
      "fontSizePt": 8,
      "bold": true,
      "maxWidthMm": 30,
      "maxLines": 3
    },
    {
      "id": "sep-name",
      "kind": "line",
      "xMm": 2,
      "yMm": 15.3,
      "x2Mm": 32,
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
      "maxWidthMm": 15
    },
    {
      "id": "cap-expiry",
      "kind": "text",
      "xMm": 17.5,
      "yMm": 15.8,
      "text": "Годен до:",
      "fontSizePt": 5,
      "maxWidthMm": 14.5
    },
    {
      "id": "date",
      "kind": "field",
      "xMm": 2,
      "yMm": 18.8,
      "field": "date",
      "fontSizePt": 6,
      "bold": true,
      "maxWidthMm": 15
    },
    {
      "id": "expiry",
      "kind": "field",
      "xMm": 17.5,
      "yMm": 18.8,
      "field": "expiry",
      "fontSizePt": 6,
      "bold": true,
      "maxWidthMm": 14.5
    },
    {
      "id": "sep-dates",
      "kind": "line",
      "xMm": 2,
      "yMm": 22.5,
      "x2Mm": 32,
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
      "maxWidthMm": 30
    },
    {
      "id": "egais",
      "kind": "field",
      "xMm": 2,
      "yMm": 25.9,
      "field": "product.egais",
      "fontSizePt": 6,
      "bold": true,
      "maxWidthMm": 30
    },
    {
      "id": "cap-marking",
      "kind": "text",
      "xMm": 2,
      "yMm": 29.5,
      "text": "Код маркировки:",
      "fontSizePt": 5,
      "maxWidthMm": 30
    },
    {
      "id": "marking",
      "kind": "field",
      "xMm": 2,
      "yMm": 32.5,
      "field": "km.code",
      "textFormat": "km_without_crypto",
      "fontSizePt": 5,
      "maxWidthMm": 30,
      "maxLines": 2
    },
    {
      "id": "sep-code",
      "kind": "line",
      "xMm": 33,
      "yMm": 2,
      "x2Mm": 33,
      "y2Mm": 38,
      "thicknessMm": 0.3
    },
    {
      "id": "km",
      "kind": "barcode",
      "xMm": 34,
      "yMm": 9,
      "format": "datamatrix",
      "data": "km.code",
      "sizeMm": 22
    }
  ]
}'::jsonb;
BEGIN
  UPDATE label_templates AS existing
  SET name = 'Дубликат Data Matrix 58×40 [Краткое наименование]', spec = short_spec, updated_at = now()
  WHERE existing.purpose = 'product_duplicate'
    AND existing.name = 'Дубликат Data Matrix 58×40'
    AND existing.spec = previous_spec
    AND NOT EXISTS (
      SELECT 1 FROM label_templates AS other
      WHERE other.tenant_id = existing.tenant_id
        AND other.purpose = 'product_duplicate'
        AND other.name = 'Дубликат Data Matrix 58×40 [Краткое наименование]'
        AND other.id <> existing.id
    );

  INSERT INTO label_templates (tenant_id, name, purpose, spec, enabled)
  SELECT tenant.id, preset.name, 'product_duplicate', preset.spec, true
  FROM organization AS tenant
  CROSS JOIN (VALUES
    ('Дубликат Data Matrix 58×40 [Полное наименование]', full_spec),
    ('Дубликат Data Matrix 58×40 [Краткое наименование]', short_spec)
  ) AS preset(name, spec)
  WHERE NOT EXISTS (
    SELECT 1 FROM label_templates AS existing
    WHERE existing.tenant_id = tenant.id
      AND existing.purpose = 'product_duplicate'
      AND existing.name = preset.name
  );
END
$migration$;
