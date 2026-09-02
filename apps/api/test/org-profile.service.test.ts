import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import type { schema } from "@markiro/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RasterImageInputError,
  RasterImageProcessingError,
} from "../src/modules/profile/raster-image-processor";

const processLogo = vi.hoisted(() => vi.fn());

vi.mock("../src/modules/org-profile/logo-processor", () => ({ processLogo }));

import {
  OrgProfileService,
  type OrgProfileDatabase,
  type OrgProfileSscc,
  type OrgProfileStorage,
} from "../src/modules/org-profile/org-profile.service";

describe("OrgProfileService logo processing errors", () => {
  beforeEach(() => processLogo.mockReset());

  it("maps invalid raster input to a 400 without touching persistence", async () => {
    processLogo.mockRejectedValueOnce(new RasterImageInputError("Logo dimensions are invalid"));
    const insert = vi.fn();
    const service = profileService(profileDatabase({ insert }));

    const error = await caught(service.uploadLogo("tenant", "actor", Buffer.from("bad")));

    expect(error).toBeInstanceOf(BadRequestException);
    if (!(error instanceof BadRequestException)) throw error;
    expect(error.getStatus()).toBe(400);
    expect(error.message).toBe("Logo dimensions are invalid");
    expect(insert).not.toHaveBeenCalled();
  });

  it.each([
    new RasterImageProcessingError("Logo processing capacity is unavailable"),
    new Error("Unexpected worker startup failure"),
  ])("maps transient processing failure to 503 without touching persistence", async (error) => {
    processLogo.mockRejectedValueOnce(error);
    const insert = vi.fn();
    const service = profileService(profileDatabase({ insert }));

    const rejection = await caught(service.uploadLogo("tenant", "actor", Buffer.from("valid")));

    expect(rejection).toBeInstanceOf(ServiceUnavailableException);
    if (!(rejection instanceof ServiceUnavailableException)) throw rejection;
    expect(rejection.getStatus()).toBe(503);
    expect(rejection.message).toBe("Logo processing is unavailable");
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("OrgProfileService box label defaults", () => {
  const emptyProfile = {
    gln: null,
    gs1Prefixes: [],
    inn: null,
    timeZone: "Europe/Moscow",
    defaultBoxLabelTemplateId: null,
    categoryBoxLabelTemplateDefaults: [],
    productGroupsInUse: [],
    pickupLimitsEnabled: true,
    logoRevision: null,
    logoUrl: null,
  };

  it("returns a null box label default when no default is stored", async () => {
    const service = profileService(profileReadDatabase([[], [{ limitsEnabled: true }], []]));

    await expect(service.getProfile("tenant-a")).resolves.toEqual(emptyProfile);
  });

  it("returns the persisted operational timezone", async () => {
    const queryResults = [[{ timeZone: "Asia/Irkutsk" }], [{ limitsEnabled: true }], []];
    const service = profileService(profileReadDatabase(queryResults));

    await expect(service.getProfile("tenant-a")).resolves.toMatchObject({
      timeZone: "Asia/Irkutsk",
    });
  });

  it.each([
    [
      "writes a supplied UUID",
      "a0000000-0000-4000-8000-000000000001",
      "a0000000-0000-4000-8000-000000000001",
    ],
    ["clears on explicit null", null, null],
  ])("%s", async (_name, supplied, expected) => {
    const { db, onConflictDoUpdate, values } = profileUpsertDb();
    const service = profileService(db);
    vi.spyOn(service, "getProfile").mockResolvedValue({
      ...emptyProfile,
      defaultBoxLabelTemplateId: expected,
    });

    await expect(
      service.upsertProfile("tenant-a", "actor-a", { defaultBoxLabelTemplateId: supplied }),
    ).resolves.toMatchObject({ defaultBoxLabelTemplateId: expected });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ defaultBoxLabelTemplateId: expected }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ defaultBoxLabelTemplateId: expected }),
      }),
    );
  });

  it("leaves the box label default untouched when omitted", async () => {
    const { db, onConflictDoUpdate, values } = profileUpsertDb();
    const service = profileService(db);
    vi.spyOn(service, "getProfile").mockResolvedValue({
      ...emptyProfile,
      defaultBoxLabelTemplateId: "a0000000-0000-4000-8000-000000000001",
    });

    await service.upsertProfile("tenant-a", "actor-a", { inn: "7701234567" });

    expect(values.mock.calls[0]?.[0]).not.toHaveProperty("defaultBoxLabelTemplateId");
    const conflict = onConflictDoUpdate.mock.calls[0]?.[0];
    expect(conflict).toBeDefined();
    if (!conflict) throw new Error("Expected profile conflict update");
    expect(conflict.set).not.toHaveProperty("defaultBoxLabelTemplateId");
  });

  it("writes a supplied operational timezone on insert and conflict update", async () => {
    const { db, onConflictDoUpdate, values } = profileUpsertDb();
    const service = profileService(db);
    vi.spyOn(service, "getProfile").mockResolvedValue({
      ...emptyProfile,
      timeZone: "Asia/Irkutsk",
    });

    await service.upsertProfile("tenant-a", "actor-a", { timeZone: "Asia/Irkutsk" });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ timeZone: "Asia/Irkutsk" }));
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ set: expect.objectContaining({ timeZone: "Asia/Irkutsk" }) }),
    );
  });

  it("leaves the stored operational timezone untouched when omitted", async () => {
    const { db, onConflictDoUpdate } = profileUpsertDb();
    const service = profileService(db);
    vi.spyOn(service, "getProfile").mockResolvedValue(emptyProfile);

    await service.upsertProfile("tenant-a", "actor-a", { inn: "7701234567" });

    const conflict = onConflictDoUpdate.mock.calls[0]?.[0];
    expect(conflict).toBeDefined();
    if (!conflict) throw new Error("Expected profile conflict update");
    expect(conflict.set).not.toHaveProperty("timeZone");
  });

  it("maps a foreign template FK violation to a bounded 400 without fetching a partial profile", async () => {
    const foreignKey = Object.assign(new Error("foreign key leak"), {
      code: "23503",
      constraint: "org_profiles_box_label_template_tenant_fk",
    });
    const { db } = profileUpsertDb(foreignKey);
    const service = profileService(db);
    const getProfile = vi.spyOn(service, "getProfile");

    const rejection = await caught(
      service.upsertProfile("tenant-a", "actor-a", {
        defaultBoxLabelTemplateId: "a0000000-0000-4000-8000-000000000001",
      }),
    );

    expect(rejection).toBeInstanceOf(BadRequestException);
    if (!(rejection instanceof BadRequestException)) throw rejection;
    expect(rejection.message).toBe("Unknown box label template for this organization");
    expect(getProfile).not.toHaveBeenCalled();
  });
});

