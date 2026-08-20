-- Force-overwrites the spec of every label template carrying one of the five
-- stock seed names, in EVERY tenant — the same mechanism, and the same
-- explicitly chosen trade-off, as migration 0050.
--
-- WHY AGAIN. Two findings from the SECOND physical print of the box label.
--
-- 1. THE SSCC BLOCK READ SKEWED. The barcode was not at fault: 0050 already
--    centres it by arithmetic (`bc-sscc` at xMm 9.5, 156 modules × 0.2502 mm =
--    39.03 mm of bars, margins 9.50 and 9.47 on a 58 mm label). The human-
--    readable digit line UNDER it was — `val-sscc` was a left-flush `field` at
--    the 2 mm content margin, so its digits started 7.5 mm left of the bars
--    they belong to. It now carries `"align":"center"` inside the same
--    full-width content box the barcode is centred in, so the two share a
--    centre line at all five sizes.
--
-- 2. TWO CAPTIONS OVERFLOWED THEIR COLUMN on both 100 mm templates and printed
--    ellipsized: «Дата производства:» and «Кол-во в упаковке:» each measured
--    31.43 mm in a 31.10 mm column. The cause was arithmetic, not wording. A
--    template's boxes scale exactly (`colW = contentWidth / 3`) but its type
--    is rounded to a whole point, and at scale 100/58 a 5 pt caption wants
--    8.62 pt and was rounded UP to 9 — 4.4 % wider than the column, which does
--    not round up with it. (At 75 mm the same rounding went down, 6.47 → 6,
--    which is why only the 100 mm sizes were affected.) `defaults.ts` now
--    derives each size from the FIT rather than trusting proportional scaling:
--    the largest whole point size that is both no bigger than the proportional
--    size and actually fits its box under `estimatedTextWidthMm`. Only the two
--    100 mm templates change — their caption row and SSCC digit line go from
--    9 pt to 8 pt (27.94 mm in the 31.10 mm column), and the y-cursors below
--    that row shift with the smaller line box. The 58×40 and 75×120 specs are
--    byte-identical to 0050's.
--
-- The other correction from the same print — the quantity printing as a bare
-- `5` where the approved mock-up reads «5 шт.» — is RUNTIME DISPLAY
-- FORMATTING (`labelFieldDisplayValue` in @markiro/domain's `labels/model.ts`),
-- not template data, so it needs no migration and reaches existing rows for
-- free.
--
-- THIS DISCARDS MANUAL EDITS made to any template with one of these names, in
-- any tenant — the product owner's standing, explicitly chosen behaviour for
-- the stock templates, unchanged from 0050. A name match is treated as "this
-- is the stock template", which is the same idempotency key 0049 used to
-- decide not to seed a duplicate.
--
-- The JSON below is GENERATED, never hand-edited — see the plan's Task 4
-- Step 2 recipe. `packages/domain/test/labels-defaults.test.ts` parses THIS
-- file and deep-compares it against `buildDefaultLabelTemplates()`, so the two
-- cannot drift; 0049's and 0050's own inlined JSON is historical (it is what
-- already-migrated databases received) and is deliberately NOT kept in step.
UPDATE label_templates AS lt
SET spec = t.spec::jsonb,
    updated_at = now()
FROM (VALUES
  ('Коробка 58×40 (203 dpi)', '{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[{"kind":"field","id":"name","xMm":2,"yMm":2,"field":"product.name","fontSizePt":10,"bold":true,"maxWidthMm":54,"maxLines":3},{"kind":"line","id":"sep1","xMm":2,"yMm":18.2,"x2Mm":56,"y2Mm":18.2,"thicknessMm":0.3},{"kind":"text","id":"cap-date","xMm":2,"yMm":18.8,"text":"Дата производства:","fontSizePt":5,"maxWidthMm":18},{"kind":"text","id":"cap-expiry","xMm":20,"yMm":18.8,"text":"Годен до:","fontSizePt":5,"maxWidthMm":18},{"kind":"text","id":"cap-qty","xMm":38,"yMm":18.8,"text":"Кол-во в упаковке:","fontSizePt":5,"maxWidthMm":18},{"kind":"field","id":"val-date","xMm":2,"yMm":21.6,"field":"date","fontSizePt":8,"bold":true,"maxWidthMm":18},{"kind":"field","id":"val-expiry","xMm":20,"yMm":21.6,"field":"expiry","fontSizePt":8,"bold":true,"maxWidthMm":18},{"kind":"field","id":"val-qty","xMm":38,"yMm":21.6,"field":"qty","fontSizePt":8,"bold":true,"maxWidthMm":18},{"kind":"line","id":"sep2","xMm":2,"yMm":26.2,"x2Mm":56,"y2Mm":26.2,"thicknessMm":0.3},{"kind":"text","id":"cap-egais","xMm":2,"yMm":26.8,"text":"Код ЕГАИС:","fontSizePt":5,"maxWidthMm":18},{"kind":"field","id":"val-egais","xMm":20,"yMm":26.8,"field":"product.egais","fontSizePt":8,"bold":true,"maxWidthMm":36},{"kind":"line","id":"sep3","xMm":2,"yMm":31.4,"x2Mm":56,"y2Mm":31.4,"thicknessMm":0.3},{"kind":"barcode","id":"bc-sscc","xMm":9.5,"yMm":32,"format":"code128","data":"sscc","sizeMm":4.8,"moduleWidthMm":0.2502},{"kind":"field","id":"val-sscc","xMm":2,"yMm":37,"field":"sscc","fontSizePt":5,"align":"center","maxWidthMm":54}]}'),
  ('Коробка 58×40 (300 dpi)', '{"widthMm":58,"heightMm":40,"dpi":300,"language":"zpl","elements":[{"kind":"field","id":"name","xMm":2,"yMm":2,"field":"product.name","fontSizePt":10,"bold":true,"maxWidthMm":54,"maxLines":3},{"kind":"line","id":"sep1","xMm":2,"yMm":18.2,"x2Mm":56,"y2Mm":18.2,"thicknessMm":0.3},{"kind":"text","id":"cap-date","xMm":2,"yMm":18.8,"text":"Дата производства:","fontSizePt":5,"maxWidthMm":18},{"kind":"text","id":"cap-expiry","xMm":20,"yMm":18.8,"text":"Годен до:","fontSizePt":5,"maxWidthMm":18},{"kind":"text","id":"cap-qty","xMm":38,"yMm":18.8,"text":"Кол-во в упаковке:","fontSizePt":5,"maxWidthMm":18},{"kind":"field","id":"val-date","xMm":2,"yMm":21.6,"field":"date","fontSizePt":8,"bold":true,"maxWidthMm":18},{"kind":"field","id":"val-expiry","xMm":20,"yMm":21.6,"field":"expiry","fontSizePt":8,"bold":true,"maxWidthMm":18},{"kind":"field","id":"val-qty","xMm":38,"yMm":21.6,"field":"qty","fontSizePt":8,"bold":true,"maxWidthMm":18},{"kind":"line","id":"sep2","xMm":2,"yMm":26.2,"x2Mm":56,"y2Mm":26.2,"thicknessMm":0.3},{"kind":"text","id":"cap-egais","xMm":2,"yMm":26.8,"text":"Код ЕГАИС:","fontSizePt":5,"maxWidthMm":18},{"kind":"field","id":"val-egais","xMm":20,"yMm":26.8,"field":"product.egais","fontSizePt":8,"bold":true,"maxWidthMm":36},{"kind":"line","id":"sep3","xMm":2,"yMm":31.4,"x2Mm":56,"y2Mm":31.4,"thicknessMm":0.3},{"kind":"barcode","id":"bc-sscc","xMm":9.2,"yMm":32,"format":"code128","data":"sscc","sizeMm":4.8,"moduleWidthMm":0.254},{"kind":"field","id":"val-sscc","xMm":2,"yMm":37,"field":"sscc","fontSizePt":5,"align":"center","maxWidthMm":54}]}'),
  ('Коробка 75×120 (203 dpi)', '{"widthMm":75,"heightMm":120,"dpi":203,"language":"zpl","elements":[{"kind":"field","id":"name","xMm":2.6,"yMm":2.6,"field":"product.name","fontSizePt":13,"bold":true,"maxWidthMm":69.8,"maxLines":3},{"kind":"line","id":"sep1","xMm":2.6,"yMm":23.7,"x2Mm":72.4,"y2Mm":23.7,"thicknessMm":0.4},{"kind":"text","id":"cap-date","xMm":2.6,"yMm":24.5,"text":"Дата производства:","fontSizePt":6,"maxWidthMm":23.3},{"kind":"text","id":"cap-expiry","xMm":25.9,"yMm":24.5,"text":"Годен до:","fontSizePt":6,"maxWidthMm":23.3},{"kind":"text","id":"cap-qty","xMm":49.2,"yMm":24.5,"text":"Кол-во в упаковке:","fontSizePt":6,"maxWidthMm":23.3},{"kind":"field","id":"val-date","xMm":2.6,"yMm":27.9,"field":"date","fontSizePt":10,"bold":true,"maxWidthMm":23.3},{"kind":"field","id":"val-expiry","xMm":25.9,"yMm":27.9,"field":"expiry","fontSizePt":10,"bold":true,"maxWidthMm":23.3},{"kind":"field","id":"val-qty","xMm":49.2,"yMm":27.9,"field":"qty","fontSizePt":10,"bold":true,"maxWidthMm":23.3},{"kind":"line","id":"sep2","xMm":2.6,"yMm":33.6,"x2Mm":72.4,"y2Mm":33.6,"thicknessMm":0.4},{"kind":"text","id":"cap-egais","xMm":2.6,"yMm":34.4,"text":"Код ЕГАИС:","fontSizePt":6,"maxWidthMm":23.3},{"kind":"field","id":"val-egais","xMm":25.9,"yMm":34.4,"field":"product.egais","fontSizePt":10,"bold":true,"maxWidthMm":46.5},{"kind":"line","id":"sep3","xMm":2.6,"yMm":40.1,"x2Mm":72.4,"y2Mm":40.1,"thicknessMm":0.4},{"kind":"barcode","id":"bc-sscc","xMm":8.2,"yMm":40.9,"format":"code128","data":"sscc","sizeMm":6.9,"moduleWidthMm":0.3754},{"kind":"field","id":"val-sscc","xMm":2.6,"yMm":48.1,"field":"sscc","fontSizePt":6,"align":"center","maxWidthMm":69.8}]}'),
  ('Коробка 100×100 (203 dpi)', '{"widthMm":100,"heightMm":100,"dpi":203,"language":"zpl","elements":[{"kind":"field","id":"name","xMm":3.4,"yMm":3.4,"field":"product.name","fontSizePt":17,"bold":true,"maxWidthMm":93.2,"maxLines":3},{"kind":"line","id":"sep1","xMm":3.4,"yMm":31,"x2Mm":96.6,"y2Mm":31,"thicknessMm":0.5},{"kind":"text","id":"cap-date","xMm":3.4,"yMm":32.1,"text":"Дата производства:","fontSizePt":8,"maxWidthMm":31.1},{"kind":"text","id":"cap-expiry","xMm":34.5,"yMm":32.1,"text":"Годен до:","fontSizePt":8,"maxWidthMm":31.1},{"kind":"text","id":"cap-qty","xMm":65.6,"yMm":32.1,"text":"Кол-во в упаковке:","fontSizePt":8,"maxWidthMm":31.1},{"kind":"field","id":"val-date","xMm":3.4,"yMm":36.6,"field":"date","fontSizePt":14,"bold":true,"maxWidthMm":31.1},{"kind":"field","id":"val-expiry","xMm":34.5,"yMm":36.6,"field":"expiry","fontSizePt":14,"bold":true,"maxWidthMm":31.1},{"kind":"field","id":"val-qty","xMm":65.6,"yMm":36.6,"field":"qty","fontSizePt":14,"bold":true,"maxWidthMm":31.1},{"kind":"line","id":"sep2","xMm":3.4,"yMm":44.6,"x2Mm":96.6,"y2Mm":44.6,"thicknessMm":0.5},{"kind":"text","id":"cap-egais","xMm":3.4,"yMm":45.7,"text":"Код ЕГАИС:","fontSizePt":8,"maxWidthMm":31.1},{"kind":"field","id":"val-egais","xMm":34.5,"yMm":45.7,"field":"product.egais","fontSizePt":14,"bold":true,"maxWidthMm":62.1},{"kind":"line","id":"sep3","xMm":3.4,"yMm":53.7,"x2Mm":96.6,"y2Mm":53.7,"thicknessMm":0.5},{"kind":"barcode","id":"bc-sscc","xMm":11,"yMm":54.8,"format":"code128","data":"sscc","sizeMm":9,"moduleWidthMm":0.5005},{"kind":"field","id":"val-sscc","xMm":3.4,"yMm":64.2,"field":"sscc","fontSizePt":8,"align":"center","maxWidthMm":93.2}]}'),
  ('Коробка 100×150 (203 dpi)', '{"widthMm":100,"heightMm":150,"dpi":203,"language":"zpl","elements":[{"kind":"field","id":"name","xMm":3.4,"yMm":3.4,"field":"product.name","fontSizePt":17,"bold":true,"maxWidthMm":93.2,"maxLines":3},{"kind":"line","id":"sep1","xMm":3.4,"yMm":31,"x2Mm":96.6,"y2Mm":31,"thicknessMm":0.5},{"kind":"text","id":"cap-date","xMm":3.4,"yMm":32.1,"text":"Дата производства:","fontSizePt":8,"maxWidthMm":31.1},{"kind":"text","id":"cap-expiry","xMm":34.5,"yMm":32.1,"text":"Годен до:","fontSizePt":8,"maxWidthMm":31.1},{"kind":"text","id":"cap-qty","xMm":65.6,"yMm":32.1,"text":"Кол-во в упаковке:","fontSizePt":8,"maxWidthMm":31.1},{"kind":"field","id":"val-date","xMm":3.4,"yMm":36.6,"field":"date","fontSizePt":14,"bold":true,"maxWidthMm":31.1},{"kind":"field","id":"val-expiry","xMm":34.5,"yMm":36.6,"field":"expiry","fontSizePt":14,"bold":true,"maxWidthMm":31.1},{"kind":"field","id":"val-qty","xMm":65.6,"yMm":36.6,"field":"qty","fontSizePt":14,"bold":true,"maxWidthMm":31.1},{"kind":"line","id":"sep2","xMm":3.4,"yMm":44.6,"x2Mm":96.6,"y2Mm":44.6,"thicknessMm":0.5},{"kind":"text","id":"cap-egais","xMm":3.4,"yMm":45.7,"text":"Код ЕГАИС:","fontSizePt":8,"maxWidthMm":31.1},{"kind":"field","id":"val-egais","xMm":34.5,"yMm":45.7,"field":"product.egais","fontSizePt":14,"bold":true,"maxWidthMm":62.1},{"kind":"line","id":"sep3","xMm":3.4,"yMm":53.7,"x2Mm":96.6,"y2Mm":53.7,"thicknessMm":0.5},{"kind":"barcode","id":"bc-sscc","xMm":11,"yMm":54.8,"format":"code128","data":"sscc","sizeMm":9,"moduleWidthMm":0.5005},{"kind":"field","id":"val-sscc","xMm":3.4,"yMm":64.2,"field":"sscc","fontSizePt":8,"align":"center","maxWidthMm":93.2}]}')
) AS t(name, spec)
WHERE lt.name = t.name;
