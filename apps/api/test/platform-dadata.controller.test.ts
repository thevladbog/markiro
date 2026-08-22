import { PLATFORM_ACCESS_POLICY } from "../src/platform-auth/platform-access-policy";
import { PlatformDadataController } from "../src/modules/platform-dadata/platform-dadata.controller";
import type { PlatformDadataRateLimit } from "../src/modules/platform-dadata/platform-dadata-rate-limit";
import type { PlatformDadataService } from "../src/modules/platform-dadata/platform-dadata.service";
import { dadataSuggestionQuerySchema } from "../src/modules/platform-dadata/dto";
import { describe, expect, it, vi } from "vitest";

const request = {
  platformPrincipal: {
    userId: "platform-accountant",
    role: "accountant",
    capabilities: ["billing.read", "billing.write"],
    twoFactorReady: true,
  },
} as never;

describe("PlatformDadataController", () => {
  it("validates bounded normalized queries before provider calls", () => {
    expect(dadataSuggestionQuerySchema.safeParse({ q: "  Москва   Тверская " })).toMatchObject({
      success: true,
      data: { q: "Москва Тверская" },
    });
    expect(dadataSuggestionQuerySchema.safeParse({ q: "мо" }).success).toBe(false);
    expect(dadataSuggestionQuerySchema.safeParse({ q: "м".repeat(301) }).success).toBe(false);
  });

  it("preserves graceful client statuses and rejects raw provider response fields", async () => {
    const service = {
      organizations: vi.fn(async () => ({ status: "unconfigured", items: [] })),
      addresses: vi.fn(async () => ({ status: "unavailable", items: [] })),
      banks: vi.fn(async () => ({
        status: "ready",
        items: [
          {
            value: "ПАО Сбербанк",
            bic: "044525225",
            bankName: "ПАО Сбербанк",
            correspondentAccount: "30101810400000000225",
            rawProviderData: { hid: "must-not-survive" },
          },
        ],
      })),
      status: vi.fn(() => ({ status: "unconfigured" })),
    } as unknown as PlatformDadataService;
    const limiter = { consume: vi.fn() } as unknown as PlatformDadataRateLimit;
    const controller = new PlatformDadataController(service, limiter);

    await expect(controller.organizations(request, { q: "Ромашка" })).resolves.toEqual({
      status: "unconfigured",
      items: [],
    });
    await expect(controller.addresses(request, { q: "Москва" })).resolves.toEqual({
      status: "unavailable",
      items: [],
    });
    await expect(controller.banks(request, { q: "Сбербанк" })).rejects.toThrow();
    expect(controller.status()).toEqual({ status: "unconfigured" });
    expect(limiter.consume).toHaveBeenCalledTimes(3);
  });

  it("requires billing reads for suggestions but allows any authenticated platform role to read status", () => {
    const prototype = PlatformDadataController.prototype;
    expect(Reflect.getMetadata(PLATFORM_ACCESS_POLICY, prototype.organizations)).toEqual({
      mode: "capabilities",
      capabilities: ["billing.read"],
    });
    expect(Reflect.getMetadata(PLATFORM_ACCESS_POLICY, prototype.addresses)).toEqual({
      mode: "capabilities",
      capabilities: ["billing.read"],
    });
    expect(Reflect.getMetadata(PLATFORM_ACCESS_POLICY, prototype.banks)).toEqual({
      mode: "capabilities",
      capabilities: ["billing.read"],
    });
    expect(Reflect.getMetadata(PLATFORM_ACCESS_POLICY, prototype.status)).toEqual({
      mode: "capabilities",
      capabilities: [],
    });
  });
});
