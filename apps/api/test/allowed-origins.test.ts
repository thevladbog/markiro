import { describe, expect, it } from "vitest";
import {
  kioskAllowedOrigins,
  loadEnv,
  sessionAllowedOrigins,
  stationAllowedOrigins,
} from "../src/env";

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

describe("stationAllowedOrigins", () => {
  it("is just the admin origin when STATION_ORIGIN is unset", () => {
    expect(stationAllowedOrigins(loadEnv(BASE))).toEqual(["https://admin.example.ru"]);
  });

  it("includes an exact HTTP(S) station origin", () => {
    const env = loadEnv({ ...BASE, STATION_ORIGIN: "https://station.example.ru/" });
    expect(stationAllowedOrigins(env)).toEqual([
      "https://admin.example.ru",
      "https://station.example.ru",
    ]);
  });

  it("allows only the supported non-opaque Tauri origin", () => {
    const env = loadEnv({ ...BASE, STATION_ORIGIN: "tauri://localhost" });
    expect(stationAllowedOrigins(env)).toEqual(["https://admin.example.ru", "tauri://localhost"]);
  });

  it("does not grant the station origin to the session or kiosk surface", () => {
    const env = loadEnv({ ...BASE, STATION_ORIGIN: "https://station.example.ru" });
    expect(sessionAllowedOrigins(env)).toEqual(["https://admin.example.ru"]);
    expect(kioskAllowedOrigins(env)).toEqual(["https://admin.example.ru"]);
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

describe("loadEnv STATION_ORIGIN", () => {
  it("treats an empty value as unset rather than failing to boot", () => {
    expect(loadEnv({ ...BASE, STATION_ORIGIN: "" }).STATION_ORIGIN).toBeUndefined();
  });

  it("canonicalizes a HTTP(S) URL to its browser origin", () => {
    expect(
      loadEnv({ ...BASE, STATION_ORIGIN: "https://Station.Example.RU:5273/pair?a=1#x" })
        .STATION_ORIGIN,
    ).toBe("https://station.example.ru:5273");
  });

  it("permits tauri://localhost but never the opaque null origin", () => {
    expect(loadEnv({ ...BASE, STATION_ORIGIN: "tauri://localhost" }).STATION_ORIGIN).toBe(
      "tauri://localhost",
    );
    expect(() => loadEnv({ ...BASE, STATION_ORIGIN: "null" })).toThrow();
    expect(() => loadEnv({ ...BASE, STATION_ORIGIN: "tauri://other-host" })).toThrow();
    expect(() => loadEnv({ ...BASE, STATION_ORIGIN: "file:///station" })).toThrow();
  });

  it("rejects userinfo instead of normalizing a credential-bearing origin", () => {
    expect(() =>
      loadEnv({ ...BASE, STATION_ORIGIN: "https://user:pass@station.example.ru" }),
    ).toThrow();
  });
});

/**
 * ADMIN_ORIGIN is canonicalized by the same schema, and for the same reason:
 * it feeds both allowlists above, and a trailing slash or path there fails
 * exactly as silently — every cross-origin admin request loses its preflight
 * with nothing in the API log to say why.
 *
 * Host-lowercasing and port retention are not re-asserted here; they are one
 * shared `browserOriginSchema`, already pinned in the KIOSK_ORIGIN block.
 */
describe("loadEnv ADMIN_ORIGIN", () => {
  it("canonicalizes a trailing slash away", () => {
    expect(loadEnv({ ...BASE, ADMIN_ORIGIN: "https://admin.example.ru/" }).ADMIN_ORIGIN).toBe(
      "https://admin.example.ru",
    );
  });

  it("canonicalizes a path-, query- and fragment-carrying URL down to its origin", () => {
    expect(
      loadEnv({ ...BASE, ADMIN_ORIGIN: "https://admin.example.ru:8443/app?a=1#x" }).ADMIN_ORIGIN,
    ).toBe("https://admin.example.ru:8443");
  });

  it("carries the canonicalized value into both allowlists", () => {
    // The transform has to reach the lists themselves, not just the parsed
    // env: these are what `cors` and better-auth actually compare against.
    const env = loadEnv({ ...BASE, ADMIN_ORIGIN: "https://admin.example.ru/app" });
    expect(sessionAllowedOrigins(env)).toEqual(["https://admin.example.ru"]);
    expect(kioskAllowedOrigins(env)).toEqual(["https://admin.example.ru"]);
  });

  it("still defaults to the dev admin origin when unset", () => {
    // Zod 4's `.default()` short-circuits — the literal is returned without
    // being run through the transform — so the default has to be canonical
    // as written. It is; this pins that it stays so.
    expect(loadEnv({ ...BASE, ADMIN_ORIGIN: undefined }).ADMIN_ORIGIN).toBe(
      "http://localhost:5173",
    );
  });

  it('rejects a non-HTTP(S) scheme instead of allowlisting the string "null"', () => {
    expect(() => loadEnv({ ...BASE, ADMIN_ORIGIN: "mailto:ops@example.ru" })).toThrow();
    expect(() => loadEnv({ ...BASE, ADMIN_ORIGIN: "ftp://admin.example.ru" })).toThrow();
  });
});
