-- Two cloud tenants for test/export-sql.test.mjs: `imp-test-atoll`, whose
-- export must equal test/fixtures/raw-cloud.json, and `imp-test-other`,
-- whose rows (a higher counter under the same prefix, an active shift, a
-- stale station, a higher shift number) must not reach it, except the
-- serials it holds under the first tenant's prefixes, which the export lists
-- apart as `otherTenantsSscc` (one per source: counter, block, box, pallet;
-- an extension and a prefix that do not count; a malformed box SSCC). Fixed
-- ids, so cleanup-cloud.sql removes exactly these rows. Run on a database
-- with the cloud's migrations applied.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO organization (id, name, slug, created_at) VALUES
  ('imp-test-atoll', 'ООО «Атолл»', 'imp-test-atoll', '2026-01-10 09:00:00'),
  ('imp-test-other', 'ООО «Чужой»', 'imp-test-other', '2026-01-10 09:00:00');

INSERT INTO label_templates (id, tenant_id, name, spec, purpose, enabled, chz_product_group_codes, created_at) VALUES
  ('0d0d0000-0000-4000-8000-000000000001', 'imp-test-atoll', 'Короб 58×40',
    '{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[]}', 'box', true, NULL, '2026-01-11 09:00:01+00'),
  ('0d0d0000-0000-4000-8000-000000000002', 'imp-test-atoll', 'Короб молочный',
    '{"widthMm":58,"heightMm":60,"dpi":203,"language":"zpl","elements":[]}', 'box', true, '{8}', '2026-01-11 09:00:02+00'),
  ('0d0d0000-0000-4000-8000-000000000003', 'imp-test-atoll', 'Паллета 100×150',
    '{"widthMm":100,"heightMm":150,"dpi":203,"language":"zpl","elements":[]}', 'pallet', true, NULL, '2026-01-11 09:00:03+00'),
  ('0d0d0000-0000-4000-8000-000000000004', 'imp-test-atoll', 'Дубликат',
    '{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[]}', 'product_duplicate', true, NULL, '2026-01-11 09:00:04+00'),
  ('0d0d0000-0000-4000-8000-000000000005', 'imp-test-atoll', 'Старый короб',
    '{"widthMm":58,"heightMm":40,"dpi":300,"language":"tspl","elements":[]}', 'box', false, NULL, '2026-01-11 09:00:05+00'),
  ('0d0d0000-0000-4000-8000-000000000006', 'imp-test-atoll', 'Не макет',
    '["not", "a", "layout"]', 'box', true, NULL, '2026-01-11 09:00:06+00'),
  ('0d0d0000-0000-4000-8000-000000000099', 'imp-test-other', 'Чужой короб',
    '{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[]}', 'box', true, NULL, '2026-01-11 09:00:07+00'),
  ('0d0d0000-0000-4000-8000-000000000098', 'imp-test-other', 'Чужая паллета',
    '{"widthMm":100,"heightMm":150,"dpi":203,"language":"zpl","elements":[]}', 'pallet', true, NULL, '2026-01-11 09:00:08+00');

-- An A4 pallet sheet (migration 0183), the organization's default sheet and
-- a category's: the export leaves all three out and says so.
INSERT INTO label_templates (id, tenant_id, name, spec, purpose, format, enabled, chz_product_group_codes, created_at) VALUES
  ('0d0d0000-0000-4000-8000-000000000007', 'imp-test-atoll', 'Палета А4 · вертикальная',
    '{"schemaVersion":2,"kind":"pallet_sheet","dpi":300,"page":{"size":"A4","orientation":"portrait","copies":1,"cutLine":false,"marginsMm":{"top":10,"right":10,"bottom":10,"left":10}},"body":[],"footer":{"id":"sscc","kind":"sscc","source":"sscc","barHeightMm":45,"moduleDots":11,"align":"center"}}',
    'pallet', 'pallet_sheet_v2', true, NULL, '2026-01-11 09:00:09+00');

INSERT INTO org_profiles (tenant_id, gln, gs1_prefixes, inn, time_zone,
    default_box_label_template_id, default_pallet_label_template_id,
    default_pallet_sheet_template_id) VALUES
  ('imp-test-atoll', '4600682000010', '{4600682," 4600682 ",46x}', '7701234567', 'Europe/Moscow',
    '0d0d0000-0000-4000-8000-000000000001', '0d0d0000-0000-4000-8000-000000000003',
    '0d0d0000-0000-4000-8000-000000000007'),
  ('imp-test-other', '4600682000010', '{}', NULL, 'Europe/Moscow', NULL, NULL, NULL);

