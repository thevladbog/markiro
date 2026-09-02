import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { labelTemplates } from "../src/schema/labels.js";
import { orgBoxLabelTemplateDefaults } from "../src/schema/org-profile.js";

describe("label template scope schema", () => {
  it("adds an enabled flag and a nullable product-group scope with a non-empty check", () => {
    expect(labelTemplates.enabled.notNull).toBe(true);
    expect(labelTemplates.enabled.hasDefault).toBe(true);
    expect(labelTemplates.enabled.default).toBe(true);
    expect(labelTemplates.chzProductGroupCodes.notNull).toBe(false);
    const config = getTableConfig(labelTemplates);
    expect(config.checks.map((check) => check.name)).toContain(
      "label_templates_product_group_codes_nonempty",
    );
  });

  it("keys category defaults by tenant and product group with a same-tenant template FK", () => {
    const config = getTableConfig(orgBoxLabelTemplateDefaults);
    expect(config.name).toBe("org_box_label_template_defaults");
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "chz_product_group_code",
    ]);
    expect(config.foreignKeys.map((fk) => fk.getName())).toContain(
      "org_box_label_template_defaults_template_tenant_fk",
    );
    expect(orgBoxLabelTemplateDefaults.templateId.notNull).toBe(true);
  });
});
