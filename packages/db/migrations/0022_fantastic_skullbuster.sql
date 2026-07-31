CREATE TABLE "box_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"box_id" uuid NOT NULL,
	"code_hash" char(64),
	"shift_id" uuid NOT NULL,
	"terminal_id" text,
	"operator_id" uuid,
	"reason" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "box_items" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "disassembled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "box_exceptions" ADD CONSTRAINT "box_exceptions_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "box_exceptions" ADD CONSTRAINT "box_exceptions_tenant_box_fk" FOREIGN KEY ("tenant_id","box_id") REFERENCES "public"."boxes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "box_exceptions" ADD CONSTRAINT "box_exceptions_tenant_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "box_exceptions_tenant_box_idx" ON "box_exceptions" USING btree ("tenant_id","box_id","recorded_at");