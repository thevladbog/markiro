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
  ["GET", "/station/grants/v1/keyset"],
  ["POST", "/station/grants/v1/configuration"],
  ["POST", "/station/grants/v1/device"],
  ["POST", "/station/grants/v1/tasks"],
  ["POST", "/station/grants/v1/readiness"],
  ["POST", "/station/grants/v1/evidence/scans"],
  ["POST", "/station/grants/v1/evidence/shift-closures"],
  ["POST", "/station/grants/v1/evidence/inventories/inventory-1/event-batches"],
  ["POST", "/station/grants/v1/evidence/inventories/inventory-1/leave"],

  ["POST", "/station/pair"],
  ["POST", "/station/pair/recovery"],
  ["GET", "/station/identity"],
  ["POST", "/station/heartbeat"],
  ["GET", "/station/operators"],
  ["GET", "/station/device-replacement-intent/v1"],
  ["POST", "/station/device-replacement-intent/v1/acknowledge"],
  ["POST", "/station/device-replacement-readiness"],
  ["POST", "/station/replacement-recovery/readiness"],
  [
    "GET",
    "/station/products/00000000-0000-0000-0000-000000000000/image/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ],
  ["POST", "/station/conflicts/status"],
  ["POST", "/station/validation-occurrences/status"],
  ["POST", "/station/codes/releases"],
  ["POST", "/station/boxes/reconciliation"],
  ["POST", "/station/scans"],
  ["GET", "/station/inventory-tasks"],
  ["POST", "/station/inventory-tasks/resolve-barcode"],
  ["POST", "/station/inventories/inventory-1/join"],
  ["GET", "/station/inventories/inventory-1/bundle/manifest"],
  ["GET", "/station/inventories/inventory-1/bundle/codes"],
  ["POST", "/station/inventories/inventory-1/event-batches"],
  ["GET", "/station/inventories/inventory-1/progress"],
  ["GET", "/station/shifts/shift-1/progress"],
  ["POST", "/station/inventories/inventory-1/leave"],
  ["POST", "/station/shift-closures"],
  ["GET", "/shifts"],
  ["POST", "/shifts"],
  ["GET", "/shifts/box-label-templates"],
  ["GET", "/shifts/pallet-label-templates"],
  ["GET", "/shifts/product-label-templates"],
  ["GET", "/shifts/planning-config"],
  ["GET", "/shifts/shift-1/bundle"],
  ["GET", "/shifts/shift-1/reference-bundle"],
  ["GET", "/shifts/shift-1/code-history"],
  ["POST", "/shifts/shift-1/open"],
  ["POST", "/shifts/shift-1/enter"],
  ["POST", "/shifts/shift-1/sscc/top-up"],
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
    ["GET", "/station/pair/recovery"],
    ["POST", "/station/pair/recovery/extra"],
    ["POST", "/station/identity"],
    ["GET", "/station/heartbeat"],
    ["POST", "/station/operators"],
    ["GET", "/station/device-replacement-intent"],
    ["POST", "/station/device-replacement-intent/v1"],
    ["GET", "/station/device-replacement-intent/v1/extra"],
    ["GET", "/station/device-replacement-intent/v1/acknowledge"],
    ["POST", "/station/device-replacement-intent/v1/acknowledge/extra"],
    ["GET", "/station/device-replacement-readiness"],
    ["POST", "/station/device-replacement-readiness/extra"],
    ["GET", "/station/replacement-recovery/readiness"],
    ["POST", "/station/replacement-recovery/readiness/extra"],
    ["POST", "/station/replacement-recovery"],
    ["GET", "/station/grants/v1/readiness"],
    ["POST", "/station/grants/v1/readiness/extra"],
    [
      "POST",
      "/station/products/00000000-0000-0000-0000-000000000000/image/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ],
    [
      "GET",
      "/station/products/00000000-0000-0000-0000-000000000000/image/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/extra",
    ],
    ["GET", "/station/scans"],
    ["POST", "/station/inventory-tasks"],
    ["GET", "/station/inventory-tasks/resolve-barcode"],
    ["GET", "/station/inventories/inventory-1/join"],
    ["POST", "/station/inventories/inventory-1/bundle/manifest"],
    ["POST", "/station/inventories/inventory-1/bundle/codes"],
    ["GET", "/station/inventories/inventory-1/bundle/codes/extra"],
    ["GET", "/station/inventories/inventory-1/event-batches"],
    ["POST", "/station/inventories/inventory-1/progress"],
    ["GET", "/station/inventories/inventory-1/leave"],
    ["POST", "/station/inventories/inventory-1/event-batches/extra"],
    ["GET", "/station/inventories/inventory-1/progress/extra"],
    ["POST", "/station/inventories/inventory-1/leave/extra"],
    ["POST", "/station/shifts/shift-1/progress"],
    ["GET", "/station/shifts/shift-1/progress/extra"],
    ["GET", "/station/shifts/shift-1"],
    ["GET", "/station/validation-occurrences/status"],
    ["PATCH", "/station/validation-occurrences/status"],
    ["DELETE", "/station/validation-occurrences/status"],
    ["POST", "/station/validation-occurrences/status/extra"],
    ["POST", "/shifts/shift-1/code-history"],
    ["PATCH", "/shifts/shift-1/code-history"],
    ["DELETE", "/shifts/shift-1/code-history"],
    ["GET", "/shifts/shift-1/code-history/extra"],
    ["GET", "/shifts/shift-1/reprocessings"],
    ["POST", "/shifts/shift-1/reprocessings"],
    ["GET", "/station/conflicts/status"],
    ["GET", "/station/codes/releases"],
    ["PATCH", "/shifts"],
    ["GET", "/shifts/shift-1"],
    ["POST", "/shifts/shift-1/close"],
    ["GET", "/shifts/shift-1/open"],
    ["GET", "/shifts/shift-1/enter"],
    ["POST", "/shifts/shift-1/enter/extra"],
    ["GET", "/shifts/shift-1/sscc/top-up"],
    ["PATCH", "/shifts/shift-1/sscc/top-up"],
    ["POST", "/shifts/shift-1/sscc/top-up/extra"],
    ["POST", "/shifts/shift-1/sscc"],
    ["POST", "/shifts/shift-1/summary"],
    ["POST", "/shifts/shift-1/bundle"],
    ["POST", "/shifts/shift-1/reference-bundle"],
    ["GET", "/station/shift-closures"],
    ["POST", "/products"],
    ["GET", "/products/gtin-check"],
    ["GET", "/products/product-1"],
    ["GET", "/stations"],
    ["GET", "/station-devices"],
    ["GET", "/counterparties"],
    ["GET", "/unknown"],
    ["GET", "/products-extra"],
    ["GET", "/shifts/shift-1/bundle/extra"],
    ["GET", "/shifts/shift-1/reference-bundle/extra"],
  ] as const)("does not leak STATION_ORIGIN onto adjacent %s %s", (method, path) => {
    expect(selectedOrigins(delegate, method, path)).not.toContain(STATION_ORIGIN);
    expect(selectedOrigins(delegate, "OPTIONS", path, method)).not.toContain(STATION_ORIGIN);
  });

  it("denies an OPTIONS request whose requested method is absent or not the allowed method", () => {
    for (const path of ["/shifts/shift-1/code-history", "/station/validation-occurrences/status"]) {
      expect(selectedOrigins(delegate, "OPTIONS", path)).not.toContain(STATION_ORIGIN);
      expect(selectedOrigins(delegate, "OPTIONS", path, "PATCH")).not.toContain(STATION_ORIGIN);
    }
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
