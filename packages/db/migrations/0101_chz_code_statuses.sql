CREATE TABLE "chz_code_status_cursors" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"last_scanned_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chz_code_statuses" (
	"tenant_id" text NOT NULL,
	"code_hash" char(64) NOT NULL,
	"chz_product_group_code" integer,
	"status" text,
	"status_ex" text,
	"owner_inn" text,
	"withdraw_reason" text,
	"unknown_attempts" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone,
	"next_refresh_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chz_code_statuses_tenant_id_code_hash_pk" PRIMARY KEY("tenant_id","code_hash"),
	CONSTRAINT "chz_code_statuses_hash_check" CHECK ("chz_code_statuses"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "chz_code_statuses_unknown_attempts_check" CHECK ("chz_code_statuses"."unknown_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "chz_code_status_cursors" ADD CONSTRAINT "chz_code_status_cursors_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_code_statuses" ADD CONSTRAINT "chz_code_statuses_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chz_code_statuses" ADD CONSTRAINT "chz_code_statuses_chz_product_group_code_chz_product_groups_code_fk" FOREIGN KEY ("chz_product_group_code") REFERENCES "public"."chz_product_groups"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chz_code_statuses_due_idx" ON "chz_code_statuses" USING btree ("tenant_id","next_refresh_at") WHERE "chz_code_statuses"."chz_product_group_code" is not null;