ALTER TABLE "traceability_plan_versions" ADD COLUMN "approved_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "traceability_plan_versions" ADD COLUMN "idempotency_key_hash" text;--> statement-breakpoint
ALTER TABLE "traceability_plan_versions" ADD COLUMN "approval_request_digest" text;--> statement-breakpoint
CREATE UNIQUE INDEX "traceability_plan_idempotency_key_uq" ON "traceability_plan_versions" USING btree ("tenant_id","idempotency_key_hash") WHERE "traceability_plan_versions"."idempotency_key_hash" is not null;--> statement-breakpoint
ALTER TABLE "traceability_plan_versions" ADD CONSTRAINT "traceability_plan_approved_evidence_object" CHECK (jsonb_typeof("traceability_plan_versions"."approved_evidence") = 'object');--> statement-breakpoint
ALTER TABLE "traceability_plan_versions" ADD CONSTRAINT "traceability_plan_idempotency_hash_valid" CHECK ("traceability_plan_versions"."idempotency_key_hash" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "traceability_plan_versions" ADD CONSTRAINT "traceability_plan_request_digest_valid" CHECK ("traceability_plan_versions"."approval_request_digest" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "traceability_plan_versions" ADD CONSTRAINT "traceability_plan_approval_binding_shape" CHECK (
      ("traceability_plan_versions"."approved_evidence" IS NULL AND "traceability_plan_versions"."idempotency_key_hash" IS NULL AND "traceability_plan_versions"."approval_request_digest" IS NULL)
      OR ("traceability_plan_versions"."status" IN ('effective','superseded') AND "traceability_plan_versions"."approved_evidence" IS NOT NULL AND "traceability_plan_versions"."idempotency_key_hash" IS NOT NULL AND "traceability_plan_versions"."approval_request_digest" IS NOT NULL)
    );