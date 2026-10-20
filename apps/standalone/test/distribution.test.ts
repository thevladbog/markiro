import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  compareAppVersions,
  deviceUpdateOfferSchema,
  officeUpdateStatusSchema,
  parseAppVersion,
} from "../src/host/distribution.js";

// Bound first: Vite rewrites a literal `new URL(…, import.meta.url)` for the
// browser, which breaks a fixture read under jsdom (`protocol.test.ts`).
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"),
  ) as unknown;
}

const versionCases = z.object({
  valid: z.array(z.tuple([z.string(), z.tuple([z.number(), z.number(), z.number()])])),
  invalid: z.array(z.string()),
  order: z.array(
    z.tuple([z.string(), z.string(), z.union([z.literal(-1), z.literal(0), z.literal(1)])]),
  ),
});

describe("app versions (proto/fixtures/app-versions.json)", () => {
  const cases = versionCases.parse(fixture("app-versions.json"));

  it("read as markiro_proto::update::AppVersion reads them", () => {
    for (const [text, parts] of cases.valid) expect(parseAppVersion(text), text).toEqual(parts);
    for (const text of cases.invalid) expect(parseAppVersion(text), text).toBeNull();
  });

  it("order by number, not by text", () => {
    for (const [left, right, order] of cases.order) {
      expect(compareAppVersions(left, right), `${left} ${right}`).toBe(order);
    }
    expect(compareAppVersions("0.3.0", "0.3")).toBeNull();
  });
});

describe("distribution shapes (proto/fixtures)", () => {
  it("read a device's offer, and a newer host's unknown state as text", () => {
    const offer = deviceUpdateOfferSchema.parse(fixture("device-update-offer.json"));
    expect(offer.package).toMatchObject({ state: "ok", version: "0.3.0", sizeBytes: 61234567 });
    expect(
      deviceUpdateOfferSchema.parse(fixture("device-update-offer-missing.json")).package,
    ).toEqual({ state: "missing" });
    const future = deviceUpdateOfferSchema.parse(fixture("device-update-offer-future.json"));
    expect(future.package.state).toBe("quarantined");
  });

  it("read the office's status with every device state", () => {
    const status = officeUpdateStatusSchema.parse(fixture("office-update-status.json"));
    expect(status.devices.map((device) => device.state)).toEqual([
      "compatible",
      "compatible",
      "incompatible",
      "host_older",
      "unknown",
    ]);
    expect(status.history[0]).toMatchObject({
      action: "app.update.start",
      from: "0.2.1",
      to: "0.3.0",
    });
  });
});