INSERT INTO org_box_label_template_defaults (tenant_id, chz_product_group_code, template_id) VALUES
  ('imp-test-atoll', 8, '0d0d0000-0000-4000-8000-000000000002'),
  ('imp-test-atoll', 13, '0d0d0000-0000-4000-8000-000000000005'),
  ('imp-test-other', 8, '0d0d0000-0000-4000-8000-000000000099');
INSERT INTO org_pallet_label_template_defaults (tenant_id, chz_product_group_code, template_id) VALUES
  ('imp-test-atoll', 8, '0d0d0000-0000-4000-8000-000000000003'),
  ('imp-test-other', 8, '0d0d0000-0000-4000-8000-000000000098');
INSERT INTO org_pallet_sheet_template_defaults (tenant_id, chz_product_group_code, template_id) VALUES
  ('imp-test-atoll', 8, '0d0d0000-0000-4000-8000-000000000007');

INSERT INTO employee_badge_salts (tenant_id, salt) VALUES
  ('imp-test-atoll', 'bWFya2lyby1iYWRnZS0wMQ=='),
  ('imp-test-other', 'b3RoZXItdGVuYW50LXNhbHQ=');

INSERT INTO lines (id, tenant_id, name, created_at) VALUES
  ('0a0a0000-0000-4000-8000-000000000001', 'imp-test-atoll', 'Линия 1', '2026-01-12 09:00:01+00'),
  ('0a0a0000-0000-4000-8000-000000000002', 'imp-test-atoll', 'Упаковка', '2026-01-12 09:00:02+00'),
  ('0a0a0000-0000-4000-8000-000000000003', 'imp-test-atoll', ' линия 1 ', '2026-01-12 09:00:03+00'),
  ('0a0a0000-0000-4000-8000-000000000099', 'imp-test-other', 'Чужая линия', '2026-01-12 09:00:04+00');

INSERT INTO counterparties (id, tenant_id, name, gln, inn, gs1_prefixes, notes, created_at) VALUES
  ('0c0c0000-0000-4000-8000-000000000001', 'imp-test-atoll', 'ООО «Берег»', '4601234000017',
    '7812345678', '{4601234}', 'договор 12', '2026-01-13 09:00:01+00'),
  ('0c0c0000-0000-4000-8000-000000000002', 'imp-test-atoll', 'ИП Петров', '46012',
    NULL, '{}', NULL, '2026-01-13 09:00:02+00'),
  ('0c0c0000-0000-4000-8000-000000000003', 'imp-test-atoll', 'АО «Дельта»', '4607000000014',
    '12345', '{}', '  ', '2026-01-13 09:00:03+00'),
  ('0c0c0000-0000-4000-8000-000000000099', 'imp-test-other', 'Чужой контрагент', '4609999000019',
    NULL, '{}', NULL, '2026-01-13 09:00:04+00');

INSERT INTO products (id, tenant_id, gtin14, name, print_name, chz_product_group_code, box_capacity,
    pallet_box_capacity, archived, default_label_template_id, unit_price, egais_code, shelf_life_days,
    external_ref, created_at) VALUES
  ('0e0e0000-0000-4000-8000-000000000001', 'imp-test-atoll', '04600682000013', 'Молоко 3,2% 0,9 л',
    'Молоко 3,2%', 8, 12, 40, false, '0d0d0000-0000-4000-8000-000000000002', 89.90, NULL, 10, NULL,
    '2026-01-14 09:00:01+00'),
  ('0e0e0000-0000-4000-8000-000000000002', 'imp-test-atoll', '04600682000020', 'Вода ' || repeat('я', 200),
    NULL, 13, 6, 100000, false, '0d0d0000-0000-4000-8000-000000000003', NULL, NULL, 5000, 'erp-17',
    '2026-01-14 09:00:02+00'),
  ('0e0e0000-0000-4000-8000-000000000003', 'imp-test-atoll', '04600682000013', 'Молоко (старая карточка)',
    NULL, 8, 12, 40, true, '0d0d0000-0000-4000-8000-000000000004', NULL, '0123', NULL, NULL,
    '2026-01-14 09:00:03+00'),
  ('0e0e0000-0000-4000-8000-000000000004', 'imp-test-atoll', '4600682000037', 'Кефир',
    NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, NULL, '2026-01-14 09:00:04+00'),
  ('0e0e0000-0000-4000-8000-000000000099', 'imp-test-other', '04600682000013', 'Чужое молоко',
    NULL, 8, 12, 40, false, NULL, NULL, NULL, NULL, NULL, '2026-01-14 09:00:05+00');

