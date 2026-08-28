CREATE TABLE "chz_api_tokens" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"encrypted_token" "bytea" NOT NULL,
	"token_nonce" "bytea" NOT NULL,
	"token_tag" "bytea" NOT NULL,
	"token_type" text DEFAULT 'jwt' NOT NULL,
	"obtained_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"agent_id" uuid,
	"cert_thumbprint" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chz_signer_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"app_version" text,
	"secret_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cert_thumbprint" text,
	"cert_subject" text,
	"cert_inn" text,
	"cert_not_after" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chz_signer_agents_tenant_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "chz_signer_pairing_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"issued_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chz_signer_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" uuid,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result_summary" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chz_api_tokens" ADD CONSTRAINT "chz_api_tokens_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_signer_agents" ADD CONSTRAINT "chz_signer_agents_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_signer_pairing_codes" ADD CONSTRAINT "chz_signer_pairing_codes_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_signer_tasks" ADD CONSTRAINT "chz_signer_tasks_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_signer_tasks" ADD CONSTRAINT "chz_signer_tasks_tenant_agent_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."chz_signer_agents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chz_signer_agents_secret_uq" ON "chz_signer_agents" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "chz_signer_agents_tenant_idx" ON "chz_signer_agents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "chz_signer_pairing_codes_hash_idx" ON "chz_signer_pairing_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "chz_signer_pairing_codes_one_live_uq" ON "chz_signer_pairing_codes" USING btree ("tenant_id") WHERE used_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "chz_signer_pairing_codes_code_hash_live_uq" ON "chz_signer_pairing_codes" USING btree ("code_hash") WHERE used_at is null;--> statement-breakpoint
CREATE INDEX "chz_signer_tasks_tenant_status_idx" ON "chz_signer_tasks" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "chz_signer_tasks_status_created_idx" ON "chz_signer_tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chz_signer_tasks_open_uq" ON "chz_signer_tasks" USING btree ("tenant_id","type") WHERE status in ('pending', 'claimed');