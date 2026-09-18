-- Second stock PALLET label (spec 2026-09-18 §8): the 58×40 box layout with
-- the quantity row counting boxes. New tenants get it from
-- tenant-provisioning.service.ts (`buildPalletLabelTemplates()[1]`); this
-- seeds the identical row for tenants that already exist. The name is the
-- (tenant_id, name, purpose) seed identity, so a re-run cannot duplicate it.
-- The organisation default is NOT touched: «Паллета 100×150» stays it.
INSERT INTO label_templates (id, tenant_id, name, purpose, spec)
SELECT gen_random_uuid(), o.id, 'Паллета 58×40', 'pallet', '{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[{"kind":"field","id":"name","xMm":2,"yMm":2,"field":"product.printName","fontSizePt":10,"bold":true,"maxWidthMm":54,"maxLines":3},{"kind":"line","id":"sep1","xMm":2,"yMm":18.2,"x2Mm":56,"y2Mm":18.2,"thicknessMm":0.3},{"kind":"text","id":"cap-date","xMm":2,"yMm":18.8,"text":"Дата производства:","fontSizePt":5,"maxWidthMm":18},{"kind":"text","id":"cap-expiry","xMm":20,"yMm":18.8,"text":"Годен до:","fontSizePt":5,"maxWidthMm":18},{"kind":"text","id":"cap-qty","xMm":38,"yMm":18.8,"text":"Коробов:","fontSizePt":5,"maxWidthMm":18},{"kind":"field","id":"val-date","xMm":2,"yMm":21.6,"field":"date","fontSizePt":8,"bold":true,"maxWidthMm":18},{"kind":"field","id":"val-expiry","xMm":20,"yMm":21.6,"field":"expiry","fontSizePt":8,"bold":true,"maxWidthMm":18},{"kind":"field","id":"val-qty","xMm":38,"yMm":20.9,"field":"qty.boxes","fontSizePt":8,"bold":true,"maxWidthMm":18},{"kind":"line","id":"sep2","xMm":2,"yMm":26.2,"x2Mm":56,"y2Mm":26.2,"thicknessMm":0.3},{"kind":"text","id":"cap-egais","xMm":2,"yMm":26.8,"text":"Код ЕГАИС:","fontSizePt":5,"maxWidthMm":18},{"kind":"field","id":"val-egais","xMm":20,"yMm":26.8,"field":"product.egais","fontSizePt":8,"bold":true,"maxWidthMm":36},{"kind":"line","id":"sep3","xMm":2,"yMm":31.4,"x2Mm":56,"y2Mm":31.4,"thicknessMm":0.3},{"kind":"barcode","id":"bc-sscc","xMm":9.5,"yMm":32,"format":"code128","data":"sscc","sizeMm":4.8,"moduleWidthMm":0.2502},{"kind":"field","id":"val-sscc","xMm":2,"yMm":37,"field":"sscc","fontSizePt":5,"align":"center","maxWidthMm":54}]}'::jsonb
  FROM organization o
 WHERE NOT EXISTS (
   SELECT 1 FROM label_templates t
    WHERE t.tenant_id = o.id AND t.name = 'Паллета 58×40' AND t.purpose = 'pallet'
 );
