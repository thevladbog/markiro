CREATE TYPE "public"."shift_entry_method" AS ENUM('list', 'task_barcode');--> statement-breakpoint
ALTER TABLE "shift_device_participants" ADD COLUMN "entry_method" "shift_entry_method" DEFAULT 'list' NOT NULL;
