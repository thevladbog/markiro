ALTER TABLE "inventories" DROP CONSTRAINT "inventories_active_snapshot_lifecycle_check";--> statement-breakpoint
ALTER TABLE "inventories" DROP CONSTRAINT "inventories_station_manifest_lifecycle_check";--> statement-breakpoint
ALTER TABLE "inventories" DROP CONSTRAINT "inventories_completed_lifecycle_check";--> statement-breakpoint
ALTER TABLE "inventories" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "public"."inventory_lifecycle_status" RENAME TO "inventory_lifecycle_status_old";--> statement-breakpoint
CREATE TYPE "public"."inventory_lifecycle_status" AS ENUM('draft', 'preparing', 'ready', 'cancelled', 'running', 'closed', 'completed');--> statement-breakpoint
ALTER TABLE "inventories" ALTER COLUMN "status" TYPE "public"."inventory_lifecycle_status" USING "status"::text::"public"."inventory_lifecycle_status";--> statement-breakpoint
ALTER TABLE "inventories" ALTER COLUMN "status" SET DEFAULT 'draft';--> statement-breakpoint
DROP TYPE "public"."inventory_lifecycle_status_old";--> statement-breakpoint
ALTER TABLE "inventories" ADD COLUMN "cancelled_by_user_id" text;--> statement-breakpoint
ALTER TABLE "inventories" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_cancelled_by_user_id_user_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_cancelled_fields_check" CHECK (("inventories"."cancelled_by_user_id" is null and "inventories"."cancelled_at" is null)
          or ("inventories"."cancelled_by_user_id" is not null and "inventories"."cancelled_at" is not null));--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_cancelled_lifecycle_check" CHECK (("inventories"."status" = 'cancelled'
            and "inventories"."cancelled_by_user_id" is not null
            and "inventories"."cancelled_at" is not null)
          or ("inventories"."status" <> 'cancelled'
            and "inventories"."cancelled_by_user_id" is null
            and "inventories"."cancelled_at" is null));--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_active_snapshot_lifecycle_check" CHECK (("inventories"."status" in ('draft', 'preparing') and "inventories"."active_snapshot_id" is null)
        or ("inventories"."status" = 'cancelled')
        or ("inventories"."status" in ('ready', 'running', 'closed', 'completed') and "inventories"."active_snapshot_id" is not null));--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_station_manifest_lifecycle_check" CHECK (("inventories"."status" in ('draft', 'preparing', 'ready', 'cancelled') and "inventories"."station_manifest" is null)
        or ("inventories"."status" in ('running', 'closed', 'completed') and "inventories"."station_manifest" is not null));--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_completed_lifecycle_check" CHECK (("inventories"."status" = 'completed'
            and "inventories"."completed_by_user_id" is not null
            and "inventories"."completed_at" is not null
            and "inventories"."completion_acknowledged_by_user_id" is not null
            and "inventories"."completion_acknowledged_at" is not null)
          or ("inventories"."status" <> 'completed'
            and "inventories"."completed_by_user_id" is null
            and "inventories"."completed_at" is null
            and "inventories"."completion_acknowledged_by_user_id" is null
            and "inventories"."completion_acknowledged_at" is null));