INSERT INTO employees (id, tenant_id, full_name, role, status) VALUES
  ('0f0f0000-0000-4000-8000-000000000001', 'imp-test-atoll', 'Анна Кузнецова', 'Оператор линии', 'active'),
  ('0f0f0000-0000-4000-8000-000000000002', 'imp-test-atoll', E'Пётр\tСидоров', NULL, 'active'),
  ('0f0f0000-0000-4000-8000-000000000003', 'imp-test-atoll', 'Илья Короткий', NULL, 'active'),
  ('0f0f0000-0000-4000-8000-000000000004', 'imp-test-atoll', 'Ольга Архивная', NULL, 'archived'),
  ('0f0f0000-0000-4000-8000-000000000005', 'imp-test-atoll', 'Сергей Без-Пина', NULL, 'active'),
  ('0f0f0000-0000-4000-8000-000000000006', 'imp-test-atoll', 'Кладовщик', NULL, 'active'),
  ('0f0f0000-0000-4000-8000-000000000098', 'imp-test-other', 'Чужой кладовщик', NULL, 'active'),
  ('0f0f0000-0000-4000-8000-000000000099', 'imp-test-other', 'Чужой оператор', NULL, 'active');

INSERT INTO operator_credentials (tenant_id, employee_id, login, pin_hash, active) VALUES
  ('imp-test-atoll', '0f0f0000-0000-4000-8000-000000000001', '0042',
    'pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=', true),
  ('imp-test-atoll', '0f0f0000-0000-4000-8000-000000000002', '117',
    'pbkdf2$sha256$100000$bWFya2lyby1waW4tdHdvIQ==$QVZc+yU8wJn39tbKU3wt1Q2wIycAv4j5TS8wJZxy3u8=', false),
  ('imp-test-atoll', '0f0f0000-0000-4000-8000-000000000003', '12',
    'pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=', true),
  ('imp-test-atoll', '0f0f0000-0000-4000-8000-000000000004', '205',
    'pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=', true),
  ('imp-test-atoll', '0f0f0000-0000-4000-8000-000000000005', '306',
    'pbkdf2$sha256$0100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=', true),
  ('imp-test-other', '0f0f0000-0000-4000-8000-000000000099', '0042',
    'pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=', true);

INSERT INTO employee_badges (id, tenant_id, employee_id, badge_code, label, badge_hash, issued_at, revoked_at) VALUES
  ('0b0b0000-0000-4000-8000-000000000001', 'imp-test-atoll', '0f0f0000-0000-4000-8000-000000000001',
    'MRK-000742', 'Пропуск 1',
    'pbkdf2$sha256$100000$bWFya2lyby1iYWRnZS0wMQ==$CFQuvVuv7iz+ANkhgZVnO2k8iP67A2gex7JV7uWRayo=',
    '2026-01-15 09:00:01+00', NULL),
  ('0b0b0000-0000-4000-8000-000000000002', 'imp-test-atoll', '0f0f0000-0000-4000-8000-000000000001',
    'MRK-000743', NULL, NULL, '2026-01-15 09:00:02+00', NULL),
  ('0b0b0000-0000-4000-8000-000000000003', 'imp-test-atoll', '0f0f0000-0000-4000-8000-000000000002',
    ' MRK-000744 ', E'Запасной\nбейдж',
    'pbkdf2$sha256$100000$bGVnYWN5LXJvdy1zYWx0IQ==$vULnmFLrlEL53UOHeKzL62/qUqLZKBBI/X0BXSWxx5E=',
    '2026-01-15 09:00:03+00', NULL),
  ('0b0b0000-0000-4000-8000-000000000004', 'imp-test-atoll', '0f0f0000-0000-4000-8000-000000000001',
    'МРК-1', NULL, NULL, '2026-01-15 09:00:04+00', NULL),
  ('0b0b0000-0000-4000-8000-000000000005', 'imp-test-atoll', '0f0f0000-0000-4000-8000-000000000003',
    'MRK-000746', NULL, NULL, '2026-01-15 09:00:05+00', NULL),
  ('0b0b0000-0000-4000-8000-000000000006', 'imp-test-atoll', '0f0f0000-0000-4000-8000-000000000001',
    'MRK-000700', NULL, NULL, '2026-01-15 09:00:06+00', '2026-02-01 09:00:00+00'),
  ('0b0b0000-0000-4000-8000-000000000007', 'imp-test-atoll', '0f0f0000-0000-4000-8000-000000000006',
    'MRK-000900', NULL, NULL, '2026-01-15 09:00:07+00', NULL),
  ('0b0b0000-0000-4000-8000-000000000008', 'imp-test-atoll', '0f0f0000-0000-4000-8000-000000000006',
    'MRK-000901', NULL, NULL, '2026-01-15 09:00:08+00', NULL),
  ('0b0b0000-0000-4000-8000-000000000009', 'imp-test-atoll', '0f0f0000-0000-4000-8000-000000000006',
    'MRK-000902', NULL, NULL, '2026-01-15 09:00:09+00', '2026-02-02 09:00:00+00'),
  ('0b0b0000-0000-4000-8000-000000000098', 'imp-test-other', '0f0f0000-0000-4000-8000-000000000098',
    'MRK-000950', NULL, NULL, '2026-01-15 09:00:10+00', NULL),
  ('0b0b0000-0000-4000-8000-000000000099', 'imp-test-other', '0f0f0000-0000-4000-8000-000000000099',
    'MRK-000742', NULL, NULL, '2026-01-15 09:00:11+00', NULL);

