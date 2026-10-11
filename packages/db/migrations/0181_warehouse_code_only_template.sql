INSERT INTO label_templates(id,tenant_id,name,spec,purpose,enabled)
SELECT gen_random_uuid(),org.id,'Код Data Matrix 30×30','{"language":"zpl","widthMm":30,"heightMm":30,"dpi":203,"elements":[{"id":"km","kind":"barcode","format":"datamatrix","data":"km.code","xMm":4,"yMm":4,"sizeMm":22}]}'::jsonb,'product_duplicate',true
FROM organization org
WHERE NOT EXISTS (SELECT 1 FROM label_templates existing WHERE existing.tenant_id=org.id AND existing.name='Код Data Matrix 30×30' AND existing.purpose='product_duplicate');
