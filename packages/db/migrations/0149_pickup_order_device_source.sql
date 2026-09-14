-- `pickup_orders` stops assuming its source device is a kiosk: a handheld files
-- the same document for `reason='writeoff'`. Owner shape copied from the
-- `device_grant_*` tables (migration 0148) rather than invented.
--
-- No backfill is needed. Every existing row has a kiosk_id and takes
-- source_kind='kiosk' from the default with station_device_id NULL, which is
-- exactly what the new check requires.
ALTER TABLE "pickup_orders" ALTER COLUMN "kiosk_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pickup_orders" ADD COLUMN "source_kind" text DEFAULT 'kiosk' NOT NULL;--> statement-breakpoint
ALTER TABLE "pickup_orders" ADD COLUMN "station_device_id" uuid;--> statement-breakpoint
ALTER TABLE "pickup_orders" DROP CONSTRAINT "pickup_orders_kiosk_device_seq_uq";--> statement-breakpoint
ALTER TABLE "pickup_orders" ADD CONSTRAINT "pickup_orders_source_check" CHECK ((source_kind='kiosk' AND kiosk_id IS NOT NULL AND station_device_id IS NULL) OR (source_kind='handheld' AND station_device_id IS NOT NULL AND kiosk_id IS NULL));--> statement-breakpoint
-- `source_kind` participates so a row claiming `handheld` cannot reference a
-- device of kind `station`; `station_devices_tenant_id_kind_uq` (0146) is the
-- unique this points at.
ALTER TABLE "pickup_orders" ADD CONSTRAINT "pickup_orders_tenant_station_device_fk" FOREIGN KEY ("tenant_id","station_device_id","source_kind") REFERENCES "public"."station_devices"("tenant_id","id","kind");--> statement-breakpoint
-- `device_seq IS NOT NULL` preserves the exemption for admin-created rows that
-- the dropped UNIQUE constraint got from MATCH SIMPLE NULL semantics.
CREATE UNIQUE INDEX "pickup_orders_kiosk_device_seq_uq" ON "pickup_orders" ("tenant_id","kiosk_id","device_seq") WHERE kiosk_id IS NOT NULL AND device_seq IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_orders_handheld_device_seq_uq" ON "pickup_orders" ("tenant_id","station_device_id","device_seq") WHERE station_device_id IS NOT NULL AND device_seq IS NOT NULL;
