import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KioskBrandingDto, KioskBootstrapDto } from "../src/api/types.js";
import {
  invalidateCachedBranding,
  loadCachedBranding,
  refreshCachedBranding,
  shouldActivateBranding,
  type BrandingOwner,
} from "../src/store/branding.js";
import { replaceSnapshot } from "../src/store/cache.js";
import { writeConfig } from "../src/store/config.js";

const SERVER = "https://kiosk.example";
const REV_1 = "11111111-1111-4111-8111-111111111111";
const REV_2 = "22222222-2222-4222-8222-222222222222";
const OWNER: BrandingOwner = {
  serverUrl: SERVER,
  kioskId: "kiosk-1",
  credentialGeneration: "33333333-3333-4333-8333-333333333333",
};

function bootstrap(branding: KioskBrandingDto): KioskBootstrapDto {
  return {
    generatedAt: "2026-08-13T08:00:00.000Z",
    subscription: {
      access: "managed",
      status: "active",
      startsAt: null,
      endsAt: null,
    },
    branding,
    pickupPolicy: { limitsEnabled: false },
    config: { dayLimitPerEmployee: 0, showPrices: false },
    badgeSalt: "c2FsdA==",
    reasons: [],
    products: [],
    employees: [],
    operators: [],
  };
}

async function seedBinding(branding: KioskBrandingDto): Promise<BrandingOwner> {
  await replaceSnapshot(bootstrap(branding), new Date("2026-08-13T08:00:01.000Z"));
  const config = await writeConfig({
    serverUrl: SERVER,
    token: "private-token",
    kioskId: "kiosk-1",
    kioskName: "Gate",
    place: null,
    nextDeviceSeq: 0,
  });
  return {
    serverUrl: config.serverUrl,
    kioskId: config.kioskId!,
    credentialGeneration: config.credentialGeneration!,
  };
}

