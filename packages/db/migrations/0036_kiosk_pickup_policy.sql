CREATE TYPE "public"."pickup_limit_mode" AS ENUM('limited', 'unlimited');--> statement-breakpoint
CREATE TABLE "employee_pickup_policies" (
	"tenant_id" text NOT NULL,
	"employee_id" uuid NOT NULL,
	"limit_mode" "pickup_limit_mode" DEFAULT 'limited' NOT NULL,
	"day_limit" integer DEFAULT 5 NOT NULL,
	"can_writeoff" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_pickup_policies_tenant_id_employee_id_pk" PRIMARY KEY("tenant_id","employee_id"),
	CONSTRAINT "employee_pickup_policies_day_limit_check" CHECK ("employee_pickup_policies"."day_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "pickup_tenant_policies" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"limits_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employee_pickup_policies" ADD CONSTRAINT "employee_pickup_policies_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_pickup_policies" ADD CONSTRAINT "employee_pickup_policies_tenant_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_tenant_policies" ADD CONSTRAINT "pickup_tenant_policies_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO pickup_tenant_policies (tenant_id, limits_enabled)
SELECT o.id, EXISTS (
  SELECT 1 FROM kiosks k WHERE k.tenant_id = o.id AND k.status = 'active'
)
FROM organization o;--> statement-breakpoint
INSERT INTO employee_pickup_policies
  (tenant_id, employee_id, limit_mode, day_limit, can_writeoff)
SELECT e.tenant_id, e.id, 'limited',
       COALESCE((SELECT MAX(k.day_limit_per_employee)
                 FROM kiosks k
                 WHERE k.tenant_id = e.tenant_id AND k.status = 'active'), 5),
       false
FROM employees e;
