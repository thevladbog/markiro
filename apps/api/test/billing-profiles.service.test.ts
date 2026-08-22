import type { Db } from "@markiro/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BillingProfilesService } from "../src/modules/billing-profiles/billing-profiles.service";
import { BillingProfilesController } from "../src/modules/billing-profiles/billing-profiles.controller";
import type { OperatorBillingProfileInput } from "../src/modules/billing-profiles/dto";
import type { PlatformPrincipal } from "../src/platform-auth/platform-access-policy";
import type { PlatformAuditService } from "../src/platform-auth/platform-audit.service";

const actor: PlatformPrincipal = {
  userId: "platform-accountant",
  role: "accountant",
  capabilities: ["billing.read", "billing.write"],
  twoFactorReady: true,
};

const input = {
  kind: "legal_entity",
  fullName: "ООО Маркиро",
  displayName: "Маркиро",
  inn: "7700000000",
  kpp: "770001001",
  ogrn: "1027700000000",
  legalAddressRaw: "г Москва",
  legalAddress: { value: "г Москва", city: "Москва" },
  postalAddress: { sameAsLegal: true },
  contact: { name: "Бухгалтер", email: "billing@example.invalid", phone: null },
} as OperatorBillingProfileInput;

function operatorHarness() {
  const current = {
    id: "00000000-0000-4000-8000-000000000611",
    revision: 2,
    kind: "legal_entity",
    displayName: "Старое имя",
    isConfirmed: true,
  };
  const insertedValues: Array<Record<string, unknown>> = [];
  const updatedValues: Array<Record<string, unknown>> = [];
  const createdAt = new Date("2026-08-22T04:00:00.000Z");
  const created = {
    id: "00000000-0000-4000-8000-000000000612",
    revision: 3,
    isCurrent: true,
    ...input,
    postalSameAsLegal: true,
    postalAddressRaw: null,
    postalAddress: null,
    isConfirmed: true,
    confirmedByPlatformUserId: actor.userId,
    confirmedAt: createdAt,
    createdByPlatformUserId: actor.userId,
    createdAt,
  };
  const selectQuery = {
    from: vi.fn(() => selectQuery),
    where: vi.fn(() => selectQuery),
    limit: vi.fn(async () => [current]),
  };
  const tx = {
    select: vi.fn(() => selectQuery),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updatedValues.push(values);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        insertedValues.push(values);
        return { returning: vi.fn(async () => [created]) };
      }),
    })),
  };
  const db = {
    transaction: vi.fn(async (run: (executor: typeof tx) => Promise<unknown>) => run(tx)),
  } as unknown as Db;
  const audit = { record: vi.fn(async () => undefined) } as unknown as PlatformAuditService;
  return {
    service: new BillingProfilesService(db, audit),
    tx,
    audit,
    insertedValues,
    updatedValues,
    created,
  };
}

