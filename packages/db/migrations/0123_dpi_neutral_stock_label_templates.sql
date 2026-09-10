-- Label templates are resolution-neutral since spec 2026-09-10: the station
-- prints every template at its own printer's dpi. Stock names drop the dpi
-- suffix, and the untouched 58×40 @300 twins are disabled — never deleted,
-- because shift and inventory snapshots reference them. A twin that is an
-- organisation, category or product default stays enabled under its old name,
-- exactly as the API refuses to disable a default. Custom layouts (spec differs
-- from the seed) are left alone. Idempotent: a second run matches nothing.
-- Generated from the legacy builders in @markiro/domain (drift guard in
-- packages/domain/test/labels-defaults.test.ts).
UPDATE "label_templates" AS t
SET "name" = renamed.new_name, "updated_at" = now()
FROM (VALUES
  ('Коробка 58×40 (203 dpi)', 'Коробка 58×40', 'box'),
  ('Коробка 75×120 (203 dpi)', 'Коробка 75×120', 'box'),
  ('Коробка 100×100 (203 dpi)', 'Коробка 100×100', 'box'),
  ('Коробка 100×150 (203 dpi)', 'Коробка 100×150', 'box'),
  ('Коробка 58×40 без дат (203 dpi)', 'Коробка 58×40 без дат', 'box'),
  ('Коробка 75×120 без дат (203 dpi)', 'Коробка 75×120 без дат', 'box'),
  ('Коробка 100×100 без дат (203 dpi)', 'Коробка 100×100 без дат', 'box'),
  ('Коробка 100×150 без дат (203 dpi)', 'Коробка 100×150 без дат', 'box'),
  ('Коробка 58×40 (203 dpi) [Назв. для печати]', 'Коробка 58×40 [Назв. для печати]', 'box'),
  ('Коробка 75×120 (203 dpi) [Назв. для печати]', 'Коробка 75×120 [Назв. для печати]', 'box'),
  ('Коробка 100×100 (203 dpi) [Назв. для печати]', 'Коробка 100×100 [Назв. для печати]', 'box'),
  ('Коробка 100×150 (203 dpi) [Назв. для печати]', 'Коробка 100×150 [Назв. для печати]', 'box'),
  ('Коробка 58×40 без дат (203 dpi) [Назв. для печати]', 'Коробка 58×40 без дат [Назв. для печати]', 'box'),
  ('Коробка 75×120 без дат (203 dpi) [Назв. для печати]', 'Коробка 75×120 без дат [Назв. для печати]', 'box'),
  ('Коробка 100×100 без дат (203 dpi) [Назв. для печати]', 'Коробка 100×100 без дат [Назв. для печати]', 'box'),
  ('Коробка 100×150 без дат (203 dpi) [Назв. для печати]', 'Коробка 100×150 без дат [Назв. для печати]', 'box'),
  ('Дубликат Data Matrix 58×40 (203 dpi)', 'Дубликат Data Matrix 58×40', 'product_duplicate')
) AS renamed(old_name, new_name, purpose)
WHERE t."name" = renamed.old_name
  AND t."purpose" = renamed.purpose;
