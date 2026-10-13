import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import activation from "../fixtures/standalone-license/activation-request.json" with { type: "json" };
import expectations from "../fixtures/standalone-license/expectations.json" with { type: "json" };
import keyset from "../fixtures/standalone-license/test-keyset.json" with { type: "json" };
import { isValidInn } from "../src/inn.js";
import {
  standaloneActivationRequestSchema,
  verifyStandaloneLicense,
  verifyStandaloneUpdateManifest,
} from "../src/standalone-license/index.js";

const HOST_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const DAY = 86_400_000;

/** A signed fixture without the line end the generator writes. */
function signed(name: string): string {
  return readFileSync(
    new URL(`../fixtures/standalone-license/${name}`, import.meta.url),
    "utf8",
  ).trim();
}

async function outcome(file: string, as: string): Promise<string> {
  const result =
    as === "license"
      ? await verifyStandaloneLicense(signed(file), keyset.license)
      : await verifyStandaloneUpdateManifest(signed(file), keyset.update);
  return result.ok ? "ok" : result.reason;
}

async function license(file: string) {
  const result = await verifyStandaloneLicense(signed(file), keyset.license);
  if (!result.ok) throw new Error(`${file}: ${result.reason}`);
  return result.license;
}

describe("the signed standalone fixtures (shared with markiro_proto::trust)", () => {
  it.each(expectations)("$file as $as: $result", async ({ file, as, result }) => {
    expect(await outcome(file, as)).toBe(result);
  });

  it("hold a subscription, a demo, its upgrade and the files the host must refuse", async () => {
    const subscription = await license("license-subscription.jws");
    expect(subscription).toMatchObject({
      hostId: HOST_ID,
      // An opaque tenant id, not a UUID: the counterparty chooses it.
      tenantId: "Zq4bL0x9cabinetTenant01",
      sequence: 1,
      plan: "subscription",
      graceDays: 14,
      replaces: null,
      customer: { inn: "7707083893" },
    });
    expect(isValidInn(subscription.customer.inn)).toBe(true);
    const demo = await license("license-demo.jws");
    expect(demo).toMatchObject({
      plan: "demo",
      graceDays: 0,
      validUntil: demo.validFrom + 14 * DAY,
    });
    const upgrade = await license("license-upgrade.jws");
    expect(upgrade).toMatchObject({
      sequence: 2,
      replaces: subscription.licenseId,
      quotas: { ...subscription.quotas, stations: 8 },
    });
    const older = await license("license-older.jws");
    expect(older.sequence).toBe(1);
    expect(older.licenseId).not.toBe(subscription.licenseId);
    expect((await license("license-other-host.jws")).hostId).not.toBe(HOST_ID);
    const otherInn = (await license("license-other-inn.jws")).customer.inn;
    expect(otherInn).not.toBe(subscription.customer.inn);
    expect(isValidInn(otherInn)).toBe(true);
  });

  it("name their keys test-… and publish no private part", () => {
    for (const key of [...keyset.license.keys, ...keyset.update.keys]) {
      expect(key.kid.startsWith("test-")).toBe(true);
      expect(Object.keys(key.jwk).sort()).toEqual(["crv", "kty", "x", "y"]);
    }
    expect(keyset.license.origin).toBe("https://license.test.invalid");
  });

  it("hold an activation request the schema reads as it is", () => {
    expect(standaloneActivationRequestSchema.parse(activation)).toEqual(activation);
    expect(activation.hostId).toBe(HOST_ID);
  });
});