describe("offline kiosk branding", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("uses the organisation name from bootstrap before any logo has been cached", async () => {
    await seedBinding({ organizationName: "Северная вода", logoUrl: null, logoRevision: null });

    await expect(loadCachedBranding()).resolves.toEqual({
      organizationName: "Северная вода",
      logoBlob: null,
      revision: null,
      owner: null,
    });
  });

  it("fetches a changed same-origin WebP privately and persists it for offline login", async () => {
    const owner = await seedBinding({
      organizationName: "Северная вода",
      logoUrl: `/kiosk/branding/logo/${REV_2}`,
      logoRevision: REV_2,
    });
    const logo = new Blob(["valid-webp"], { type: "image/webp" });
    const fetchLogo = vi.fn(
      async () => new Response(logo, { headers: { "Content-Type": "image/webp" } }),
    );

    await refreshCachedBranding({
      owner,
      token: "private-token",
      branding: bootstrap({
        organizationName: "Северная вода",
        logoUrl: `/kiosk/branding/logo/${REV_2}`,
        logoRevision: REV_2,
      }).branding,
      fetch: fetchLogo as typeof fetch,
      decode: async () => true,
    });

    expect(fetchLogo).toHaveBeenCalledWith(
      `https://kiosk.example/kiosk/branding/logo/${REV_2}`,
      expect.objectContaining({
        headers: expect.objectContaining({ "x-kiosk-token": "private-token" }),
      }),
    );
    await expect(loadCachedBranding()).resolves.toEqual({
      organizationName: "Северная вода",
      logoBlob: logo,
      revision: REV_2,
      owner,
    });
  });

  it("keeps the prior valid blob when a refresh fails or returns an undecodable image", async () => {
    const owner = await seedBinding({
      organizationName: "Северная вода",
      logoUrl: `/kiosk/branding/logo/${REV_1}`,
      logoRevision: REV_1,
    });
    const oldLogo = new Blob(["old"], { type: "image/webp" });
    await refreshCachedBranding({
      owner,
      token: "private-token",
      branding: {
        organizationName: "Северная вода",
        logoUrl: `/kiosk/branding/logo/${REV_1}`,
        logoRevision: REV_1,
      },
      fetch: vi.fn(
        async () => new Response(oldLogo, { headers: { "Content-Type": "image/webp" } }),
      ) as typeof fetch,
      decode: async () => true,
    });
    await replaceSnapshot(
      bootstrap({
        organizationName: "Северная вода — новая",
        logoUrl: `/kiosk/branding/logo/${REV_2}`,
        logoRevision: REV_2,
      }),
      new Date("2026-08-13T08:01:00.000Z"),
    );

    await refreshCachedBranding({
      owner,
      token: "private-token",
      branding: {
        organizationName: "Северная вода — новая",
        logoUrl: `/kiosk/branding/logo/${REV_2}`,
        logoRevision: REV_2,
      },
      fetch: vi.fn(async () => {
        throw new TypeError("offline");
      }) as typeof fetch,
      decode: async () => true,
    });
    await refreshCachedBranding({
      owner,
      token: "private-token",
      branding: {
        organizationName: "Северная вода — новая",
        logoUrl: `/kiosk/branding/logo/${REV_2}`,
        logoRevision: REV_2,
      },
      fetch: vi.fn(
        async () => new Response("broken", { headers: { "Content-Type": "image/webp" } }),
      ) as typeof fetch,
      decode: async () => false,
    });

    await expect(loadCachedBranding()).resolves.toEqual({
      organizationName: "Северная вода — новая",
      logoBlob: oldLogo,
      revision: REV_1,
      owner,
    });
  });

  it("never requests a cross-origin logo and does not expose a previous binding's blob", async () => {
    const fetchLogo = vi.fn();
    await expect(
      refreshCachedBranding({
        owner: OWNER,
        token: "private-token",
        branding: {
          organizationName: "Новый tenant",
          logoUrl: "https://tracker.invalid/pixel.webp",
          logoRevision: "rev-x",
        },
        fetch: fetchLogo as typeof fetch,
        decode: async () => true,
      }),
    ).resolves.toMatchObject({
      applied: false,
      branding: { organizationName: "Новый tenant", logoBlob: null, revision: null, owner: null },
    });
    expect(fetchLogo).not.toHaveBeenCalled();
  });

  it("does not send the token to an arbitrary same-origin path and removes stale same-owner cache", async () => {
    const owner = await seedBinding({
      organizationName: "Северная вода",
      logoUrl: `/kiosk/branding/logo/${REV_1}`,
      logoRevision: REV_1,
    });
    await refreshCachedBranding({
      owner,
      token: "private-token",
      branding: {
        organizationName: "Северная вода",
        logoUrl: `/kiosk/branding/logo/${REV_1}`,
        logoRevision: REV_1,
      },
      fetch: vi.fn(
        async () => new Response("old", { headers: { "Content-Type": "image/webp" } }),
      ) as typeof fetch,
      decode: async () => true,
    });
    const fetchLogo = vi.fn();

    await refreshCachedBranding({
      owner,
      token: "private-token",
      branding: {
        organizationName: "Северная вода",
        logoUrl: "/kiosk/orders",
        logoRevision: REV_2,
      },
      fetch: fetchLogo as typeof fetch,
      decode: async () => true,
    });

    expect(fetchLogo).not.toHaveBeenCalled();
    expect((await loadCachedBranding()).logoBlob).toBeNull();
  });

  it("bounds a chunked logo body even when content-length is missing or lying", async () => {
    const owner = await seedBinding({
      organizationName: "Северная вода",
      logoUrl: `/kiosk/branding/logo/${REV_2}`,
      logoRevision: REV_2,
    });
    let cancelled = false;
    const chunks = [new Uint8Array(1024 * 1024), new Uint8Array(1024 * 1024), new Uint8Array(1)];
    const reader = {
      read: vi.fn(async () => ({ done: false as const, value: chunks.shift()! })),
      cancel: vi.fn(async () => {
        cancelled = true;
      }),
      releaseLock: vi.fn(),
    };

    const result = await refreshCachedBranding({
      owner,
      token: "private-token",
      branding: {
        organizationName: "Северная вода",
        logoUrl: `/kiosk/branding/logo/${REV_2}`,
        logoRevision: REV_2,
      },
      fetch: vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers({ "Content-Type": "image/webp", "Content-Length": "8" }),
            body: { getReader: () => reader },
          }) as unknown as Response,
      ) as typeof fetch,
      decode: async () => true,
    });

    expect(result.branding.logoBlob).toBeNull();
    expect(cancelled).toBe(true);
  });

  it("rejects oversized declared length and wrong MIME before reading the body", async () => {
    const owner = await seedBinding({
      organizationName: "Северная вода",
      logoUrl: `/kiosk/branding/logo/${REV_2}`,
      logoRevision: REV_2,
    });
    const read = vi.fn();
    for (const headers of [
      { "Content-Type": "image/webp", "Content-Length": String(2 * 1024 * 1024 + 1) },
      { "Content-Type": "image/png", "Content-Length": "12" },
    ]) {
      await refreshCachedBranding({
        owner,
        token: "private-token",
        branding: {
          organizationName: "Северная вода",
          logoUrl: `/kiosk/branding/logo/${REV_2}`,
          logoRevision: REV_2,
        },
        fetch: vi.fn(
          async () =>
            ({
              ok: true,
              status: 200,
              headers: new Headers(headers),
              body: { getReader: () => ({ read, cancel: vi.fn(), releaseLock: vi.fn() }) },
            }) as unknown as Response,
        ) as typeof fetch,
        decode: async () => true,
      });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("retains the prior valid logo for a valid route when network or 5xx fails", async () => {
    const owner = await seedBinding({
      organizationName: "Северная вода",
      logoUrl: `/kiosk/branding/logo/${REV_1}`,
      logoRevision: REV_1,
    });
    await refreshCachedBranding({
      owner,
      token: "private-token",
      branding: {
        organizationName: "Северная вода",
        logoUrl: `/kiosk/branding/logo/${REV_1}`,
        logoRevision: REV_1,
      },
      fetch: vi.fn(
        async () => new Response("old", { headers: { "Content-Type": "image/webp" } }),
      ) as typeof fetch,
      decode: async () => true,
    });

    const result = await refreshCachedBranding({
      owner,
      token: "private-token",
      branding: {
        organizationName: "Северная вода",
        logoUrl: `/kiosk/branding/logo/${REV_2}`,
        logoRevision: REV_2,
      },
      fetch: vi.fn(async () => new Response("down", { status: 503 })) as typeof fetch,
      decode: async () => true,
    });

    expect(result.applied).toBe(true);
    expect(result.branding.revision).toBe(REV_1);
    expect((await loadCachedBranding()).revision).toBe(REV_1);
  });

  it("discards a stale success after same-kiosk token rotation", async () => {
    const owner = await seedBinding({
      organizationName: "Old tenant",
      logoUrl: `/kiosk/branding/logo/${REV_1}`,
      logoRevision: REV_1,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const pending = refreshCachedBranding({
      owner,
      token: "private-token",
      branding: {
        organizationName: "Old tenant",
        logoUrl: `/kiosk/branding/logo/${REV_1}`,
        logoRevision: REV_1,
      },
      fetch: vi.fn(async () => {
        await gate;
        return new Response("old", { headers: { "Content-Type": "image/webp" } });
      }) as typeof fetch,
      decode: async () => true,
    });
    const rotated = await writeConfig({
      serverUrl: SERVER,
      token: "rotated-token",
      kioskId: "kiosk-1",
      kioskName: "Gate",
      place: null,
      nextDeviceSeq: 0,
    });
    release();

    await expect(pending).resolves.toMatchObject({ applied: false });
    expect(rotated.credentialGeneration).not.toBe(owner.credentialGeneration);
    expect((await loadCachedBranding()).logoBlob).toBeNull();
  });

  it("does not let stale null cleanup erase a newly rotated owner's logo", async () => {
    const oldOwner = await seedBinding({
      organizationName: "Old",
      logoUrl: null,
      logoRevision: null,
    });
    const rotated = await writeConfig({
      serverUrl: SERVER,
      token: "new-token",
      kioskId: "kiosk-1",
      kioskName: "Gate",
      place: null,
      nextDeviceSeq: 0,
    });
    const newOwner: BrandingOwner = {
      serverUrl: SERVER,
      kioskId: "kiosk-1",
      credentialGeneration: rotated.credentialGeneration!,
    };
    await replaceSnapshot(
      bootstrap({
        organizationName: "New",
        logoUrl: `/kiosk/branding/logo/${REV_2}`,
        logoRevision: REV_2,
      }),
      new Date(),
    );
    await refreshCachedBranding({
      owner: newOwner,
      token: "new-token",
      branding: {
        organizationName: "New",
        logoUrl: `/kiosk/branding/logo/${REV_2}`,
        logoRevision: REV_2,
      },
      fetch: vi.fn(
        async () => new Response("new", { headers: { "Content-Type": "image/webp" } }),
      ) as typeof fetch,
      decode: async () => true,
    });

    await expect(invalidateCachedBranding({ owner: oldOwner, revision: REV_1 })).resolves.toBe(
      false,
    );
    expect((await loadCachedBranding()).revision).toBe(REV_2);
  });

  it("does not let an old displayed image error delete the current owner's cache", async () => {
    const oldOwner = await seedBinding({
      organizationName: "Old",
      logoUrl: `/kiosk/branding/logo/${REV_1}`,
      logoRevision: REV_1,
    });
    const rotated = await writeConfig({
      serverUrl: "https://new.example",
      token: "new-token",
      kioskId: "kiosk-2",
      kioskName: "New",
      place: null,
      nextDeviceSeq: 0,
    });
    const newOwner: BrandingOwner = {
      serverUrl: rotated.serverUrl,
      kioskId: rotated.kioskId!,
      credentialGeneration: rotated.credentialGeneration!,
    };
    await replaceSnapshot(
      bootstrap({
        organizationName: "New",
        logoUrl: `/kiosk/branding/logo/${REV_2}`,
        logoRevision: REV_2,
      }),
      new Date(),
    );
    await refreshCachedBranding({
      owner: newOwner,
      token: "new-token",
      branding: {
        organizationName: "New",
        logoUrl: `/kiosk/branding/logo/${REV_2}`,
        logoRevision: REV_2,
      },
      fetch: vi.fn(
        async () => new Response("new", { headers: { "Content-Type": "image/webp" } }),
      ) as typeof fetch,
      decode: async () => true,
    });

    await expect(invalidateCachedBranding({ owner: oldOwner, revision: REV_1 })).resolves.toBe(
      false,
    );
    expect((await loadCachedBranding()).revision).toBe(REV_2);
  });

  it("does not let an old revision's image error delete a newer logo for the same owner", async () => {
    const owner = await seedBinding({
      organizationName: "Current",
      logoUrl: `/kiosk/branding/logo/${REV_2}`,
      logoRevision: REV_2,
    });
    await refreshCachedBranding({
      owner,
      token: "private-token",
      branding: {
        organizationName: "Current",
        logoUrl: `/kiosk/branding/logo/${REV_2}`,
        logoRevision: REV_2,
      },
      fetch: vi.fn(
        async () => new Response("new", { headers: { "Content-Type": "image/webp" } }),
      ) as typeof fetch,
      decode: async () => true,
    });

    await expect(invalidateCachedBranding({ owner, revision: REV_1 })).resolves.toBe(false);
    expect((await loadCachedBranding()).revision).toBe(REV_2);
  });

  it("deletes only the exact broken logo still displayed for the current owner", async () => {
    const owner = await seedBinding({
      organizationName: "Current",
      logoUrl: `/kiosk/branding/logo/${REV_1}`,
      logoRevision: REV_1,
    });
    await refreshCachedBranding({
      owner,
      token: "private-token",
      branding: {
        organizationName: "Current",
        logoUrl: `/kiosk/branding/logo/${REV_1}`,
        logoRevision: REV_1,
      },
      fetch: vi.fn(
        async () => new Response("broken", { headers: { "Content-Type": "image/webp" } }),
      ) as typeof fetch,
      decode: async () => true,
    });

    await expect(invalidateCachedBranding({ owner, revision: REV_1 })).resolves.toBe(true);
    await expect(loadCachedBranding()).resolves.toMatchObject({
      logoBlob: null,
      revision: null,
      owner: null,
    });
  });

  it("does not let a previous tenant's deferred success overwrite a new binding", async () => {
    const oldOwner = await seedBinding({
      organizationName: "Old",
      logoUrl: `/kiosk/branding/logo/${REV_1}`,
      logoRevision: REV_1,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const pending = refreshCachedBranding({
      owner: oldOwner,
      token: "private-token",
      branding: {
        organizationName: "Old",
        logoUrl: `/kiosk/branding/logo/${REV_1}`,
        logoRevision: REV_1,
      },
      fetch: vi.fn(async () => {
        await gate;
        return new Response("old", { headers: { "Content-Type": "image/webp" } });
      }) as typeof fetch,
      decode: async () => true,
    });
    const config = await writeConfig({
      serverUrl: "https://new.example",
      token: "new-token",
      kioskId: "kiosk-2",
      kioskName: "New",
      place: null,
      nextDeviceSeq: 0,
    });
    const newOwner: BrandingOwner = {
      serverUrl: config.serverUrl,
      kioskId: config.kioskId!,
      credentialGeneration: config.credentialGeneration!,
    };
    await replaceSnapshot(
      bootstrap({
        organizationName: "New",
        logoUrl: `/kiosk/branding/logo/${REV_2}`,
        logoRevision: REV_2,
      }),
      new Date(),
    );
    await refreshCachedBranding({
      owner: newOwner,
      token: "new-token",
      branding: {
        organizationName: "New",
        logoUrl: `/kiosk/branding/logo/${REV_2}`,
        logoRevision: REV_2,
      },
      fetch: vi.fn(
        async () => new Response("new", { headers: { "Content-Type": "image/webp" } }),
      ) as typeof fetch,
      decode: async () => true,
    });
    release();

    await expect(pending).resolves.toMatchObject({ applied: false });
    expect((await loadCachedBranding()).revision).toBe(REV_2);
  });

  it("activates only the latest request for the still-current owner", () => {
    const branding = { organizationName: "Current", logoBlob: null, revision: null, owner: null };
    const result = { applied: true, owner: OWNER, branding };

    expect(shouldActivateBranding(result, OWNER, 4, 5)).toBe(false);
    expect(shouldActivateBranding(result, OWNER, 5, 5)).toBe(true);
    expect(shouldActivateBranding(result, { ...OWNER, credentialGeneration: "other" }, 5, 5)).toBe(
      false,
    );
  });
});
