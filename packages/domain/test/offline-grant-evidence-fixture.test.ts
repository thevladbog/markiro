import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { productLabelValueDigest } from "../src/product-labels/km.js";

const fixtures = z
  .array(
    z.strictObject({
      payload: z.unknown(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  )
  .min(2)
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../apps/handheld/app/src/test/resources/grant-evidence-digests.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );

describe("native grant evidence digest parity", () => {
  it("checks every committed Android vector against the current TypeScript producer", () => {
    for (const fixture of fixtures) {
      expect(productLabelValueDigest(fixture.payload)).toBe(fixture.digest);
    }
  });
});
