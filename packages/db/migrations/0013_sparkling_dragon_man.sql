CREATE TABLE "kiosk_pair_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "kiosk_pair_attempts_source_window_uq" UNIQUE("source","window_started_at")
);
