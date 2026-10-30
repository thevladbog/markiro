import { expect, it } from "vitest";
import {
  assertUsHostedRelease,
  disposeUsHostedRelease,
  usHostedReleaseIdentity,
  verifyUsHostedRelease,
} from "../src/deployment/us-hosted-release-verifier";

it("refuses structural release imitations at every authority accessor", () => {
  for (const value of [null, undefined, {}, Object.freeze({ service: "api", disposed: false })]) {
    expect(() => assertUsHostedRelease(value)).toThrow("us_hosted_release_invalid");
    expect(() => usHostedReleaseIdentity(value)).toThrow("us_hosted_release_invalid");
    expect(() => disposeUsHostedRelease(value)).toThrow("us_hosted_release_invalid");
  }
});
it("requires the fixed installed package and never admits this source checkout", async () => {
  await expect(verifyUsHostedRelease("api")).rejects.toThrow("us_hosted_release_invalid");
});
