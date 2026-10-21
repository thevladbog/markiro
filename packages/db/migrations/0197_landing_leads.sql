CREATE TABLE "landing_lead_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"public_request_id" uuid,
	"actor_platform_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landing_lead_events_public_request_uq" UNIQUE("public_request_id"),
	CONSTRAINT "landing_lead_events_kind_check" CHECK ("landing_lead_events"."kind" in ('download','invoice_request','demo_request','status_change','touch','note','linked_tenant','activation_request','anonymized'))
);
--> statement-breakpoint
CREATE TABLE "landing_leads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"company" text,
	"name" text,
	"phone" text,
	"inn" text,
	"product_group" text,
	"lines_bucket" text,
	"locale" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_touch_at" timestamp with time zone,
	"owner_note" text,
	"tenant_id" text,
	"first_source_path" text NOT NULL,
	"first_utm" jsonb,
	"first_referrer" text,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landing_leads_shape_check" CHECK ("landing_leads"."status" in ('new','contacted','trial','invoice_sent','won','lost') and "landing_leads"."locale" in ('ru','en') and ("landing_leads"."lines_bucket" is null or "landing_leads"."lines_bucket" in ('1','2-3','4+')) and ("landing_leads"."owner_note" is null or char_length("landing_leads"."owner_note") <= 2000) and ("landing_leads"."company" is null or char_length("landing_leads"."company") between 1 and 300)),
	CONSTRAINT "landing_leads_anonymized_check" CHECK (("landing_leads"."anonymized_at" is null and "landing_leads"."email" is not null) or ("landing_leads"."anonymized_at" is not null and "landing_leads"."email" is null and "landing_leads"."name" is null and "landing_leads"."phone" is null))
);
--> statement-breakpoint
CREATE TABLE "lead_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid,
	"event_id" uuid,
	"kind" text NOT NULL,
	"digest_date" date,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_notifications_shape_check" CHECK ("lead_notifications"."kind" in ('new_lead','invoice_request','daily_digest') and "lead_notifications"."status" in ('pending','sent','failed','skipped') and "lead_notifications"."attempts" >= 0 and (("lead_notifications"."kind" = 'daily_digest') = ("lead_notifications"."lead_id" is null)) and (("lead_notifications"."kind" = 'daily_digest') = ("lead_notifications"."digest_date" is not null)) and ("lead_notifications"."last_error_code" is null or "lead_notifications"."last_error_code" ~ '^[a-z0-9_]{1,64}$'))
);
--> statement-breakpoint
ALTER TABLE "landing_lead_events" ADD CONSTRAINT "landing_lead_events_lead_id_landing_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."landing_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_lead_events" ADD CONSTRAINT "landing_lead_events_actor_platform_user_id_platform_users_id_fk" FOREIGN KEY ("actor_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_leads" ADD CONSTRAINT "landing_leads_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notifications" ADD CONSTRAINT "lead_notifications_lead_id_landing_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."landing_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notifications" ADD CONSTRAINT "lead_notifications_event_id_landing_lead_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."landing_lead_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "landing_lead_events_lead_created_idx" ON "landing_lead_events" USING btree ("lead_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "landing_lead_events_kind_created_idx" ON "landing_lead_events" USING btree ("kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "landing_leads_email_uq" ON "landing_leads" USING btree (lower(btrim("email"))) WHERE "landing_leads"."email" is not null;--> statement-breakpoint
CREATE INDEX "landing_leads_status_idx" ON "landing_leads" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "landing_leads_next_touch_idx" ON "landing_leads" USING btree ("next_touch_at") WHERE "landing_leads"."next_touch_at" is not null;--> statement-breakpoint
CREATE INDEX "landing_leads_inn_idx" ON "landing_leads" USING btree ("inn") WHERE "landing_leads"."inn" is not null;--> statement-breakpoint
CREATE INDEX "landing_leads_tenant_idx" ON "landing_leads" USING btree ("tenant_id") WHERE "landing_leads"."tenant_id" is not null;--> statement-breakpoint
CREATE INDEX "landing_leads_updated_idx" ON "landing_leads" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "lead_notifications_due_idx" ON "lead_notifications" USING btree ("next_attempt_at") WHERE "lead_notifications"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "lead_notifications_digest_date_uq" ON "lead_notifications" USING btree ("digest_date") WHERE "lead_notifications"."kind" = 'daily_digest';--> statement-breakpoint
CREATE INDEX "lead_notifications_lead_idx" ON "lead_notifications" USING btree ("lead_id");