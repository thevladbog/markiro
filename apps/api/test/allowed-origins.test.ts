import { describe, expect, it } from "vitest";
import { allowedOrigins, loadEnv } from "../src/env";

/**
 * Pure unit coverage for the origin allowlist. The HTTP-level proof that a
 * kiosk origin actually clears a preflight lives in cors.e2e.test.ts; this
 * file pins the shape of the list itself, including the "no kiosk configured"
 * path that an existing admin-only deployment upgrades into.
 */
const BASE = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  BETTER_AUTH_SECRET: "0123456789abcdef0123",
  BETTER_AUTH_URL: "http://localhost:3000",
  ADMIN_ORIGIN: "https://admin.example.ru",
  PAIRING_CODE_PEPPER: "0123456789abcdef0123",
} satisfies NodeJS.ProcessEnv;

describe("allowedOrigins", () => {
  it("is just the admin origin when KIOSK_ORIGIN is unset", () => {
    expect(allowedOrigins(loadEnv(BASE))).toEqual(["https://admin.example.ru"]);
  });

  it("never leaks an undefined entry into the list when KIOSK_ORIGIN is unset", () => {
    // `cors` silently never matches an undefined entry and better-auth's
    // origin check would throw on one, so both failures would surface far
    // from their cause.
    expect(allowedOrigins(loadEnv(BASE)).every((o) => typeof o === "string")).toBe(true);
  });

  it("includes the kiosk origin when KIOSK_ORIGIN is set", () => {
    const env = loadEnv({ ...BASE, KIOSK_ORIGIN: "https://kiosk.example.ru" });
    expect(allowedOrigins(env)).toEqual(["https://admin.example.ru", "https://kiosk.example.ru"]);
  });

  it("deduplicates when admin and kiosk share one origin (single-host deployment)", () => {
    const env = loadEnv({ ...BASE, KIOSK_ORIGIN: BASE.ADMIN_ORIGIN });
    expect(allowedOrigins(env)).toEqual(["https://admin.example.ru"]);
  });
});

describe("loadEnv KIOSK_ORIGIN", () => {
  it("treats an empty value as unset rather than failing to boot", () => {
    // `KIOSK_ORIGIN: ${KIOSK_ORIGIN}` in a compose file with nothing to
    // substitute yields "", not an absent key. Without this an upgrading
    // operator gets a crash-loop on `.url()` instead of a working API.
    expect(loadEnv({ ...BASE, KIOSK_ORIGIN: "" }).KIOSK_ORIGIN).toBeUndefined();
  });

  it("still rejects a non-URL value", () => {
    expect(() => loadEnv({ ...BASE, KIOSK_ORIGIN: "kiosk.example.ru" })).toThrow();
  });

  it("does not require KIOSK_ORIGIN to be present at all", () => {
    expect(() => loadEnv(BASE)).not.toThrow();
  });
});
