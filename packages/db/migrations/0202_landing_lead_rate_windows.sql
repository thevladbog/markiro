CREATE TABLE "landing_lead_rate_windows" (
	"key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"attempts" integer NOT NULL,
	CONSTRAINT "landing_lead_rate_windows_key_check" CHECK ("landing_lead_rate_windows"."key" = 'global' OR "landing_lead_rate_windows"."key" ~ '^source:[0-9a-f]{64}$'),
	CONSTRAINT "landing_lead_rate_windows_attempts_check" CHECK ("landing_lead_rate_windows"."attempts" BETWEEN 1 AND 10001)
);
--> statement-breakpoint
CREATE INDEX "landing_lead_rate_windows_expiry_idx" ON "landing_lead_rate_windows" USING btree ("window_started_at");