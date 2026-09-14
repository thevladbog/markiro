import { describe, expect, it } from "vitest";

import {
  platformServicePeriodContracts,
  servicePeriodRevisionSchema,
  serviceUsagePostSchema,
  tenantServicePeriodContracts,
} from "../src/index.js";

const id = "11111111-1111-4111-8111-111111111111";
const tenantId = "tenant-a";
const at = "2026-09-20T06:00:00.000Z";

describe("service period contracts", () => {
  it("validates usage input and reserves zero allowance for product defects", () => {
    const input = {
      requestId: id,
      expectedRevision: 3,
      classification: "customer_service",
      performedAt: at,
      actualMinutes: 45,
      allowanceMinutes: 45,
      workReference: "SUP-42",
      description: "Настройка интеграции",
      internalNote: null,
    } as const;

    expect(serviceUsagePostSchema.parse(input)).toEqual(input);
    expect(
      serviceUsagePostSchema.safeParse({
        ...input,
        classification: "product_defect",
        allowanceMinutes: 1,
      }).success,
    ).toBe(false);
    expect(servicePeriodRevisionSchema.safeParse(0).success).toBe(false);
  });

  it("keeps internal ledger facts out of the tenant detail", () => {
    const summary = {
      id,
      tenantId,
      orderedServiceId: id,
      catalogItemId: id,
      catalogVersionId: id,
      nameRu: "Сервисное сопровождение",
      nameEn: "Service support",
      startsAt: "2026-09-01T06:00:00.000Z",
      endsAt: "2026-10-01T06:00:00.000Z",
      state: "active",
      revision: 3,
      balance: { included: 180, externallyApproved: 0, consumed: 45, remaining: 135 },
    } as const;
    const entry = {
      id,
      kind: "usage",
      classification: "customer_service",
      originalEntryId: null,
      workReference: "SUP-42",
      description: "Настройка интеграции",
      performedAt: at,
      postedAt: at,
      actualMinutesDelta: 45,
      allowanceMinutesDelta: 45,
    } as const;
    const { tenantId: _tenantId, ...tenantSummary } = summary;
    void _tenantId;

    expect(
      tenantServicePeriodContracts.detail.response.parse({ ...tenantSummary, entries: [entry] }),
    ).toEqual({ ...tenantSummary, entries: [entry] });
    expect(
      tenantServicePeriodContracts.detail.response.safeParse({
        ...tenantSummary,
        entries: [{ ...entry, internalNote: "private" }],
      }).success,
    ).toBe(false);
    expect(
      platformServicePeriodContracts.detail.response.safeParse({ ...summary, entries: [entry] })
        .success,
    ).toBe(false);
  });

  it("allows a compensating entry to reclassify charged work as a product defect", () => {
    const correction = {
      id,
      kind: "correction",
      classification: "product_defect",
      originalEntryId: id,
      workReference: "SUP-42",
      description: "Работа переклассифицирована как дефект Маркиро",
      performedAt: at,
      postedAt: at,
      actualMinutesDelta: 0,
      allowanceMinutesDelta: -45,
    } as const;

    expect(
      tenantServicePeriodContracts.detail.response.shape.entries.element.parse(correction),
    ).toEqual(correction);
    expect(
      platformServicePeriodContracts.correctUsage.body.parse({
        requestId: id,
        expectedRevision: 3,
        classification: "product_defect",
        actualMinutesDelta: 0,
        allowanceMinutesDelta: -45,
        description: correction.description,
        internalNote: null,
      }),
    ).toMatchObject({ classification: "product_defect", allowanceMinutesDelta: -45 });
  });
});
