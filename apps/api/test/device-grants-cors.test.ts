import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";
import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { corsDelegate } from "../src/cors";
import { loadEnv } from "../src/env";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";

const stationOrigin = "https://station.example.ru";
const delegate = corsDelegate(
  loadEnv({
    ...PLATFORM_TEST_ENV,
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    BETTER_AUTH_SECRET: "0123456789abcdef0123",
    BETTER_AUTH_URL: "http://localhost:3000",
    ADMIN_ORIGIN: "https://admin.example.ru",
    STATION_ORIGIN: stationOrigin,
    PAIRING_CODE_PEPPER: "0123456789abcdef0123",
  }),
);
const routes = [
  ["GET", "/station/grants/v1/keyset"],
  ["POST", "/station/grants/v1/configuration"],
  ["POST", "/station/grants/v1/device"],
  ["POST", "/station/grants/v1/tasks"],
  ["POST", "/station/grants/v1/evidence/scans"],
  ["POST", "/station/grants/v1/evidence/shift-closures"],
  ["POST", "/station/grants/v1/evidence/inventories/inventory-1/event-batches"],
  ["POST", "/station/grants/v1/evidence/inventories/inventory-1/leave"],
] as const;
function origins(method: string, path: string, requestedMethod?: string): CorsOptions["origin"] {
  let options: CorsOptions | undefined;
  delegate(
    {
      method,
      path,
      headers: requestedMethod ? { "access-control-request-method": requestedMethod } : {},
    } as Request,
    (error, selected) => {
      if (error) throw error;
      options = selected;
    },
  );
  if (!options) throw new Error("No CORS result");
  return options.origin;
}
describe("negotiated Station grant CORS", () => {
  it.each(routes)("allows only the documented %s %s and its preflight", (method, path) => {
    expect(origins(method, path)).toContain(stationOrigin);
    expect(origins("OPTIONS", path, method)).toContain(stationOrigin);
    expect(origins(method, path.toUpperCase() + "/")).toContain(stationOrigin);
    const wrongMethod = method === "GET" ? "POST" : "GET";
    expect(origins(wrongMethod, path)).not.toContain(stationOrigin);
    expect(origins("OPTIONS", path, wrongMethod)).not.toContain(stationOrigin);
    expect(origins(method, path + "/extra")).not.toContain(stationOrigin);
  });
  it.each([
    "/station/grants/v1",
    "/station/grants/v1/unknown",
    "/station/grants/v2/device",
    "/public/v1/products",
  ])("keeps adjacent route %s outside the Station origin", (path) => {
    expect(origins("POST", path)).not.toContain(stationOrigin);
    expect(origins("OPTIONS", path, "POST")).not.toContain(stationOrigin);
  });
});
