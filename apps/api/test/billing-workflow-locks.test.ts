import { describe, expect, it } from "vitest";

import {
  billingWorkflowResourceKeys,
  sortAndDedupeBillingLockIdentities,
} from "../src/modules/billing-workflow-locks";

describe("billing workflow lock identities", () => {
  it("uses one global identity for global unique resources across tenants", () => {
    const first = billingWorkflowResourceKeys("tenant-a", [
      { kind: "act_number", id: "ACT-42" },
      { kind: "payment_key", id: "00000000-0000-4000-8000-000000000042" },
      { kind: "invoice_number", id: "allocator" },
      { kind: "offer_number", id: "KP-2026-000042" },
      { kind: "request", id: "10000000-0000-4000-8000-000000000042" },
    ]);
    const second = billingWorkflowResourceKeys("tenant-b", [
      { kind: "act_number", id: "ACT-42" },
      { kind: "payment_key", id: "00000000-0000-4000-8000-000000000042" },
      { kind: "invoice_number", id: "allocator" },
      { kind: "offer_number", id: "KP-2026-000042" },
      { kind: "request", id: "10000000-0000-4000-8000-000000000042" },
    ]);

    expect(first.slice(0, 4)).toEqual(second.slice(0, 4));
    expect(first[4]).not.toBe(second[4]);
    expect(first).toEqual([...first].sort());
  });

  it("sorts signed physical identities and removes a deliberate hash collision", () => {
    expect(sortAndDedupeBillingLockIdentities([9n, -2n, 9n, 1n, -2n])).toEqual([-2n, 1n, 9n]);
  });
});
