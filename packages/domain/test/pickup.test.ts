import { describe, expect, it } from "vitest";
import { validatePickupKm } from "../src/scan/pickup.js";

const GS = String.fromCharCode(0x1d);
// Valid beer KM: 01 + gtin14 + 21 + serial + GS + 93 + 4-char crypto tail.
const GTIN = "04600682000013";
const CLEAN = `01${GTIN}21KYC9X7MQ${GS}93Abcd`;

describe("validatePickupKm", () => {
  it("accepts a well-formed KM with a crypto tail and returns the canonical key", () => {
    const r = validatePickupKm(CLEAN);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.km.gtin14).toBe(GTIN);
      expect(r.km.serial).toBe("KYC9X7MQ");
      expect(r.key).toBe(`01${GTIN}21KYC9X7MQ`);
    }
  });

  it("rejects a KM whose GS was dropped (no trailing AI) as incomplete", () => {
    // Keyboard scanner dropped the GS: serial swallows '93Abcd'.
    const r = validatePickupKm(`01${GTIN}21KYC9X7MQ93Abcd`);
    expect(r.status).toBe("incomplete");
  });

  it("classifies a plain GTIN / badge scan as not_km", () => {
    expect(validatePickupKm(GTIN).status).toBe("not_km");
    expect(validatePickupKm("MARKIRO-BADGE-4412").status).toBe("not_km");
  });

  it("accepts a tail-less KM when requireCryptoTail is false", () => {
    const r = validatePickupKm(`01${GTIN}21KYC9X7MQ`, { requireCryptoTail: false });
    expect(r.status).toBe("ok");
  });
});
