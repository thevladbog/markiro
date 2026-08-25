CREATE TABLE "inventory_repack_print_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"inventory_id" uuid NOT NULL,
	"box_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"result" text NOT NULL,
	"error_code" text,
	"attempted_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_repack_print_attempts_tenant_id_inventory_uq" UNIQUE("tenant_id","id","inventory_id"),
	CONSTRAINT "inventory_repack_print_attempts_box_number_uq" UNIQUE("tenant_id","inventory_id","box_id","attempt_number"),
	CONSTRAINT "inventory_repack_print_attempts_kind_check" CHECK ("inventory_repack_print_attempts"."kind" in ('initial', 'reprint')),
	CONSTRAINT "inventory_repack_print_attempts_result_check" CHECK (("inventory_repack_print_attempts"."result" = 'printed' and "inventory_repack_print_attempts"."error_code" is null)
        or ("inventory_repack_print_attempts"."result" = 'failed'
          and "inventory_repack_print_attempts"."error_code" in ('template_missing', 'printer_unconfigured',
            'render_failed', 'transport_failed', 'persistence_failed'))),
	CONSTRAINT "inventory_repack_print_attempts_number_check" CHECK ("inventory_repack_print_attempts"."attempt_number" > 0),
	CONSTRAINT "inventory_repack_print_attempts_time_check" CHECK ("inventory_repack_print_attempts"."completed_at" >= "inventory_repack_print_attempts"."attempted_at")
);
--> statement-breakpoint
ALTER TABLE "inventory_repack_print_attempts" ADD CONSTRAINT "inventory_repack_print_attempts_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_repack_print_attempts" ADD CONSTRAINT "inventory_repack_print_attempts_tenant_box_fk" FOREIGN KEY ("tenant_id","box_id","inventory_id") REFERENCES "public"."inventory_repack_boxes"("tenant_id","id","inventory_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_repack_print_attempts" ADD CONSTRAINT "inventory_repack_print_attempts_tenant_event_fk" FOREIGN KEY ("tenant_id","inventory_id","source_event_id") REFERENCES "public"."inventory_scan_events"("tenant_id","inventory_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_repack_print_attempts_box_idx" ON "inventory_repack_print_attempts" USING btree ("tenant_id","inventory_id","box_id","attempt_number");