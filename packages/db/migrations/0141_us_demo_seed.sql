CREATE TABLE "traceability_demo_seed_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"seed_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"operation_key" uuid NOT NULL,
	"input_digest" text NOT NULL,
	"input" jsonb NOT NULL,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "traceability_demo_seed_stages_stage_uq" UNIQUE("tenant_id","seed_id","stage"),
	CONSTRAINT "traceability_demo_seed_stages_operation_uq" UNIQUE("tenant_id","seed_id","operation_key"),
	CONSTRAINT "traceability_demo_seed_stages_revision_positive" CHECK ("traceability_demo_seed_stages"."revision" > 0),
	CONSTRAINT "traceability_demo_seed_stages_digest_valid" CHECK ("traceability_demo_seed_stages"."input_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "traceability_demo_seed_stages_stage_valid" CHECK ("traceability_demo_seed_stages"."stage" IN ('references','receiving','transformation','cases','shipping','trace_readiness','plan','request','package')),
	CONSTRAINT "traceability_demo_seed_stages_input_valid" CHECK (jsonb_typeof("traceability_demo_seed_stages"."input") = 'object' AND octet_length("traceability_demo_seed_stages"."input"::text) <= 16777216),
	CONSTRAINT "traceability_demo_seed_stages_receipt_valid" CHECK ("traceability_demo_seed_stages"."receipt" IS NULL OR (jsonb_typeof("traceability_demo_seed_stages"."receipt") = 'object' AND octet_length("traceability_demo_seed_stages"."receipt"::text) <= 16777216))
);
--> statement-breakpoint
CREATE TABLE "traceability_demo_seeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"scenario_version" text NOT NULL,
	"definition_digest" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "traceability_demo_seeds_scope_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "traceability_demo_seeds_scenario_uq" UNIQUE("tenant_id","scenario_version"),
	CONSTRAINT "traceability_demo_seeds_revision_positive" CHECK ("traceability_demo_seeds"."revision" > 0),
	CONSTRAINT "traceability_demo_seeds_digest_valid" CHECK ("traceability_demo_seeds"."definition_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "traceability_demo_seed_stages" ADD CONSTRAINT "traceability_demo_seed_stages_seed_fk" FOREIGN KEY ("tenant_id","seed_id") REFERENCES "public"."traceability_demo_seeds"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_demo_seeds" ADD CONSTRAINT "traceability_demo_seeds_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;