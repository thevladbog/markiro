import { expect, it } from "vitest";
import { ENTITLEMENT_OPERATIONS } from "@markiro/platform-contracts";
import { PUBLIC_API_OPERATIONS } from "../src/modules/public-api/public-api-admission.service";
it("uses explicit public scope operations without widening cabinet bindings", () => {
  expect(ENTITLEMENT_OPERATIONS["inventory.task.create.v1"].authorization).toBe("cabinet");
  for (const [name, entry] of Object.entries(PUBLIC_API_OPERATIONS)) {
    const operation = ENTITLEMENT_OPERATIONS[entry.entitlementOperation];
    expect(operation.authorization).toBe("api_key_scope");
    expect(operation.features).toContain("publicApi");
    if (name.startsWith("inventory.")) expect(operation.features).toContain("inventory");
  }
});
