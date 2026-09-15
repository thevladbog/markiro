CREATE TABLE "billing_act_service_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"act_id" uuid NOT NULL,
	"service_period_id" uuid NOT NULL,
	"service_usage_entry_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_act_service_usage_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "billing_act_service_usage_act_sequence_uq" UNIQUE("tenant_id","act_id","sequence"),
	CONSTRAINT "billing_act_service_usage_act_entry_uq" UNIQUE("tenant_id","act_id","service_usage_entry_id"),
	CONSTRAINT "billing_act_service_usage_sequence_check" CHECK ("billing_act_service_usage"."sequence" > 0),
	CONSTRAINT "billing_act_service_usage_snapshot_check" CHECK (jsonb_typeof("billing_act_service_usage"."snapshot") = 'object' and octet_length("billing_act_service_usage"."snapshot"::text) <= 65536)
);
--> statement-breakpoint
ALTER TABLE "billing_act_service_usage" ADD CONSTRAINT "billing_act_service_usage_tenant_act_fk" FOREIGN KEY ("tenant_id","act_id") REFERENCES "public"."billing_acts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_act_service_usage" ADD CONSTRAINT "billing_act_service_usage_tenant_period_fk" FOREIGN KEY ("tenant_id","service_period_id") REFERENCES "public"."service_periods"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_act_service_usage" ADD CONSTRAINT "billing_act_service_usage_tenant_entry_fk" FOREIGN KEY ("tenant_id","service_usage_entry_id") REFERENCES "public"."service_usage_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_act_service_usage_active_entry_uq" ON "billing_act_service_usage" USING btree ("tenant_id","service_usage_entry_id") WHERE "billing_act_service_usage"."released_at" is null;