INSERT INTO station_devices (id, tenant_id, name, last_seen_at, revoked_at) VALUES
  ('0a0d0000-0000-4000-8000-000000000001', 'imp-test-atoll', 'Станция 1', '2026-10-09 18:00:00+00', NULL),
  ('0a0d0000-0000-4000-8000-000000000002', 'imp-test-atoll', 'Старая станция', NULL, '2026-05-01 09:00:00+00'),
  ('0a0d0000-0000-4000-8000-000000000003', 'imp-test-atoll', 'Станция без блока', NULL, NULL),
  ('0a0d0000-0000-4000-8000-000000000099', 'imp-test-other', 'Чужая станция', NULL, NULL);

INSERT INTO sscc_counters (tenant_id, issuer_prefix, extension_digit, next_serial) VALUES
  ('imp-test-atoll', '460068200', 0, 18500),
  ('imp-test-atoll', '460068200', 1, 301),
  ('imp-test-atoll', '460123400', 0, 1),
  ('imp-test-other', '460068200', 0, 900001),
  ('imp-test-other', '460068200', 3, 2000),
  ('imp-test-other', '461111100', 0, 5);

INSERT INTO sscc_blocks (id, allocation_order, tenant_id, issuer_prefix, extension_digit, device_id,
    from_serial, to_serial, consumed_through_serial, revoked_at) VALUES
  ('0bb00000-0000-4000-8000-000000000001', 1, 'imp-test-atoll', '460068200', 0,
    '0a0d0000-0000-4000-8000-000000000002', 18000, 19999, 18750, '2026-05-01 09:00:00+00'),
  ('0bb00000-0000-4000-8000-000000000002', 1, 'imp-test-atoll', '460068200', 0,
    '0a0d0000-0000-4000-8000-000000000001', 16000, 17999, 17999, NULL),
  ('0bb00000-0000-4000-8000-000000000003', 1, 'imp-test-atoll', '460068200', 1,
    '0a0d0000-0000-4000-8000-000000000001', 201, 400, 250, NULL),
  ('0bb00000-0000-4000-8000-000000000099', 1, 'imp-test-other', '460068200', 1,
    '0a0d0000-0000-4000-8000-000000000099', 700000, 700000, NULL, NULL),
  ('0bb00000-0000-4000-8000-000000000098', 2, 'imp-test-other', '460068200', 0,
    '0a0d0000-0000-4000-8000-000000000099', 800000, 800000, NULL, NULL);

