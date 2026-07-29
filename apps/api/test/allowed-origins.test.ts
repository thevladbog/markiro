import { describe, expect, it } from "vitest";
import { kioskAllowedOrigins, loadEnv, sessionAllowedOrigins } from "../src/env";

/**
 * Pure unit coverage for the origin allowlists. The HTTP-level proof that a
 * kiosk origin clears a preflight on `/kiosk/*` and is refused everywhere
 * else lives in cors.e2e.test.ts; this file pins the shape of the lists
 * themselves, including the "no kiosk configured" path that an existing
 * admin-only deployment upgrades into.
 */
const BASE = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  BETTER_AUTH_SECRET: "0123456789abcdef0123",
  BETTER_AUTH_URL: "http://localhost:3000",
  ADMIN_ORIGIN: "https://admin.example.ru",
  PAIRING_CODE_PEPPER: "0123456789abcdef0123",
} satisfies NodeJS.ProcessEnv;

describe("kioskAllowedOrigins", () => {
  it("is just the admin origin when KIOSK_ORIGIN is unset", () => {
    expect(kioskAllowedOrigins(loadEnv(BASE))).toEqual(["https://admin.example.ru"]);
  });

  it("never leaks an undefined entry into the list when KIOSK_ORIGIN is unset", () => {
    // `cors` silently never matches an undefined entry and better-auth's
    // origin check would throw on one, so both failures would surface far
    // from their cause.
    expect(kioskAllowedOrigins(loadEnv(BASE)).every((o) => typeof o === "string")).toBe(true);
  });

  it("includes the kiosk origin when KIOSK_ORIGIN is set", () => {
    const env = loadEnv({ ...BASE, KIOSK_ORIGIN: "https://kiosk.example.ru" });
    expect(kioskAllowedOrigins(env)).toEqual([
      "https://admin.example.ru",
      "https://kiosk.example.ru",
    ]);
  });

  it("deduplicates when admin and kiosk share one origin (single-host deployment)", () => {
    const env = loadEnv({ ...BASE, KIOSK_ORIGIN: BASE.ADMIN_ORIGIN });
    expect(kioskAllowedOrigins(env)).toEqual(["https://admin.example.ru"]);
  });
});

describe("sessionAllowedOrigins", () => {
  // The kiosk calls `/kiosk/*` and nothing else, so trusting its origin on
  // the session-guarded surface (and in better-auth's `trustedOrigins`, which
  // is fed from this same list) would buy nothing and hand a credentialed
  // reader to every route.
  it("never includes the kiosk origin, even when KIOSK_ORIGIN is set", () => {
    const env = loadEnv({ ...BASE, KIOSK_ORIGIN: "https://kiosk.example.ru" });
    expect(sessionAllowedOrigins(env)).toEqual(["https://admin.example.ru"]);
  });

  it("is unaffected by KIOSK_ORIGIN being absent", () => {
    expect(sessionAllowedOrigins(loadEnv(BASE))).toEqual(["https://admin.example.ru"]);
  });

  it("still contains the kiosk origin's value when a single host serves both apps", () => {
    // Not an exception to the rule above: the entry is ADMIN_ORIGIN, which
    // happens to equal KIOSK_ORIGIN. Nothing is granted that the admin origin
    // did not already have.
    const env = loadEnv({ ...BASE, KIOSK_ORIGIN: BASE.ADMIN_ORIGIN });
    expect(sessionAllowedOrigins(env)).toEqual(["https://admin.example.ru"]);
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

  // A browser sends `Origin` as bare `scheme://host[:port]`, and `cors`
  // compares configured entries to it as plain strings. Both inputs below are
  // valid URLs that `z.string().url()` accepts unchanged, and both would then
  // match no request ever made — silently, since a non-matching origin just
  // omits a response header.
  it("canonicalizes a trailing slash away", () => {
    expect(loadEnv({ ...BASE, KIOSK_ORIGIN: "https://kiosk.example.ru/" }).KIOSK_ORIGIN).toBe(
      "https://kiosk.example.ru",
    );
  });

  it("canonicalizes a path-, query- and fragment-carrying URL down to its origin", () => {
    expect(
      loadEnv({ ...BASE, KIOSK_ORIGIN: "https://kiosk.example.ru:8443/pickup?a=1#x" }).KIOSK_ORIGIN,
    ).toBe("https://kiosk.example.ru:8443");
  });

  it("canonicalizes host case, which a browser always sends lowercased", () => {
    expect(loadEnv({ ...BASE, KIOSK_ORIGIN: "https://Kiosk.Example.RU" }).KIOSK_ORIGIN).toBe(
      "https://kiosk.example.ru",
    );
  });

  it("keeps a non-default port, which is part of the origin", () => {
    expect(loadEnv({ ...BASE, KIOSK_ORIGIN: "http://10.0.0.5:5373" }).KIOSK_ORIGIN).toBe(
      "http://10.0.0.5:5373",
    );
  });

  it('rejects a non-HTTP(S) scheme instead of allowlisting the string "null"', () => {
    // `z.string().url()` accepts these; `new URL("mailto:a@b").origin` is the
    // literal "null", which is also what a browser sends for a sandboxed or
    // otherwise opaque origin — allowlisting it would trust all of them.
    expect(() => loadEnv({ ...BASE, KIOSK_ORIGIN: "mailto:ops@example.ru" })).toThrow();
    expect(() => loadEnv({ ...BASE, KIOSK_ORIGIN: "ftp://kiosk.example.ru" })).toThrow();
  });
});
