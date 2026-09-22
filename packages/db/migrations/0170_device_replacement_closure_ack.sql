CREATE TABLE "working_device_replacement_closure_acknowledgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"preparation_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"credential_epoch" bigint NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "working_device_replacement_closure_ack_request_uq" UNIQUE("tenant_id","request_id"),
	CONSTRAINT "working_device_replacement_closure_ack_bounds" CHECK ("working_device_replacement_closure_acknowledgements"."credential_epoch" between 1 and 9007199254740991 and "working_device_replacement_closure_acknowledgements"."request_hash" ~ '^[0-9a-f]{64}$' and jsonb_typeof("working_device_replacement_closure_acknowledgements"."response")='object' and octet_length("working_device_replacement_closure_acknowledgements"."response"::text)<=8192 and isfinite("working_device_replacement_closure_acknowledgements"."acknowledged_at"))
);
--> statement-breakpoint
ALTER TABLE "working_device_replacement_closure_acknowledgements" ADD CONSTRAINT "working_device_replacement_closure_ack_intent_fk" FOREIGN KEY ("tenant_id","device_id","preparation_id","intent_id","credential_epoch") REFERENCES "public"."working_device_replacement_readiness_intents"("tenant_id","device_id","preparation_id","id","credential_epoch") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "working_device_replacement_closure_ack_intent_idx" ON "working_device_replacement_closure_acknowledgements" USING btree ("tenant_id","device_id","intent_id","credential_epoch");--> statement-breakpoint
CREATE TRIGGER working_device_replacement_closure_ack_immutable
BEFORE UPDATE OR DELETE ON working_device_replacement_closure_acknowledgements
FOR EACH ROW EXECUTE FUNCTION working_device_replacement_guard_report();
