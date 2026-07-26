CREATE TABLE "operator_credentials" (
	"tenant_id" text NOT NULL,
	"employee_id" uuid NOT NULL,
	"login" text NOT NULL,
	"pin_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_credentials_tenant_id_employee_id_pk" PRIMARY KEY("tenant_id","employee_id"),
	CONSTRAINT "operator_credentials_tenant_login_uq" UNIQUE("tenant_id","login")
);
--> statement-breakpoint
ALTER TABLE "employee_badges" ADD COLUMN "badge_hash" text;--> statement-breakpoint
ALTER TABLE "operator_credentials" ADD CONSTRAINT "operator_credentials_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_credentials" ADD CONSTRAINT "operator_credentials_tenant_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;