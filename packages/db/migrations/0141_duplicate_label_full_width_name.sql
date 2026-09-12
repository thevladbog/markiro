-- The stock duplicate layout gains a full-width product name: the rule now
-- spans the label instead of stopping at the 30 mm text column, and the Data
-- Matrix drops below it rather than being centred against the full height.
--
-- Upgraded IN PLACE, and only where the spec is still byte-identical to what
-- 0125 seeded. A tenant that edited its copy keeps it, ids and enabled state
-- survive, and saved shift snapshots are not touched -- a printed label is a
-- historical fact, not something to recalculate.
DO $migration$
DECLARE
  previous_full jsonb := '{
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
  previous_short jsonb := '{
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
  next_full jsonb := '{
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
      "fontSizePt": 9,
      "bold": true,
      "maxWidthMm": 54,
      "maxLines": 2
    },
    {
      "id": "sep-name",
      "kind": "line",
      "xMm": 2,
      "yMm": 12,
      "x2Mm": 56,
      "y2Mm": 12,
      "thicknessMm": 0.3
    },
    {
      "id": "cap-date",
      "kind": "text",
      "xMm": 2,
      "yMm": 12.6,
      "text": "Дата розлива:",
      "fontSizePt": 5,
      "maxWidthMm": 15
    },
    {
      "id": "cap-expiry",
      "kind": "text",
      "xMm": 17.5,
      "yMm": 12.6,
      "text": "Годен до:",
      "fontSizePt": 5,
      "maxWidthMm": 14.5
    },
    {
      "id": "date",
      "kind": "field",
      "xMm": 2,
      "yMm": 15.5,
      "field": "date",
      "fontSizePt": 6,
      "bold": true,
      "maxWidthMm": 15
    },
    {
      "id": "expiry",
      "kind": "field",
      "xMm": 17.5,
      "yMm": 15.5,
      "field": "expiry",
      "fontSizePt": 6,
      "bold": true,
      "maxWidthMm": 14.5
    },
    {
      "id": "sep-dates",
      "kind": "line",
      "xMm": 2,
      "yMm": 19.2,
      "x2Mm": 32,
      "y2Mm": 19.2,
      "thicknessMm": 0.3
    },
    {
      "id": "cap-egais",
      "kind": "text",
      "xMm": 2,
      "yMm": 19.7,
      "text": "Код ЕГАИС:",
      "fontSizePt": 5,
      "maxWidthMm": 30
    },
    {
      "id": "egais",
      "kind": "field",
      "xMm": 2,
      "yMm": 22.6,
      "field": "product.egais",
      "fontSizePt": 6,
      "bold": true,
      "maxWidthMm": 30
    },
    {
      "id": "cap-marking",
      "kind": "text",
      "xMm": 2,
      "yMm": 26.2,
      "text": "Код маркировки:",
      "fontSizePt": 5,
      "maxWidthMm": 30
    },
    {
      "id": "marking",
      "kind": "field",
      "xMm": 2,
      "yMm": 29.1,
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
      "yMm": 12.3,
      "x2Mm": 33,
      "y2Mm": 38,
      "thicknessMm": 0.3
    },
    {
      "id": "km",
      "kind": "barcode",
      "xMm": 34,
      "yMm": 14.15,
      "format": "datamatrix",
      "data": "km.code",
      "sizeMm": 22
    }
  ]
}'::jsonb;
  next_short jsonb := '{
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
      "fontSizePt": 9,
      "bold": true,
      "maxWidthMm": 54,
      "maxLines": 2
    },
    {
      "id": "sep-name",
      "kind": "line",
      "xMm": 2,
      "yMm": 12,
      "x2Mm": 56,
      "y2Mm": 12,
      "thicknessMm": 0.3
    },
    {
      "id": "cap-date",
      "kind": "text",
      "xMm": 2,
      "yMm": 12.6,
      "text": "Дата розлива:",
      "fontSizePt": 5,
      "maxWidthMm": 15
    },
    {
      "id": "cap-expiry",
      "kind": "text",
      "xMm": 17.5,
      "yMm": 12.6,
      "text": "Годен до:",
      "fontSizePt": 5,
      "maxWidthMm": 14.5
    },
    {
      "id": "date",
      "kind": "field",
      "xMm": 2,
      "yMm": 15.5,
      "field": "date",
      "fontSizePt": 6,
      "bold": true,
      "maxWidthMm": 15
    },
    {
      "id": "expiry",
      "kind": "field",
      "xMm": 17.5,
      "yMm": 15.5,
      "field": "expiry",
      "fontSizePt": 6,
      "bold": true,
      "maxWidthMm": 14.5
    },
    {
      "id": "sep-dates",
      "kind": "line",
      "xMm": 2,
      "yMm": 19.2,
      "x2Mm": 32,
      "y2Mm": 19.2,
      "thicknessMm": 0.3
    },
    {
      "id": "cap-egais",
      "kind": "text",
      "xMm": 2,
      "yMm": 19.7,
      "text": "Код ЕГАИС:",
      "fontSizePt": 5,
      "maxWidthMm": 30
    },
    {
      "id": "egais",
      "kind": "field",
      "xMm": 2,
      "yMm": 22.6,
      "field": "product.egais",
      "fontSizePt": 6,
      "bold": true,
      "maxWidthMm": 30
    },
    {
      "id": "cap-marking",
      "kind": "text",
      "xMm": 2,
      "yMm": 26.2,
      "text": "Код маркировки:",
      "fontSizePt": 5,
      "maxWidthMm": 30
    },
    {
      "id": "marking",
      "kind": "field",
      "xMm": 2,
      "yMm": 29.1,
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
      "yMm": 12.3,
      "x2Mm": 33,
      "y2Mm": 38,
      "thicknessMm": 0.3
    },
    {
      "id": "km",
      "kind": "barcode",
      "xMm": 34,
      "yMm": 14.15,
      "format": "datamatrix",
      "data": "km.code",
      "sizeMm": 22
    }
  ]
}'::jsonb;
BEGIN
  UPDATE label_templates
  SET spec = next_full, updated_at = now()
  WHERE purpose = 'product_duplicate'
    AND name = 'Дубликат Data Matrix 58×40 [Полное наименование]'
    AND spec = previous_full;

  UPDATE label_templates
  SET spec = next_short, updated_at = now()
  WHERE purpose = 'product_duplicate'
    AND name = 'Дубликат Data Matrix 58×40 [Краткое наименование]'
    AND spec = previous_short;
END
$migration$;
