-- Removes what seed-cloud.sql inserted, children first; harmless when
-- nothing is there, so the test runs it before seeding and after.
\set ON_ERROR_STOP on
BEGIN;
DELETE FROM boxes WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM pallets WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM shifts WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM sscc_blocks WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM sscc_counters WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM station_devices WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM shift_number_counters WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM employee_badges WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM operator_credentials WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM employees WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM employee_badge_salts WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM product_images WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM media_assets WHERE owner_tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM products WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM org_box_label_template_defaults WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM org_pallet_label_template_defaults WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM org_profiles WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM label_templates WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM counterparties WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM lines WHERE tenant_id IN ('imp-test-atoll', 'imp-test-other');
DELETE FROM organization WHERE id IN ('imp-test-atoll', 'imp-test-other');
COMMIT;
