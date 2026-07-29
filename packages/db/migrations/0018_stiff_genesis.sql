CREATE TABLE "exchange_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "exchange_attempts_source_window_uq" UNIQUE("source","window_started_at")
);
--> statement-breakpoint
CREATE TABLE "exchange_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"chunk" integer NOT NULL,
	"body" "bytea" NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_uploads_part_uq" UNIQUE("session_id","filename","chunk")
);
--> statement-breakpoint
CREATE TABLE "integration_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"channel_type" text NOT NULL,
	"external_ref" text NOT NULL,
	"name" text NOT NULL,
	"article" text,
	"unit" text,
	"price" numeric(12, 2),
	"price_type" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden_at" timestamp with time zone,
	CONSTRAINT "integration_candidates_ref_uq" UNIQUE("tenant_id","channel_type","external_ref")
);
--> statement-breakpoint
CREATE TABLE "integration_channels" (
	"tenant_id" text NOT NULL,
	"type" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_login" text,
	"credential_hash" text,
	"silent_after_hours" integer DEFAULT 48 NOT NULL,
	"last_event_at" timestamp with time zone,
	"last_outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_channels_tenant_id_type_pk" PRIMARY KEY("tenant_id","type")
);
--> statement-breakpoint
CREATE TABLE "integration_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"channel_type" text NOT NULL,
	"session_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"direction" text NOT NULL,
	"outcome" text NOT NULL,
	"grain" text NOT NULL,
	"message" text NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "integration_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"channel_type" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"cookie_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"summary" jsonb
);
--> statement-breakpoint
ALTER TABLE "exchange_uploads" ADD CONSTRAINT "exchange_uploads_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_candidates" ADD CONSTRAINT "integration_candidates_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_channels" ADD CONSTRAINT "integration_channels_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sessions" ADD CONSTRAINT "integration_sessions_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_candidates_tenant_hidden_idx" ON "integration_candidates" USING btree ("tenant_id","hidden_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_channels_login_uq" ON "integration_channels" USING btree ("credential_login") WHERE credential_login is not null;--> statement-breakpoint
CREATE INDEX "integration_events_tenant_at_idx" ON "integration_events" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_sessions_cookie_uq" ON "integration_sessions" USING btree ("cookie_hash");--> statement-breakpoint
CREATE INDEX "integration_sessions_tenant_started_idx" ON "integration_sessions" USING btree ("tenant_id","started_at");