type ProfileInsert = typeof schema.orgProfiles.$inferInsert;
type ProfileConflictUpdate = {
  target: unknown;
  set: Partial<ProfileInsert> & { updatedAt: Date };
};

interface ProfileDatabaseOverrides {
  select?: () => unknown;
  insert?: (...args: unknown[]) => unknown;
  transaction?: (callback: (tx: OrgProfileDatabase) => Promise<unknown>) => Promise<unknown>;
}

function profileDatabase(overrides: ProfileDatabaseOverrides = {}): OrgProfileDatabase {
  const unavailable = (): never => {
    throw new Error("Unexpected database operation in OrgProfileService test");
  };
  const target = {
    select: unavailable,
    insert: unavailable,
    transaction: unavailable,
    update: unavailable,
    delete: unavailable,
  } satisfies OrgProfileDatabase;

  return new Proxy(target, {
    get(current, property, receiver) {
      if (property === "select" && overrides.select) return overrides.select;
      if (property === "insert" && overrides.insert) return overrides.insert;
      if (property === "transaction" && overrides.transaction) return overrides.transaction;
      return Reflect.get(current, property, receiver);
    },
  });
}

function profileReadDatabase(queryResults: unknown[][]): OrgProfileDatabase {
  const remaining = [...queryResults];
  const select = vi.fn(() => {
    const rows = remaining.shift() ?? [];
    const result = Object.assign(Promise.resolve(rows), {
      limit: () => result,
      orderBy: () => result,
      groupBy: () => result,
    });
    return {
      from: () => ({
        where: () => result,
        innerJoin: () => ({ where: () => result }),
      }),
    };
  });
  return profileDatabase({ select });
}

/** The template rows the transaction's eligibility lookup (`select … for share`) answers with. */
const ELIGIBLE_TEMPLATE = {
  id: "a0000000-0000-4000-8000-000000000001",
  enabled: true,
  chzProductGroupCodes: null,
};

function profileUpsertDb(
  error?: Error,
  templates: Array<typeof ELIGIBLE_TEMPLATE> = [ELIGIBLE_TEMPLATE],
): {
  db: OrgProfileDatabase;
  values: ReturnType<typeof vi.fn<(profile: ProfileInsert) => unknown>>;
  onConflictDoUpdate: ReturnType<typeof vi.fn<(input: ProfileConflictUpdate) => Promise<void>>>;
} {
  const onConflictDoUpdate = vi.fn<(input: ProfileConflictUpdate) => Promise<void>>(async () => {
    if (error) throw error;
  });
  const values = vi.fn<
    (profile: ProfileInsert) => { onConflictDoUpdate: typeof onConflictDoUpdate }
  >(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  const select = vi.fn(() => ({
    from: () => ({ where: () => ({ for: async () => templates }) }),
  }));
  const tx = profileDatabase({ insert, select });
  return {
    db: profileDatabase({ transaction: async (callback) => callback(tx) }),
    values,
    onConflictDoUpdate,
  };
}

const unusedStorage: OrgProfileStorage = {
  put(): never {
    throw new Error("Unexpected storage put in OrgProfileService test");
  },
  get(): never {
    throw new Error("Unexpected storage get in OrgProfileService test");
  },
  delete(): never {
    throw new Error("Unexpected storage delete in OrgProfileService test");
  },
};

const unusedSscc: OrgProfileSscc = {
  counterState(): never {
    throw new Error("Unexpected SSCC read in OrgProfileService test");
  },
  seedCounter(): never {
    throw new Error("Unexpected SSCC write in OrgProfileService test");
  },
};

function profileService(db: OrgProfileDatabase): OrgProfileService {
  return new OrgProfileService(db, unusedStorage, unusedSscc);
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    return error;
  }
}