describe("BillingProfilesService", () => {
  afterEach(() => vi.useRealTimers());

  it("normalizes legacy contact JSON before validating operator and tenant responses", async () => {
    const createdAt = new Date("2026-08-22T04:00:00.000Z");
    const profiles = [
      {
        id: "00000000-0000-4000-8000-000000000613",
        kind: "legal_entity",
        fullName: "ООО Маркиро",
        displayName: "Маркиро",
        inn: "7700000000",
        kpp: "770001001",
        ogrn: "1027700000000",
        ogrnip: null,
        legalAddressRaw: "г Москва",
        legalAddress: null,
        postalSameAsLegal: true,
        postalAddressRaw: null,
        postalAddress: null,
        contact: {
          legacy: "preserved in storage",
          name: " Бухгалтерия ",
          email: "not-an-email",
          phone: " +7 999 000-00-00 ",
        },
        revision: 1,
        isCurrent: true,
        isConfirmed: false,
        confirmedByPlatformUserId: null,
        confirmedAt: null,
        createdByPlatformUserId: actor.userId,
        createdAt,
      },
      {
        id: "00000000-0000-4000-8000-000000000614",
        tenantId: "tenant-1",
        kind: "individual",
        fullName: "Иванов Иван Иванович",
        displayName: "Иванов И. И.",
        inn: null,
        kpp: null,
        ogrn: null,
        ogrnip: null,
        legalAddressRaw: "г Казань",
        legalAddress: null,
        postalSameAsLegal: true,
        postalAddressRaw: null,
        postalAddress: null,
        contact: {},
        revision: 1,
        isCurrent: true,
        isConfirmed: false,
        confirmedByPlatformUserId: null,
        confirmedAt: null,
        createdByPlatformUserId: actor.userId,
        createdAt,
      },
    ];
    const selectQuery = {
      from: vi.fn(() => selectQuery),
      where: vi.fn(() => selectQuery),
      limit: vi.fn(async () => [profiles.shift()]),
    };
    const db = { select: vi.fn(() => selectQuery) } as unknown as Db;
    const audit = { record: vi.fn() } as unknown as PlatformAuditService;
    const controller = new BillingProfilesController(new BillingProfilesService(db, audit));

    await expect(controller.getOperator()).resolves.toMatchObject({
      contact: { name: "Бухгалтерия", email: null, phone: "+7 999 000-00-00" },
    });
    await expect(controller.getTenant("tenant-1")).resolves.toMatchObject({
      contact: { name: null, email: null, phone: null },
    });
  });

  it("creates a confirmed append-only operator revision with exact bounded audit metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-22T04:00:00.000Z");
    const { service, tx, audit, insertedValues, updatedValues, created } = operatorHarness();

    const result = await service.setOperator(actor, input);

    expect(updatedValues).toEqual([{ isCurrent: false }]);
    expect(insertedValues).toEqual([
      expect.objectContaining({
        revision: 3,
        fullName: "ООО Маркиро",
        legalAddressRaw: "г Москва",
        legalAddress: { value: "г Москва", city: "Москва" },
        postalSameAsLegal: true,
        postalAddressRaw: null,
        postalAddress: null,
        isConfirmed: true,
        confirmedByPlatformUserId: actor.userId,
        confirmedAt: new Date("2026-08-22T04:00:00.000Z"),
        addressRaw: "г Москва",
        address: { value: "г Москва", city: "Москва" },
      }),
    ]);
    expect(audit.record).toHaveBeenCalledWith(tx, {
      actorPlatformUserId: actor.userId,
      actorRole: "accountant",
      action: "billing.operator_profile.revised",
      outcome: "success",
      tenantId: null,
      targetType: "operator_billing_profile",
      targetId: created.id,
      reason: null,
      before: {
        revision: 2,
        kind: "legal_entity",
        displayName: "Старое имя",
        confirmed: true,
      },
      after: {
        revision: 3,
        kind: "legal_entity",
        displayName: "Маркиро",
        confirmed: true,
      },
      requestId: null,
    });
    expect(result).toEqual(created);
  });

  it("rejects an impossible non-legal-entity operator profile at the response boundary", async () => {
    const service = {
      getOperator: vi.fn(async () => ({
        id: "00000000-0000-4000-8000-000000000613",
        kind: "individual",
        fullName: "Иванов Иван Иванович",
        displayName: "Иванов И. И.",
        inn: null,
        kpp: null,
        ogrn: null,
        ogrnip: null,
        legalAddressRaw: "г Москва",
        legalAddress: null,
        postalSameAsLegal: true,
        postalAddressRaw: null,
        postalAddress: null,
        contact: null,
        revision: 1,
        isCurrent: true,
        isConfirmed: false,
        confirmedByPlatformUserId: null,
        confirmedAt: null,
        createdByPlatformUserId: actor.userId,
        createdAt: new Date("2026-08-22T04:00:00.000Z"),
      })),
    } as unknown as BillingProfilesService;
    const controller = new BillingProfilesController(service);

    await expect(controller.getOperator()).rejects.toThrow();
  });
});
