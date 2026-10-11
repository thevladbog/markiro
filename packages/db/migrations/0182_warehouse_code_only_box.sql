INSERT INTO label_templates(id,tenant_id,name,spec,purpose,enabled)
SELECT gen_random_uuid(),org.id,'SSCC короба 58×40','{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[{"kind":"barcode","id":"bc-sscc","xMm":9.5,"yMm":5,"format":"code128","data":"sscc","sizeMm":24,"moduleWidthMm":0.2502},{"kind":"field","id":"val-sscc","xMm":2,"yMm":32,"field":"sscc","fontSizePt":5,"align":"center","maxWidthMm":54}]}'::jsonb,'box',true
FROM organization org
WHERE NOT EXISTS(SELECT 1 FROM label_templates existing WHERE existing.tenant_id=org.id AND existing.name='SSCC короба 58×40' AND existing.purpose='box');
