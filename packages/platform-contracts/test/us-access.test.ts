import { describe, expect, it } from "vitest";
import { US_CAPABILITY } from "@markiro/domain";
import { usTraceabilityAccessSchema } from "../src/traceability/access.js";

describe("US traceability presentation access contract", () => {
  it("accepts only a unique bounded list of known capabilities", () => {
    expect(usTraceabilityAccessSchema.parse({ capabilities: [US_CAPABILITY.READ] })).toEqual({
      capabilities: [US_CAPABILITY.READ],
    });
    expect(usTraceabilityAccessSchema.parse({ capabilities: [] })).toEqual({ capabilities: [] });

    for (const value of [
      { capabilities: [US_CAPABILITY.READ, US_CAPABILITY.READ] },
      { capabilities: ["traceability.unknown"] },
      { capabilities: Object.values(US_CAPABILITY).concat(US_CAPABILITY.READ) },
      { capabilities: [US_CAPABILITY.READ], roles: ["owner"] },
      { capabilities: [US_CAPABILITY.READ], tenantId: "tenant" },
      { capabilities: [US_CAPABILITY.READ], userId: "user" },
      { capabilities: [US_CAPABILITY.READ], sessionId: "session" },
    ]) {
      expect(usTraceabilityAccessSchema.safeParse(value).success).toBe(false);
    }
  });
});