--> statement-breakpoint
UPDATE "label_templates" AS t
SET "enabled" = false, "updated_at" = now()
FROM (VALUES
  ('Коробка 58×40 (300 dpi)', '{"widthMm":58,"heightMm":40,"dpi":300,"language":"zpl","elements":[{"kind":"field","id":"name","xMm":2,"yMm":2,"field":"product.name","fontSizePt":10,"bold":true,"maxWidthMm":54,"maxLines":3},{"kind":"line","id":"sep1","xMm":2,"yMm":18.2,"x2Mm":56,"y2Mm":18.2,"thicknessMm":0.3},{"kind":"text","id":"cap-date","xMm":2,"yMm":18.8,"text":"Дата производства:","fontSizePt":5,"maxWidthMm":18},{"kind":"text","id":"cap-expiry","xMm":20,"yMm":18.8,"text":"Годен до:","fontSizePt":5,"maxWidthMm":18},{"kind":"text","id":"cap-qty","xMm":38,"yMm":18.8,"text":"Кол-во в упаковке:","fontSizePt":5,"maxWidthMm":18},{"kind":"field","id":"val-date","xMm":2,"yMm":21.6,"field":"date","fontSizePt":8,"bold":true,"maxWidthMm":18},{"kind":"field","id":"val-expiry","xMm":20,"yMm":21.6,"field":"expiry","fontSizePt":8,"bold":true,"maxWidthMm":18},{"kind":"field","id":"val-qty","xMm":38,"yMm":20.9,"field":"qty","fontSizePt":8,"bold":true,"maxWidthMm":18},{"kind":"line","id":"sep2","xMm":2,"yMm":26.2,"x2Mm":56,"y2Mm":26.2,"thicknessMm":0.3},{"kind":"text","id":"cap-egais","xMm":2,"yMm":26.8,"text":"Код ЕГАИС:","fontSizePt":5,"maxWidthMm":18},{"kind":"field","id":"val-egais","xMm":20,"yMm":26.8,"field":"product.egais","fontSizePt":8,"bold":true,"maxWidthMm":36},{"kind":"line","id":"sep3","xMm":2,"yMm":31.4,"x2Mm":56,"y2Mm":31.4,"thicknessMm":0.3},{"kind":"barcode","id":"bc-sscc","xMm":9.2,"yMm":32,"format":"code128","data":"sscc","sizeMm":4.8,"moduleWidthMm":0.254},{"kind":"field","id":"val-sscc","xMm":2,"yMm":37,"field":"sscc","fontSizePt":5,"align":"center","maxWidthMm":54}]}'),
  ('Коробка 58×40 без дат (300 dpi)', '{"widthMm":58,"heightMm":40,"dpi":300,"language":"zpl","elements":[{"kind":"field","id":"name","xMm":2,"yMm":2,"field":"product.name","fontSizePt":10,"bold":true,"maxWidthMm":54,"maxLines":3},{"kind":"line","id":"sep1","xMm":2,"yMm":18.2,"x2Mm":56,"y2Mm":18.2,"thicknessMm":0.3},{"kind":"text","id":"cap-qty","xMm":2,"yMm":18.8,"text":"Кол-во в упаковке:","fontSizePt":5,"maxWidthMm":18},{"kind":"field","id":"val-qty","xMm":20,"yMm":18.8,"field":"qty","fontSizePt":8,"bold":true,"maxWidthMm":36},{"kind":"line","id":"sep2","xMm":2,"yMm":23.4,"x2Mm":56,"y2Mm":23.4,"thicknessMm":0.3},{"kind":"text","id":"cap-egais","xMm":2,"yMm":24,"text":"Код ЕГАИС:","fontSizePt":5,"maxWidthMm":18},{"kind":"field","id":"val-egais","xMm":20,"yMm":24,"field":"product.egais","fontSizePt":8,"bold":true,"maxWidthMm":36},{"kind":"line","id":"sep3","xMm":2,"yMm":28.6,"x2Mm":56,"y2Mm":28.6,"thicknessMm":0.3},{"kind":"barcode","id":"bc-sscc","xMm":9.2,"yMm":29.2,"format":"code128","data":"sscc","sizeMm":7.6,"moduleWidthMm":0.254},{"kind":"field","id":"val-sscc","xMm":2,"yMm":37,"field":"sscc","fontSizePt":5,"align":"center","maxWidthMm":54}]}'),
  ('Коробка 58×40 (300 dpi) [Назв. для печати]', '{"widthMm":58,"heightMm":40,"dpi":300,"language":"zpl","elements":[{"kind":"field","id":"name","xMm":2,"yMm":2,"field":"product.printName","fontSizePt":10,"bold":true,"maxWidthMm":54,"maxLines":3},{"kind":"line","id":"sep1","xMm":2,"yMm":18.2,"x2Mm":56,"y2Mm":18.2,"thicknessMm":0.3},{"kind":"text","id":"cap-date","xMm":2,"yMm":18.8,"text":"Дата производства:","fontSizePt":5,"maxWidthMm":18},{"kind":"text","id":"cap-expiry","xMm":20,"yMm":18.8,"text":"Годен до:","fontSizePt":5,"maxWidthMm":18},{"kind":"text","id":"cap-qty","xMm":38,"yMm":18.8,"text":"Кол-во в упаковке:","fontSizePt":5,"maxWidthMm":18},{"kind":"field","id":"val-date","xMm":2,"yMm":21.6,"field":"date","fontSizePt":8,"bold":true,"maxWidthMm":18},{"kind":"field","id":"val-expiry","xMm":20,"yMm":21.6,"field":"expiry","fontSizePt":8,"bold":true,"maxWidthMm":18},{"kind":"field","id":"val-qty","xMm":38,"yMm":20.9,"field":"qty","fontSizePt":8,"bold":true,"maxWidthMm":18},{"kind":"line","id":"sep2","xMm":2,"yMm":26.2,"x2Mm":56,"y2Mm":26.2,"thicknessMm":0.3},{"kind":"text","id":"cap-egais","xMm":2,"yMm":26.8,"text":"Код ЕГАИС:","fontSizePt":5,"maxWidthMm":18},{"kind":"field","id":"val-egais","xMm":20,"yMm":26.8,"field":"product.egais","fontSizePt":8,"bold":true,"maxWidthMm":36},{"kind":"line","id":"sep3","xMm":2,"yMm":31.4,"x2Mm":56,"y2Mm":31.4,"thicknessMm":0.3},{"kind":"barcode","id":"bc-sscc","xMm":9.2,"yMm":32,"format":"code128","data":"sscc","sizeMm":4.8,"moduleWidthMm":0.254},{"kind":"field","id":"val-sscc","xMm":2,"yMm":37,"field":"sscc","fontSizePt":5,"align":"center","maxWidthMm":54}]}'),
  ('Коробка 58×40 без дат (300 dpi) [Назв. для печати]', '{"widthMm":58,"heightMm":40,"dpi":300,"language":"zpl","elements":[{"kind":"field","id":"name","xMm":2,"yMm":2,"field":"product.printName","fontSizePt":10,"bold":true,"maxWidthMm":54,"maxLines":3},{"kind":"line","id":"sep1","xMm":2,"yMm":18.2,"x2Mm":56,"y2Mm":18.2,"thicknessMm":0.3},{"kind":"text","id":"cap-qty","xMm":2,"yMm":18.8,"text":"Кол-во в упаковке:","fontSizePt":5,"maxWidthMm":18},{"kind":"field","id":"val-qty","xMm":20,"yMm":18.8,"field":"qty","fontSizePt":8,"bold":true,"maxWidthMm":36},{"kind":"line","id":"sep2","xMm":2,"yMm":23.4,"x2Mm":56,"y2Mm":23.4,"thicknessMm":0.3},{"kind":"text","id":"cap-egais","xMm":2,"yMm":24,"text":"Код ЕГАИС:","fontSizePt":5,"maxWidthMm":18},{"kind":"field","id":"val-egais","xMm":20,"yMm":24,"field":"product.egais","fontSizePt":8,"bold":true,"maxWidthMm":36},{"kind":"line","id":"sep3","xMm":2,"yMm":28.6,"x2Mm":56,"y2Mm":28.6,"thicknessMm":0.3},{"kind":"barcode","id":"bc-sscc","xMm":9.2,"yMm":29.2,"format":"code128","data":"sscc","sizeMm":7.6,"moduleWidthMm":0.254},{"kind":"field","id":"val-sscc","xMm":2,"yMm":37,"field":"sscc","fontSizePt":5,"align":"center","maxWidthMm":54}]}'),
  ('Дубликат Data Matrix 58×40 (300 dpi)', '{"widthMm":58,"heightMm":40,"dpi":300,"language":"zpl","elements":[{"id":"product","kind":"field","xMm":2,"yMm":2,"field":"product.printName","fontSizePt":8,"bold":true,"maxWidthMm":28,"maxLines":3},{"id":"sep-name","kind":"line","xMm":2,"yMm":15.3,"x2Mm":30,"y2Mm":15.3,"thicknessMm":0.3},{"id":"cap-date","kind":"text","xMm":2,"yMm":15.8,"text":"Дата розлива:","fontSizePt":5,"maxWidthMm":14},{"id":"cap-expiry","kind":"text","xMm":16.5,"yMm":15.8,"text":"Годен до:","fontSizePt":5,"maxWidthMm":13.5},{"id":"date","kind":"field","xMm":2,"yMm":18.8,"field":"date","fontSizePt":6,"bold":true,"maxWidthMm":14},{"id":"expiry","kind":"field","xMm":16.5,"yMm":18.8,"field":"expiry","fontSizePt":6,"bold":true,"maxWidthMm":13.5},{"id":"sep-dates","kind":"line","xMm":2,"yMm":22.5,"x2Mm":30,"y2Mm":22.5,"thicknessMm":0.3},{"id":"cap-egais","kind":"text","xMm":2,"yMm":23,"text":"Код ЕГАИС:","fontSizePt":5,"maxWidthMm":28},{"id":"egais","kind":"field","xMm":2,"yMm":25.9,"field":"product.egais","fontSizePt":6,"bold":true,"maxWidthMm":28},{"id":"cap-marking","kind":"text","xMm":2,"yMm":29.5,"text":"Код маркировки:","fontSizePt":5,"maxWidthMm":28},{"id":"marking","kind":"field","xMm":2,"yMm":32.5,"field":"km.code","textFormat":"km_without_crypto","fontSizePt":5,"maxWidthMm":28,"maxLines":2},{"id":"sep-code","kind":"line","xMm":31,"yMm":2,"x2Mm":31,"y2Mm":38,"thicknessMm":0.3},{"id":"km","kind":"barcode","xMm":32,"yMm":8,"format":"datamatrix","data":"km.code","sizeMm":24}]}')
) AS twin(name, spec)
WHERE t."name" = twin.name
  AND t."spec" = twin.spec::jsonb
  AND t."enabled"
  AND NOT EXISTS (
    SELECT 1 FROM "org_profiles" p
    WHERE p."tenant_id" = t."tenant_id" AND p."default_box_label_template_id" = t."id")
  AND NOT EXISTS (
    SELECT 1 FROM "org_box_label_template_defaults" d
    WHERE d."tenant_id" = t."tenant_id" AND d."template_id" = t."id")
  AND NOT EXISTS (
    SELECT 1 FROM "products" pr
    WHERE pr."tenant_id" = t."tenant_id" AND pr."default_label_template_id" = t."id");
