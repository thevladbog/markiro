CREATE TABLE "us_session_assurances" (
	"session_id" text PRIMARY KEY NOT NULL,
	"factor_id" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "us_two_factors" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"user_id" text NOT NULL,
	CONSTRAINT "us_two_factors_user_id_uq" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "us_session_assurances" ADD CONSTRAINT "us_session_assurances_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "us_session_assurances" ADD CONSTRAINT "us_session_assurances_factor_id_us_two_factors_id_fk" FOREIGN KEY ("factor_id") REFERENCES "public"."us_two_factors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "us_two_factors" ADD CONSTRAINT "us_two_factors_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "us_session_assurances_factor_id_idx" ON "us_session_assurances" USING btree ("factor_id");