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

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    return error;
  }
}
