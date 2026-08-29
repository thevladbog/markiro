CREATE TYPE "public"."chz_export_run_state" AS ENUM('queued', 'ordered', 'ready', 'imported', 'failed');--> statement-breakpoint
CREATE TABLE "chz_export_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"inventory_id" uuid NOT NULL,
	"status" "inventory_chz_status" NOT NULL,
	"state" "chz_export_run_state" DEFAULT 'queued' NOT NULL,
	"dispenser_task_id" text,
	"result_id" text,
	"ordered_by_user_id" text NOT NULL,
	"import_id" uuid,
	"error_code" text,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"ordered_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chz_export_runs_tenant_inventory_status_uq" UNIQUE("tenant_id","inventory_id","status"),
	CONSTRAINT "chz_export_runs_attempts_nonnegative_check" CHECK ("chz_export_runs"."attempts" >= 0),
	CONSTRAINT "chz_export_runs_state_consistency_check" CHECK (("chz_export_runs"."state" = 'queued' and "chz_export_runs"."dispenser_task_id" is null and "chz_export_runs"."result_id" is null and "chz_export_runs"."import_id" is null and "chz_export_runs"."error_code" is null and "chz_export_runs"."completed_at" is null)
        or ("chz_export_runs"."state" = 'ordered' and "chz_export_runs"."dispenser_task_id" is not null and "chz_export_runs"."result_id" is null and "chz_export_runs"."import_id" is null and "chz_export_runs"."error_code" is null and "chz_export_runs"."completed_at" is null)
        or ("chz_export_runs"."state" = 'ready' and "chz_export_runs"."dispenser_task_id" is not null and "chz_export_runs"."result_id" is not null and "chz_export_runs"."import_id" is null and "chz_export_runs"."error_code" is null and "chz_export_runs"."completed_at" is null)
        or ("chz_export_runs"."state" = 'imported' and "chz_export_runs"."dispenser_task_id" is not null and "chz_export_runs"."result_id" is not null and "chz_export_runs"."import_id" is not null and "chz_export_runs"."error_code" is null and "chz_export_runs"."completed_at" is not null)
        or ("chz_export_runs"."state" = 'failed' and "chz_export_runs"."error_code" is not null and "chz_export_runs"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "chz_export_runs" ADD CONSTRAINT "chz_export_runs_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_export_runs" ADD CONSTRAINT "chz_export_runs_ordered_by_user_id_user_id_fk" FOREIGN KEY ("ordered_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_export_runs" ADD CONSTRAINT "chz_export_runs_tenant_inventory_fk" FOREIGN KEY ("tenant_id","inventory_id") REFERENCES "public"."inventories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_export_runs" ADD CONSTRAINT "chz_export_runs_tenant_import_fk" FOREIGN KEY ("tenant_id","import_id") REFERENCES "public"."inventory_imports"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chz_export_runs_unfinished_idx" ON "chz_export_runs" USING btree ("tenant_id","inventory_id") WHERE "chz_export_runs"."state" in ('queued', 'ordered', 'ready');