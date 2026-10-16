import { describe, expect, it, vi } from "vitest";
import type {
  EntitlementCandidateFeatures,
  EntitlementSnapshotV1,
} from "@markiro/platform-contracts";
import {
  exportStandaloneRights,
  licenseValidity,
  MAX_LICENSE_TERM_MS,
  rightsReduce,
} from "../src/modules/standalone-licenses/standalone-license-rights";

const DAY = 86_400_000;
const AT = new Date("2026-10-20T09:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
type Limits = {
  lines: number | null;
  stations: number | null;
  kiosks: number | null;
  cabinetUsers: number | null;
};

function snapshot(input: {
  asOf?: Date;
  nextChangeAt?: Date | null;
  endsAt?: Date | null;
  limits?: Partial<Limits>;
  features?: Partial<EntitlementCandidateFeatures>;
}): EntitlementSnapshotV1 {
  const asOf = (input.asOf ?? AT).toISOString();
  const limits: Limits = { lines: 2, stations: 3, kiosks: 0, cabinetUsers: 5, ...input.limits };
  const quota = (limit: number | null) => ({ limit, used: 0, remaining: limit });
  const quotas = {
    lines: quota(limits.lines),
    stations: quota(limits.stations),
    kiosks: quota(limits.kiosks),
    cabinetUsers: quota(limits.cabinetUsers),
  };
  return {
    version: 1,
    tenantId: "tenant-a",
    asOf,
    countedAt: asOf,
    revision: "7",
    usageRevision: "1",
    nextChangeAt: input.nextChangeAt ? input.nextChangeAt.toISOString() : null,
    current: {
      access: "managed",
      writeAllowed: true,
      subscription: {
        id: "11111111-1111-4111-8111-111111111111",
        planVersionId: "22222222-2222-4222-8222-222222222222",
        status: "active",
        startsAt: "2026-01-01T00:00:00.000Z",
        endsAt:
          input.endsAt === undefined
            ? iso(AT.getTime() + 90 * DAY)
            : (input.endsAt?.toISOString() ?? null),
      },
      quotas,
      features: { labelEditor: true, publicApi: false, pallets: true },
    },
    candidate: {
      quotas,
      features: {
        labelEditor: true,
        publicApi: false,
        pallets: true,
        chzIntegration: null,
        inventory: true,
        commerceMl: false,
        handheld: true,
        customLogo: false,
        ...input.features,
      },
    },
    sources: [],
    readiness: { mode: "shadow", reasons: [] },
    historical: { available: false },
    connectivity: { observedAt: asOf, chz: "unknown", nationalCatalog: "unknown" },
  };
}

describe("exportStandaloneRights", () => {
  it("copies candidate limits with null as unlimited and exports a null feature as false, naming it", () => {
    expect(exportStandaloneRights(snapshot({ limits: { lines: null } }))).toEqual({
      rights: {
        quotas: { lines: null, stations: 3, kiosks: 0, cabinetUsers: 5 },
        features: {
          labelEditor: true,
          publicApi: false,
          pallets: true,
          chzIntegration: false,
          inventory: true,
          commerceMl: false,
          handheld: true,
          customLogo: false,
        },
      },
      unmapped: ["chzIntegration"],
    });
  });

  it("carries custom branding (customLogo) from a plan or an add-on, and names it when unmapped", () => {
    const granted = exportStandaloneRights(snapshot({ features: { customLogo: true } }));
    expect(granted.rights.features.customLogo).toBe(true);
    expect(granted.unmapped).toEqual(["chzIntegration"]);
    const unmapped = exportStandaloneRights(snapshot({ features: { customLogo: null } }));
    expect(unmapped.rights.features.customLogo).toBe(false);
    expect(unmapped.unmapped).toEqual(["chzIntegration", "customLogo"]);
  });
});

describe("rightsReduce", () => {
  const base = exportStandaloneRights(snapshot({})).rights;

  it("counts a lower limit, a newly limited quota and a switched-off feature as reductions", () => {
    expect(rightsReduce(base, { ...base, quotas: { ...base.quotas, stations: 2 } })).toBe(true);
    expect(rightsReduce({ ...base, quotas: { ...base.quotas, lines: null } }, base)).toBe(true);
    expect(rightsReduce(base, { ...base, features: { ...base.features, pallets: false } })).toBe(
      true,
    );
  });

  it("does not count a higher limit, a limit becoming unlimited, a feature switched on or no change", () => {
    expect(rightsReduce(base, { ...base, quotas: { ...base.quotas, stations: 4 } })).toBe(false);
    expect(rightsReduce(base, { ...base, quotas: { ...base.quotas, lines: null } })).toBe(false);
    expect(rightsReduce(base, { ...base, features: { ...base.features, publicApi: true } })).toBe(
      false,
    );
    expect(rightsReduce(base, base)).toBe(false);
  });
});

describe("licenseValidity (spec §6.2, plan Д5)", () => {
  it("ends at the subscription end when nothing shrinks before it", async () => {
    const endsAt = new Date(AT.getTime() + 90 * DAY);
    const snapshotAt = vi.fn();
    await expect(
      licenseValidity({ at: AT, first: snapshot({ endsAt }), snapshotAt }),
    ).resolves.toEqual({ validUntil: endsAt, reason: "subscription_end", boundaryAt: endsAt });
    expect(snapshotAt).not.toHaveBeenCalled();
  });

  it("caps an open-ended or multi-year subscription at one year without a time-bound boundary", async () => {
    for (const endsAt of [null, new Date(AT.getTime() + 800 * DAY)]) {
      await expect(
        licenseValidity({ at: AT, first: snapshot({ endsAt }), snapshotAt: vi.fn() }),
      ).resolves.toEqual({
        validUntil: new Date(AT.getTime() + MAX_LICENSE_TERM_MS),
        reason: "one_year_cap",
        boundaryAt: null,
      });
    }
  });

  it("skips increases and cuts at the first reduction", async () => {
    const growth = new Date(AT.getTime() + 10 * DAY);
    const shrink = new Date(AT.getTime() + 30 * DAY);
    const endsAt = new Date(AT.getTime() + 120 * DAY);
    const at = new Map([
      [
        growth.getTime(),
        snapshot({ asOf: growth, endsAt, nextChangeAt: shrink, limits: { stations: 5 } }),
      ],
      [
        shrink.getTime(),
        snapshot({ asOf: shrink, endsAt, nextChangeAt: endsAt, limits: { stations: 4 } }),
      ],
    ]);
    const snapshotAt = vi.fn(async (when: Date) => {
      const found = at.get(when.getTime());
      if (!found) throw new Error(`unexpected ${when.toISOString()}`);
      return found;
    });
    await expect(
      licenseValidity({ at: AT, first: snapshot({ endsAt, nextChangeAt: growth }), snapshotAt }),
    ).resolves.toEqual({ validUntil: shrink, reason: "entitlement_reduction", boundaryAt: shrink });
    expect(snapshotAt.mock.calls.map(([when]) => when.toISOString())).toEqual([
      growth.toISOString(),
      shrink.toISOString(),
    ]);
  });

  it("never evaluates a boundary at or after the subscription end", async () => {
    const endsAt = new Date(AT.getTime() + 20 * DAY);
    const snapshotAt = vi.fn();
    await expect(
      licenseValidity({ at: AT, first: snapshot({ endsAt, nextChangeAt: endsAt }), snapshotAt }),
    ).resolves.toEqual({ validUntil: endsAt, reason: "subscription_end", boundaryAt: endsAt });
    expect(snapshotAt).not.toHaveBeenCalled();
  });

  it("cuts at a boundary whose next change does not move forward instead of looping on it", async () => {
    const endsAt = new Date(AT.getTime() + 90 * DAY);
    const stuck = new Date(AT.getTime() + 5 * DAY);
    const snapshotAt = vi.fn(async () => snapshot({ asOf: stuck, endsAt, nextChangeAt: stuck }));
    await expect(
      licenseValidity({ at: AT, first: snapshot({ endsAt, nextChangeAt: stuck }), snapshotAt }),
    ).resolves.toEqual({ validUntil: stuck, reason: "entitlement_reduction", boundaryAt: stuck });
    expect(snapshotAt).toHaveBeenCalledTimes(1);
  });

  it("cuts conservatively at the boundary where it runs out of steps", async () => {
    const step = (n: number) => new Date(AT.getTime() + n * DAY);
    const snapshotAt = vi.fn(async (when: Date) =>
      snapshot({ asOf: when, nextChangeAt: new Date(when.getTime() + DAY) }),
    );
    await expect(
      licenseValidity({
        at: AT,
        first: snapshot({ nextChangeAt: step(1), endsAt: step(80) }),
        snapshotAt,
        maxSteps: 3,
      }),
    ).resolves.toEqual({
      validUntil: step(4),
      reason: "entitlement_reduction",
      boundaryAt: step(4),
    });
    expect(snapshotAt).toHaveBeenCalledTimes(3);
  });
});
