-- Mirror of 0149 for `pickup_scan_rejections`. A handheld write-off produces the
-- same early-rejection rows a kiosk order does -- an offline document syncing
-- hours late against a reason that has since been archived would otherwise leave
-- the scanned codes with no trace at all.
--
-- No backfill: existing rows take source_kind='kiosk' from the default with
-- station_device_id NULL, which already satisfies the check.
ALTER TABLE "pickup_scan_rejections" ALTER COLUMN "kiosk_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pickup_scan_rejections" ADD COLUMN "source_kind" text DEFAULT 'kiosk' NOT NULL;--> statement-breakpoint
ALTER TABLE "pickup_scan_rejections" ADD COLUMN "station_device_id" uuid;--> statement-breakpoint
ALTER TABLE "pickup_scan_rejections" DROP CONSTRAINT "pickup_scan_rejections_kiosk_device_seq_uq";--> statement-breakpoint
ALTER TABLE "pickup_scan_rejections" ADD CONSTRAINT "pickup_scan_rejections_source_check" CHECK ((source_kind='kiosk' AND kiosk_id IS NOT NULL AND station_device_id IS NULL) OR (source_kind='handheld' AND station_device_id IS NOT NULL AND kiosk_id IS NULL));--> statement-breakpoint
ALTER TABLE "pickup_scan_rejections" ADD CONSTRAINT "pickup_scan_rejections_tenant_station_device_fk" FOREIGN KEY ("tenant_id","station_device_id","source_kind") REFERENCES "public"."station_devices"("tenant_id","id","kind");--> statement-breakpoint
-- `device_seq` is NOT NULL on this table, so unlike pickup_orders the predicates
-- only need the owner half.
CREATE UNIQUE INDEX "pickup_scan_rejections_kiosk_device_seq_uq" ON "pickup_scan_rejections" ("tenant_id","kiosk_id","device_seq") WHERE kiosk_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_scan_rejections_handheld_device_seq_uq" ON "pickup_scan_rejections" ("tenant_id","station_device_id","device_seq") WHERE station_device_id IS NOT NULL;
