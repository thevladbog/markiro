CREATE TYPE "public"."billing_attachment_state" AS ENUM('pending', 'ready', 'failed', 'cleanup_required');--> statement-breakpoint
CREATE TABLE "commercial_offer_decision_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"decision" "offer_decision_kind" NOT NULL,
	"message" text,
	"decision_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_offer_decision_idempotency_tenant_key_uq" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "commercial_offer_decision_idempotency_message_shape_check" CHECK ("commercial_offer_decision_idempotency"."decision" <> 'changes_requested' or nullif(btrim("commercial_offer_decision_idempotency"."message"), '') is not null)
);
--> statement-breakpoint
ALTER TABLE "tenant_billing_request_attachments" ADD COLUMN "state" "billing_attachment_state" DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_billing_request_attachments" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_billing_request_attachments" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_offer_decision_idempotency" ADD CONSTRAINT "commercial_offer_decision_idempotency_tenant_offer_fk" FOREIGN KEY ("tenant_id","offer_id") REFERENCES "public"."commercial_offers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_offer_decision_idempotency" ADD CONSTRAINT "commercial_offer_decision_idempotency_tenant_decision_fk" FOREIGN KEY ("tenant_id","decision_id") REFERENCES "public"."commercial_offer_decisions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commercial_offer_decision_idempotency_tenant_decision_idx" ON "commercial_offer_decision_idempotency" USING btree ("tenant_id","decision_id");--> statement-breakpoint
CREATE INDEX "tenant_billing_request_attachments_tenant_request_state_idx" ON "tenant_billing_request_attachments" USING btree ("tenant_id","request_id","state","created_at","id");--> statement-breakpoint
INSERT INTO "commercial_offer_decision_idempotency"
  ("tenant_id", "idempotency_key", "offer_id", "decision", "message", "decision_id", "created_at")
SELECT "tenant_id", "idempotency_key", "offer_id", "decision", "message", "id", "created_at"
FROM "commercial_offer_decisions";--> statement-breakpoint
UPDATE "tenant_billing_request_attachments"
SET "ready_at" = "created_at"
WHERE "state" = 'ready';--> statement-breakpoint
ALTER TABLE "tenant_billing_request_attachments" ALTER COLUMN "state" SET DEFAULT 'pending';
