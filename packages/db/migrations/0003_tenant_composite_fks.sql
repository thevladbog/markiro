-- Custom SQL migration file, put your code below! --

-- Enforce same-tenant references at the DB level: inter-table FKs were
-- single-column (e.g. shifts.product_id -> products.id), so a row could
-- reference another tenant's row. Tables are empty; enforce now.

-- 1. Add (tenant_id, id) UNIQUE constraints so composite FKs below can
-- target them.
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_tenant_id_uq" UNIQUE ("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_uq" UNIQUE ("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "lines" ADD CONSTRAINT "lines_tenant_id_uq" UNIQUE ("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_id_uq" UNIQUE ("tenant_id", "id");--> statement-breakpoint

-- 2. Drop the old single-column inter-table FKs (tenant_id -> organization
-- FKs are untouched).
ALTER TABLE "products" DROP CONSTRAINT "products_default_counterparty_id_counterparties_id_fk";--> statement-breakpoint
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_product_id_products_id_fk";--> statement-breakpoint
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_line_id_lines_id_fk";--> statement-breakpoint
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_counterparty_id_counterparties_id_fk";--> statement-breakpoint

-- 3. Add composite (tenant_id, <fk column>) FKs. Default MATCH SIMPLE
-- semantics apply: a NULL line_id/counterparty_id row skips the check,
-- which is the desired behavior for optional references.
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_default_counterparty_fk" FOREIGN KEY ("tenant_id", "default_counterparty_id") REFERENCES "public"."counterparties"("tenant_id", "id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_product_fk" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "public"."products"("tenant_id", "id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_line_fk" FOREIGN KEY ("tenant_id", "line_id") REFERENCES "public"."lines"("tenant_id", "id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_counterparty_fk" FOREIGN KEY ("tenant_id", "counterparty_id") REFERENCES "public"."counterparties"("tenant_id", "id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- 4. codes/scan_events are hand-migrated partitioned tables excluded from
-- drizzle-kit generate (see src/schema/codes.ts), so their composite FK is
-- DB-authoritative only; there is no drizzle schema mirror for it.
ALTER TABLE "codes" ADD CONSTRAINT "codes_tenant_shift_fk" FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "public"."shifts"("tenant_id", "id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_tenant_shift_fk" FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "public"."shifts"("tenant_id", "id") ON DELETE no action ON UPDATE no action;
