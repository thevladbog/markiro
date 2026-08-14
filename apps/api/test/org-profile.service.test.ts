import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RasterImageInputError,
  RasterImageProcessingError,
} from "../src/modules/profile/raster-image-processor";

const processLogo = vi.hoisted(() => vi.fn());

vi.mock("../src/modules/org-profile/logo-processor", () => ({ processLogo }));

import { OrgProfileService } from "../src/modules/org-profile/org-profile.service";

describe("OrgProfileService logo processing errors", () => {
  beforeEach(() => processLogo.mockReset());

  it("maps invalid raster input to a 400 without touching persistence", async () => {
    processLogo.mockRejectedValueOnce(new RasterImageInputError("Logo dimensions are invalid"));
    const db = { insert: vi.fn() };
    const service = new OrgProfileService(db as never, {} as never);

    const error = await caught(service.uploadLogo("tenant", "actor", Buffer.from("bad")));

    expect(error).toBeInstanceOf(BadRequestException);
    if (!(error instanceof BadRequestException)) throw error;
    expect(error.getStatus()).toBe(400);
    expect(error.message).toBe("Logo dimensions are invalid");
    expect(db.insert).not.toHaveBeenCalled();
  });

  it.each([
    new RasterImageProcessingError("Logo processing capacity is unavailable"),
    new Error("Unexpected worker startup failure"),
  ])("maps transient processing failure to 503 without touching persistence", async (error) => {
    processLogo.mockRejectedValueOnce(error);
    const db = { insert: vi.fn() };
    const service = new OrgProfileService(db as never, {} as never);

    const rejection = await caught(service.uploadLogo("tenant", "actor", Buffer.from("valid")));

    expect(rejection).toBeInstanceOf(ServiceUnavailableException);
    if (!(rejection instanceof ServiceUnavailableException)) throw rejection;
    expect(rejection.getStatus()).toBe(503);
    expect(rejection.message).toBe("Logo processing is unavailable");
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("OrgProfileService box label defaults", () => {
  const emptyProfile = {
    gln: null,
    gs1Prefixes: [],
    inn: null,
    defaultBoxLabelTemplateId: null,
    pickupLimitsEnabled: true,
    logoRevision: null,
    logoUrl: null,
  };

  it("returns a null box label default when no default is stored", async () => {
    const rows = [{ limitsEnabled: true }];
    const result = Object.assign(Promise.resolve(rows), { limit: () => result });
    const select = vi.fn(() => ({
      from: () => ({
        where: () => result,
        innerJoin: () => ({ where: () => result }),
      }),
    }));
    const service = new OrgProfileService({ select } as never, {} as never);

    await expect(service.getProfile("tenant-a")).resolves.toEqual(emptyProfile);
  });

  it.each([
    ["writes a supplied UUID", "a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000001"],
    ["clears on explicit null", null, null],
  ])("%s", async (_name, supplied, expected) => {
    const { db, onConflictDoUpdate, values } = profileUpsertDb();
    const service = new OrgProfileService(db as never, {} as never);
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
    const service = new OrgProfileService(db as never, {} as never);
    vi.spyOn(service, "getProfile").mockResolvedValue({
      ...emptyProfile,
      defaultBoxLabelTemplateId: "a0000000-0000-4000-8000-000000000001",
    });

    await service.upsertProfile("tenant-a", "actor-a", { inn: "7701234567" });

    expect(values.mock.calls[0]?.[0]).not.toHaveProperty("defaultBoxLabelTemplateId");
    const conflict = onConflictDoUpdate.mock.calls[0]?.[0] as { set: Record<string, unknown> };
    expect(conflict.set).not.toHaveProperty("defaultBoxLabelTemplateId");
  });

  it("maps a foreign template FK violation to a bounded 400 without fetching a partial profile", async () => {
    const foreignKey = Object.assign(new Error("foreign key leak"), {
      code: "23503",
      constraint: "org_profiles_box_label_template_tenant_fk",
    });
    const { db } = profileUpsertDb(foreignKey);
    const service = new OrgProfileService(db as never, {} as never);
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

function profileUpsertDb(error?: Error): {
  db: { transaction: (callback: (tx: unknown) => Promise<void>) => Promise<void> };
  values: ReturnType<typeof vi.fn>;
  onConflictDoUpdate: ReturnType<typeof vi.fn>;
} {
  const onConflictDoUpdate = vi.fn().mockImplementation(async () => {
    if (error) throw error;
  });
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const tx = { insert: vi.fn(() => ({ values })) };
  return {
    db: { transaction: async (callback) => callback(tx) },
    values,
    onConflictDoUpdate,
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    return error;
  }
}
