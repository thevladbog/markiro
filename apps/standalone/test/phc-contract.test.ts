// @vitest-environment node
// Node's WebCrypto: PBKDF2 needs `crypto.subtle`, which this test must not
// borrow from a DOM emulation.
import { readFileSync } from "node:fs";

import { parsePhc, PHC_ITERATIONS, verifyPhc } from "@markiro/domain";
import { describe, expect, it } from "vitest";

const testModuleUrl = import.meta.url;

interface PhcFixture {
  password: string;
  passwordPhc: string;
  pin: string;
  pinPhc: string;
}

const fixture = JSON.parse(
  readFileSync(new URL("../proto/fixtures/phc-password.json", testModuleUrl), "utf8"),
) as PhcFixture;

describe("PHC strings shared with the host (spec §6)", () => {
  it("verifies the password PHC in the host's format", async () => {
    expect(parsePhc(fixture.passwordPhc)?.iterations).toBe(600_000);
    await expect(verifyPhc(fixture.password, fixture.passwordPhc)).resolves.toBe(true);
    await expect(verifyPhc(`${fixture.password}!`, fixture.passwordPhc)).resolves.toBe(false);
  });

  it("verifies the PIN PHC made by the domain", async () => {
    expect(parsePhc(fixture.pinPhc)?.iterations).toBe(PHC_ITERATIONS);
    await expect(verifyPhc(fixture.pin, fixture.pinPhc)).resolves.toBe(true);
  });
});
