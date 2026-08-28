CREATE TABLE "inventory_event_claim_outcomes" (
	"tenant_id" text NOT NULL,
	"inventory_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"code_hash" char(64) NOT NULL,
	"status" text NOT NULL,
	"winning_event_id" uuid NOT NULL,
	"winning_device_id" uuid NOT NULL,
	"winning_scanned_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_event_claim_outcomes_source_code_uq" UNIQUE("tenant_id","inventory_id","source_event_id","code_hash"),
	CONSTRAINT "inventory_event_claim_outcomes_code_hash_check" CHECK ("inventory_event_claim_outcomes"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "inventory_event_claim_outcomes_status_check" CHECK ("inventory_event_claim_outcomes"."status" in ('claimed', 'duplicate'))
);
--> statement-breakpoint
ALTER TABLE "inventory_event_claim_outcomes" ADD CONSTRAINT "inventory_event_claim_outcomes_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_event_claim_outcomes" ADD CONSTRAINT "inventory_event_claim_outcomes_source_event_fk" FOREIGN KEY ("tenant_id","inventory_id","source_event_id") REFERENCES "public"."inventory_scan_events"("tenant_id","inventory_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_event_claim_outcomes" ADD CONSTRAINT "inventory_event_claim_outcomes_winner_event_fk" FOREIGN KEY ("tenant_id","inventory_id","winning_event_id") REFERENCES "public"."inventory_scan_events"("tenant_id","inventory_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_event_claim_outcomes_winner_idx" ON "inventory_event_claim_outcomes" USING btree ("tenant_id","inventory_id","winning_event_id");