INSERT INTO shifts (id, tenant_id, product_id, line_id, mode, status, number_month_key, number_seq,
    sscc_issuer_counterparty_id, closed_at) VALUES
  ('05050000-0000-4000-8000-000000000001', 'imp-test-atoll', '0e0e0000-0000-4000-8000-000000000001',
    '0a0a0000-0000-4000-8000-000000000001', 'aggregation', 'closed', 'OCT26', 6, NULL, '2026-10-09 17:00:00+00'),
  ('05050000-0000-4000-8000-000000000002', 'imp-test-atoll', '0e0e0000-0000-4000-8000-000000000001',
    '0a0a0000-0000-4000-8000-000000000001', 'aggregation', 'planned', 'OCT26', 7, NULL, NULL),
  ('05050000-0000-4000-8000-000000000003', 'imp-test-atoll', '0e0e0000-0000-4000-8000-000000000001',
    '0a0a0000-0000-4000-8000-000000000002', 'aggregation', 'planned', 'NOV26', 1, NULL, NULL),
  ('05050000-0000-4000-8000-000000000004', 'imp-test-atoll', '0e0e0000-0000-4000-8000-000000000001',
    '0a0a0000-0000-4000-8000-000000000001', 'aggregation', 'closed', 'SEP26', 41,
    '0c0c0000-0000-4000-8000-000000000001', '2026-09-30 17:00:00+00'),
  ('05050000-0000-4000-8000-000000000099', 'imp-test-other', '0e0e0000-0000-4000-8000-000000000099',
    '0a0a0000-0000-4000-8000-000000000099', 'aggregation', 'active', 'OCT26', 3, NULL, NULL),
  ('05050000-0000-4000-8000-000000000098', 'imp-test-other', '0e0e0000-0000-4000-8000-000000000099',
    '0a0a0000-0000-4000-8000-000000000099', 'aggregation', 'closed', 'OCT26', 99,
    '0c0c0000-0000-4000-8000-000000000099', '2026-10-10 12:00:00+00'),
  ('05050000-0000-4000-8000-000000000097', 'imp-test-other', '0e0e0000-0000-4000-8000-000000000099',
    '0a0a0000-0000-4000-8000-000000000099', 'aggregation', 'planned', 'OCT26', 98, NULL, NULL);

INSERT INTO pallets (id, tenant_id, shift_id, device_pallet_id, sscc) VALUES
  ('0b0d0000-0000-4000-8000-000000000001', 'imp-test-atoll', '05050000-0000-4000-8000-000000000001',
    'pallet-1', '146006820000002502'),
  ('0b0d0000-0000-4000-8000-000000000002', 'imp-test-atoll', '05050000-0000-4000-8000-000000000001',
    'pallet-2', 'MANUAL-PALLET'),
  ('0b0d0000-0000-4000-8000-000000000099', 'imp-test-other', '05050000-0000-4000-8000-000000000099',
    'pallet-99', '146012340006000002'),
  ('0b0d0000-0000-4000-8000-000000000098', 'imp-test-other', '05050000-0000-4000-8000-000000000099',
    'pallet-98', 'not-an-sscc');

INSERT INTO boxes (id, tenant_id, shift_id, device_box_id, sscc) VALUES
  ('0b0c0000-0000-4000-8000-000000000001', 'imp-test-atoll', '05050000-0000-4000-8000-000000000001',
    'box-1', '046006820000187509'),
  ('0b0c0000-0000-4000-8000-000000000002', 'imp-test-atoll', '05050000-0000-4000-8000-000000000001',
    'box-2', '046006820000210030'),
  ('0b0c0000-0000-4000-8000-000000000003', 'imp-test-atoll', '05050000-0000-4000-8000-000000000001',
    'box-3', '046099990000007777'),
  ('0b0c0000-0000-4000-8000-000000000004', 'imp-test-atoll', '05050000-0000-4000-8000-000000000001',
    'box-4', NULL),
  ('0b0c0000-0000-4000-8000-000000000005', 'imp-test-atoll', '05050000-0000-4000-8000-000000000001',
    'box-5', 'MANUAL-REPRINT'),
  ('0b0c0000-0000-4000-8000-000000000006', 'imp-test-atoll', '05050000-0000-4000-8000-000000000001',
    'box-6', '246006820009999990'),
  ('0b0c0000-0000-4000-8000-000000000099', 'imp-test-other', '05050000-0000-4000-8000-000000000099',
    'box-99', '046012340005000001'),
  ('0b0c0000-0000-4000-8000-000000000098', 'imp-test-other', '05050000-0000-4000-8000-000000000099',
    'box-98', 'not-an-sscc');

INSERT INTO shift_number_counters (tenant_id, month_key, last_seq) VALUES
  ('imp-test-atoll', 'SEP26', 41),
  ('imp-test-atoll', 'OCT26', 7),
  ('imp-test-atoll', 'NOV26', 1),
  ('imp-test-atoll', 'DEC26', 0),
  ('imp-test-other', 'OCT26', 99);

COMMIT;
