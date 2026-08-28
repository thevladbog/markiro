CREATE TABLE "platform_billing_mutation_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"operation" text NOT NULL,
	"target_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"result_id" uuid,
	"result" jsonb,
	"actor_platform_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_billing_mutation_idempotency_tenant_key_uq" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "platform_billing_mutation_idempotency_operation_nonempty" CHECK (nullif(btrim("platform_billing_mutation_idempotency"."operation"), '') is not null and nullif(btrim("platform_billing_mutation_idempotency"."target_id"), '') is not null),
	CONSTRAINT "platform_billing_mutation_idempotency_payload_hash_check" CHECK ("platform_billing_mutation_idempotency"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "platform_billing_mutation_idempotency_state_check" CHECK (("platform_billing_mutation_idempotency"."state" = 'pending' and "platform_billing_mutation_idempotency"."result" is null)
        or ("platform_billing_mutation_idempotency"."state" = 'committed' and "platform_billing_mutation_idempotency"."result" is not null and "platform_billing_mutation_idempotency"."result_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "billing_act_documents" ADD COLUMN "state" "billing_attachment_state" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_act_documents" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_act_documents" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "billing_act_documents"
SET "state" = 'ready', "ready_at" = "created_at", "updated_at" = "created_at";--> statement-breakpoint
ALTER TABLE "platform_billing_mutation_idempotency" ADD CONSTRAINT "platform_billing_mutation_idempotency_actor_platform_user_id_platform_users_id_fk" FOREIGN KEY ("actor_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_billing_mutation_idempotency" ADD CONSTRAINT "platform_billing_mutation_idempotency_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_billing_mutation_idempotency_tenant_target_idx" ON "platform_billing_mutation_idempotency" USING btree ("tenant_id","operation","target_id");--> statement-breakpoint
CREATE INDEX "billing_act_documents_tenant_act_state_idx" ON "billing_act_documents" USING btree ("tenant_id","act_id","state","created_at","id");--> statement-breakpoint
ALTER TABLE "billing_act_documents" ADD CONSTRAINT "billing_act_documents_ready_shape_check" CHECK (("billing_act_documents"."state" = 'ready' and "billing_act_documents"."ready_at" is not null)
        or ("billing_act_documents"."state" <> 'ready' and "billing_act_documents"."ready_at" is null));
