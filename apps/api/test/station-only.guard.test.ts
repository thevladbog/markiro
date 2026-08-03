import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { StationOnlyGuard } from "../src/tenancy/station-only.guard";

function contextFor(authKind?: "session" | "station"): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ authKind }) }),
  } as unknown as ExecutionContext;
}

describe("StationOnlyGuard", () => {
  const guard = new StationOnlyGuard();

  it("allows station authentication without requiring a device id", () => {
    expect(guard.canActivate(contextFor("station"))).toBe(true);
  });

  it("rejects session authentication", () => {
    expect(() => guard.canActivate(contextFor("session"))).toThrow(ForbiddenException);
  });

  it("rejects a request with no authentication kind", () => {
    expect(() => guard.canActivate(contextFor())).toThrow(ForbiddenException);
  });
});
