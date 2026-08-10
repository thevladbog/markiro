import { type ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import {
  AllowSubscriptionRecovery,
  RequireFeature,
  RequireSubscriptionWrite,
} from "../src/subscriptions/subscription-access-policy";
import type { EffectiveEntitlements } from "../src/subscriptions/entitlements.types";

class PolicyController {
  unclassified(): void {}

  @RequireSubscriptionWrite()
  write(): void {}

  @RequireFeature("labelEditor")
  feature(): void {}

  @AllowSubscriptionRecovery("station")
  recovery(): void {}
}

interface FakeRequest {
  method: string;
  tenantId?: string;
}

function contextFor(request: FakeRequest, handler: () => void): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => PolicyController,
  } as unknown as ExecutionContext;
}

const unclassifiedHandler = PolicyController.prototype.unclassified;
const writeHandler = PolicyController.prototype.write;
const featureHandler = PolicyController.prototype.feature;
const recoveryHandler = PolicyController.prototype.recovery;

function entitlements(
  access: EffectiveEntitlements["access"],
  features: EffectiveEntitlements["features"] = {
    labelEditor: true,
    publicApi: true,
    pallets: true,
  },
): EffectiveEntitlements {
  return {
    tenantId: "tenant_1",
    access,
    subscription:
      access === "unmanaged"
        ? null
        : {
            id: "subscription_1",
            planVersionId: "plan_1",
            status: access === "managed" ? "active" : "expired",
            startsAt: new Date("2026-08-01T00:00:00.000Z"),
            endsAt: new Date("2026-08-02T00:00:00.000Z"),
          },
    quotas: { lines: 1, stations: 1, kiosks: 1, cabinetUsers: 1 },
    features,
  };
}

describe("SubscriptionAccessGuard", () => {
  let service: { resolve: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    service = { resolve: vi.fn() };
  });

  function guard(mode: "managed_only" | "all" = "managed_only"): SubscriptionAccessGuard {
    return new SubscriptionAccessGuard(
      new Reflector(),
      service as unknown as EntitlementsService,
      mode,
    );
  }

  it("fails closed when a covered mutation has no explicit policy", async () => {
    const error = await guard()
      .canActivate(contextFor({ method: "POST", tenantId: "tenant_1" }, unclassifiedHandler))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toEqual({
      code: "subscription_policy_missing",
    });
    expect(service.resolve).not.toHaveBeenCalled();
  });

  it("does not classify safe reads as subscription writes", async () => {
    await expect(
      guard().canActivate(contextFor({ method: "GET", tenantId: "tenant_1" }, unclassifiedHandler)),
    ).resolves.toBe(true);
    expect(service.resolve).not.toHaveBeenCalled();
  });

  it("permits managed writes and rejects request-time expiry with the exact public shape", async () => {
    service.resolve
      .mockResolvedValueOnce(entitlements("managed"))
      .mockResolvedValueOnce(entitlements("read_only"));
    await expect(
      guard().canActivate(contextFor({ method: "POST", tenantId: "tenant_1" }, writeHandler)),
    ).resolves.toBe(true);

    const error = await guard()
      .canActivate(contextFor({ method: "POST", tenantId: "tenant_1" }, writeHandler))
      .catch((caught: unknown) => caught);
    expect((error as ForbiddenException).getResponse()).toEqual({ code: "subscription_read_only" });
  });

  it("reports a disabled feature without prices or subscription internals", async () => {
    service.resolve.mockResolvedValue(
      entitlements("managed", { labelEditor: false, publicApi: true, pallets: false }),
    );
    const error = await guard()
      .canActivate(contextFor({ method: "POST", tenantId: "tenant_1" }, featureHandler))
      .catch((caught: unknown) => caught);
    expect((error as ForbiddenException).getResponse()).toEqual({
      code: "subscription_feature_disabled",
      entitlement: "labelEditor",
    });
  });

  it("preserves managed-only rollout for unmanaged tenants and fails closed in all mode", async () => {
    service.resolve.mockResolvedValue(entitlements("unmanaged"));
    await expect(
      guard("managed_only").canActivate(
        contextFor({ method: "POST", tenantId: "tenant_1" }, writeHandler),
      ),
    ).resolves.toBe(true);

    const error = await guard("all")
      .canActivate(contextFor({ method: "POST", tenantId: "tenant_1" }, writeHandler))
      .catch((caught: unknown) => caught);
    expect((error as ForbiddenException).getResponse()).toEqual({ code: "subscription_unmanaged" });
  });

  it("defers explicitly classified recovery to its authoritative service boundary", async () => {
    service.resolve.mockResolvedValue(entitlements("read_only"));
    await expect(
      guard().canActivate(contextFor({ method: "POST", tenantId: "tenant_1" }, recoveryHandler)),
    ).resolves.toBe(true);
  });
});
