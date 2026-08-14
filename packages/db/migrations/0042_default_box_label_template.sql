ALTER TABLE "org_profiles" ADD COLUMN "default_box_label_template_id" uuid;--> statement-breakpoint
ALTER TABLE "org_profiles" ADD CONSTRAINT "org_profiles_box_label_template_tenant_fk" FOREIGN KEY ("tenant_id","default_box_label_template_id") REFERENCES "public"."label_templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
WITH sole_templates AS (
  SELECT tenant_id, min(id::text)::uuid AS template_id
  FROM label_templates
  GROUP BY tenant_id
  HAVING count(*) = 1
)
INSERT INTO org_profiles (tenant_id, default_box_label_template_id)
SELECT tenant_id, template_id FROM sole_templates
ON CONFLICT (tenant_id) DO UPDATE
  SET default_box_label_template_id = EXCLUDED.default_box_label_template_id
WHERE org_profiles.default_box_label_template_id IS NULL;--> statement-breakpoint
UPDATE shifts AS s
SET box_label_template_id = p.default_box_label_template_id
FROM org_profiles AS p
WHERE s.tenant_id = p.tenant_id
  AND s.mode = 'aggregation'
  AND s.status IN ('planned', 'active')
  AND s.box_label_template_id IS NULL
  AND p.default_box_label_template_id IS NOT NULL;
