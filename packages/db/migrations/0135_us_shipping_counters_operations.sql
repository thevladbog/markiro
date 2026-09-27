CREATE TABLE "shipping_counters" (
	"tenant_id" text NOT NULL,
	"year" integer NOT NULL,
	"sequence" integer NOT NULL,
	CONSTRAINT "shipping_counters_tenant_id_year_pk" PRIMARY KEY("tenant_id","year"),
	CONSTRAINT "shipping_counters_valid" CHECK ("shipping_counters"."year" BETWEEN 1 AND 9999 AND "shipping_counters"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "shipping_operations" (
	"tenant_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text GENERATED ALWAYS AS ('shipping'::text) STORED NOT NULL,
	"command" text NOT NULL,
	"operation_key" uuid NOT NULL,
	"input_digest" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_operations_tenant_id_command_operation_key_pk" PRIMARY KEY("tenant_id","command","operation_key"),
	CONSTRAINT "shipping_operations_command_valid" CHECK ("shipping_operations"."command" IN ('shipping.create','shipping.save','shipping.finalize','shipping.amend','shipping.void')),
	CONSTRAINT "shipping_operations_digest_valid" CHECK ("shipping_operations"."input_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "shipping_operations_result_valid" CHECK (jsonb_typeof("shipping_operations"."result")='object')
);
--> statement-breakpoint
ALTER TABLE "shipping_counters" ADD CONSTRAINT "shipping_counters_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_operations" ADD CONSTRAINT "shipping_operations_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_operations" ADD CONSTRAINT "shipping_operations_event_fk" FOREIGN KEY ("tenant_id","event_id","event_type") REFERENCES "public"."traceability_events"("tenant_id","id","type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipping_operations_event_idx" ON "shipping_operations" USING btree ("tenant_id","event_id");--> statement-breakpoint
CREATE FUNCTION shipping_operation_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Shipping operation results are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER shipping_operation_immutable_guard
  BEFORE UPDATE OR DELETE ON shipping_operations
  FOR EACH ROW EXECUTE FUNCTION shipping_operation_immutable_guard();
