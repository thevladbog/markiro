DROP INDEX "products_tenant_gtin_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_gtin_unarchived_uq" ON "products" USING btree ("tenant_id","gtin14") WHERE "products"."archived" = false;
