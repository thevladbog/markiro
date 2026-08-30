CREATE TABLE "inventory_correction_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"inventory_id" uuid NOT NULL,
	"action" "inventory_correction_action" NOT NULL,
	"reason" text NOT NULL,
	"request_digest" char(64) NOT NULL,
	"actor_user_id" text NOT NULL,
	"selected_event_count" integer NOT NULL,
	"affected_code_count" integer NOT NULL,
	"result_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_correction_batches_tenant_id_inventory_uq" UNIQUE("tenant_id","id","inventory_id"),
	CONSTRAINT "inventory_correction_batches_action_check" CHECK ("inventory_correction_batches"."action" in ('void_scan', 'change_date')),
	CONSTRAINT "inventory_correction_batches_counts_check" CHECK ("inventory_correction_batches"."selected_event_count" > 0 and "inventory_correction_batches"."affected_code_count" > 0),
	CONSTRAINT "inventory_correction_batches_reason_check" CHECK (octet_length(btrim("inventory_correction_batches"."reason")) between 1 and 1024),
	CONSTRAINT "inventory_correction_batches_digest_check" CHECK ("inventory_correction_batches"."request_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "inventory_correction_batches_revision_check" CHECK ("inventory_correction_batches"."result_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "inventory_corrections" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_correction_batches" ADD CONSTRAINT "inventory_correction_batches_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_correction_batches" ADD CONSTRAINT "inventory_correction_batches_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_correction_batches" ADD CONSTRAINT "inventory_correction_batches_tenant_inventory_fk" FOREIGN KEY ("tenant_id","inventory_id") REFERENCES "public"."inventories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_correction_batches_inventory_revision_idx" ON "inventory_correction_batches" USING btree ("tenant_id","inventory_id","result_revision","created_at","id");--> statement-breakpoint
ALTER TABLE "inventory_corrections" ADD CONSTRAINT "inventory_corrections_tenant_batch_fk" FOREIGN KEY ("tenant_id","batch_id","inventory_id") REFERENCES "public"."inventory_correction_batches"("tenant_id","id","inventory_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_corrections_batch_idx" ON "inventory_corrections" USING btree ("tenant_id","inventory_id","batch_id","id");