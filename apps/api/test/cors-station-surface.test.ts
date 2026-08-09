import type {
  CorsOptions,
  CorsOptionsDelegate,
} from "@nestjs/common/interfaces/external/cors-options.interface";
import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { corsDelegate } from "../src/cors";
import { loadEnv } from "../src/env";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";

const ADMIN_ORIGIN = "https://admin.example.ru";
const STATION_ORIGIN = "https://station.example.ru";
const env = loadEnv({
  ...PLATFORM_TEST_ENV,
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  BETTER_AUTH_SECRET: "0123456789abcdef0123",
  BETTER_AUTH_URL: "http://localhost:3000",
  ADMIN_ORIGIN,
  STATION_ORIGIN,
  PAIRING_CODE_PEPPER: "0123456789abcdef0123",
});

const documentedStationSurface = [
  ["POST", "/station/pair"],
  ["GET", "/station/identity"],
  ["GET", "/station/operators"],
  ["POST", "/station/scans"],
  ["GET", "/shifts"],
  ["POST", "/shifts"],
  ["GET", "/shifts/shift-1/bundle"],
  ["POST", "/shifts/shift-1/open"],
  ["GET", "/products"],
  ["POST", "/products/gtin-check"],
] as const;

function selectedOrigins(
  delegate: CorsOptionsDelegate<Request>,
  method: string,
  path: string,
  preflightMethod?: string,
): string[] {
  let selected: CorsOptions | undefined;
  const headers = preflightMethod ? { "access-control-request-method": preflightMethod } : {};
  const request = { method, path, headers } as unknown as Request;
  delegate(request, (error, options) => {
    if (error) throw error;
    selected = options;
  });
  expect(selected).toBeDefined();
  return (selected!.origin ?? []) as string[];
}

describe("station CORS surface", () => {
  const delegate = corsDelegate(env);

  it.each(documentedStationSurface)(
    "allows STATION_ORIGIN on the documented %s %s request and its OPTIONS preflight",
    (method, path) => {
      expect(selectedOrigins(delegate, method, path)).toContain(STATION_ORIGIN);
      expect(selectedOrigins(delegate, "OPTIONS", path, method)).toContain(STATION_ORIGIN);
    },
  );

  it("normalizes a trailing slash and relies on Express req.path to ignore a query", () => {
    expect(selectedOrigins(delegate, "GET", "/products/")).toContain(STATION_ORIGIN);
    expect(selectedOrigins(delegate, "GET", "/products")).toContain(STATION_ORIGIN);
    expect(selectedOrigins(delegate, "OPTIONS", "/shifts/shift-1/bundle/", "GET")).toContain(
      STATION_ORIGIN,
    );
  });

  it.each([
    ["GET", "/station/pair"],
    ["POST", "/station/identity"],
    ["POST", "/station/operators"],
    ["GET", "/station/scans"],
    ["PATCH", "/shifts"],
    ["GET", "/shifts/shift-1"],
    ["POST", "/shifts/shift-1/close"],
    ["GET", "/shifts/shift-1/open"],
    ["POST", "/shifts/shift-1/bundle"],
    ["POST", "/products"],
    ["GET", "/products/gtin-check"],
    ["GET", "/products/product-1"],
    ["GET", "/stations"],
    ["GET", "/station-devices"],
    ["GET", "/counterparties"],
    ["GET", "/unknown"],
    ["GET", "/products-extra"],
    ["GET", "/shifts/shift-1/bundle/extra"],
  ] as const)("does not leak STATION_ORIGIN onto adjacent %s %s", (method, path) => {
    expect(selectedOrigins(delegate, method, path)).not.toContain(STATION_ORIGIN);
    expect(selectedOrigins(delegate, "OPTIONS", path, method)).not.toContain(STATION_ORIGIN);
  });

  it("denies an OPTIONS request whose requested method is absent or not the allowed method", () => {
    expect(selectedOrigins(delegate, "OPTIONS", "/station/scans")).not.toContain(STATION_ORIGIN);
    expect(selectedOrigins(delegate, "OPTIONS", "/station/scans", "GET")).not.toContain(
      STATION_ORIGIN,
    );
  });

  it("preserves ADMIN_ORIGIN on station, kiosk, session, adjacent, and unknown routes", () => {
    for (const [method, path] of [
      ...documentedStationSurface,
      ["GET", "/kiosk/bootstrap"],
      ["GET", "/counterparties"],
      ["POST", "/api/auth/sign-in/email"],
      ["GET", "/unknown"],
    ] as const) {
      expect(selectedOrigins(delegate, method, path)).toContain(ADMIN_ORIGIN);
      expect(selectedOrigins(delegate, "OPTIONS", path, method)).toContain(ADMIN_ORIGIN);
    }
  });
});
