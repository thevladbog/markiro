CREATE TABLE "code_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"code_hash" char(64) NOT NULL,
	"losing_shift_id" uuid NOT NULL,
	"losing_terminal_id" text,
	"losing_scanned_at" timestamp with time zone NOT NULL,
	"winning_shift_id" uuid NOT NULL,
	"winning_terminal_id" text,
	"winning_scanned_at" timestamp with time zone NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "code_registry" (
	"tenant_id" text NOT NULL,
	"code_hash" char(64) NOT NULL,
	"shift_id" uuid NOT NULL,
	"terminal_id" text,
	"scanned_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_registry_tenant_id_code_hash_pk" PRIMARY KEY("tenant_id","code_hash")
);
--> statement-breakpoint
ALTER TABLE "code_conflicts" ADD CONSTRAINT "code_conflicts_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_registry" ADD CONSTRAINT "code_registry_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_conflicts_shift_idx" ON "code_conflicts" USING btree ("tenant_id","losing_shift_id");