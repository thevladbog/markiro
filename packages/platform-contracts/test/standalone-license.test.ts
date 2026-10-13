import { describe, expect, expectTypeOf, it } from "vitest";

import activation from "../../domain/fixtures/standalone-license/activation-request.json" with { type: "json" };
import * as c from "../src/index.js";

describe("standalone license contracts", () => {
  it("name exactly the cloud's quota and feature keys, in their order", () => {
    expect(c.STANDALONE_QUOTA_KEYS).toEqual(c.ENTITLEMENT_QUOTA_KEYS);
    expect(c.STANDALONE_FEATURE_KEYS).toEqual(c.ENTITLEMENT_FEATURE_KEYS);
    expectTypeOf<c.StandaloneQuotaKey>().toEqualTypeOf<c.EntitlementQuotaKey>();
    expectTypeOf<c.StandaloneFeatureKey>().toEqualTypeOf<c.EntitlementFeatureKey>();
  });

  it("read the host's activation request and keep the documents' typ apart", () => {
    expect(c.standaloneActivationRequestSchema.parse(activation)).toEqual(activation);
    expect(c.STANDALONE_LICENSE_TYP).not.toBe(c.STANDALONE_UPDATE_TYP);
    expect(c.standaloneLicensePayloadV1Schema.safeParse({}).success).toBe(false);
    expect(c.standaloneUpdateManifestV1Schema.safeParse({}).success).toBe(false);
  });

  it("re-export the opaque tenant and site id rule the cloud signs with", () => {
    expect(c.STANDALONE_OPAQUE_ID_PATTERN.test("Zq4bL0x9cabinetTenant01")).toBe(true);
    expect(c.standaloneOpaqueIdSchema.safeParse("tenant/1").success).toBe(false);
  });
});
