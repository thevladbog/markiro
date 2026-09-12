CREATE TABLE "validation_code_reprocessings" (
	"tenant_id" text NOT NULL,
	"shift_id" uuid NOT NULL,
	"code_hash" char(64) NOT NULL,
	"source_shift_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"operator_id" uuid,
	"scanned_at" timestamp with time zone NOT NULL,
	"canonical_raw" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "validation_code_reprocessings_tenant_id_shift_id_code_hash_pk" PRIMARY KEY("tenant_id","shift_id","code_hash"),
	CONSTRAINT "validation_reprocessing_distinct_shift" CHECK ("validation_code_reprocessings"."shift_id" <> "validation_code_reprocessings"."source_shift_id"),
	CONSTRAINT "validation_reprocessing_hash_check" CHECK ("validation_code_reprocessings"."code_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_validation_print_policy_check";--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "allow_previously_accepted_codes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "validation_code_reprocessings" ADD CONSTRAINT "validation_code_reprocessings_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_code_reprocessings" ADD CONSTRAINT "validation_reprocessing_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_code_reprocessings" ADD CONSTRAINT "validation_reprocessing_source_fk" FOREIGN KEY ("tenant_id","source_shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_code_reprocessings" ADD CONSTRAINT "validation_reprocessing_device_fk" FOREIGN KEY ("tenant_id","terminal_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_code_reprocessings" ADD CONSTRAINT "validation_reprocessing_operator_fk" FOREIGN KEY ("tenant_id","operator_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "validation_reprocessing_hash_idx" ON "validation_code_reprocessings" USING btree ("tenant_id","code_hash");--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_validation_print_policy_check" CHECK (
      ("shifts"."validation_print_mode" = 'none'
        AND "shifts"."allow_previously_accepted_codes" = false
        AND "shifts"."validation_print_verification" = 'none'
        AND "shifts"."validation_print_template_id" IS NULL
        AND "shifts"."validation_print_snapshot" IS NULL
        AND "shifts"."validation_print_policy_revision" IS NULL)
      OR ("shifts"."mode" = 'validation' AND "shifts"."validation_print_mode" = 'duplicate_dm'
        AND "shifts"."validation_print_verification" IN ('none', 'required')
        AND "shifts"."validation_print_template_id" IS NOT NULL
        AND "shifts"."validation_print_snapshot" IS NOT NULL
        AND "shifts"."validation_print_policy_revision" IS NOT NULL)
    );