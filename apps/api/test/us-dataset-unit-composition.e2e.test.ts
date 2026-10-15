import { canonicalExportDigest } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { UsDatasetShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-shipping-seed";
import { UsDatasetUnitCompositionStore } from "../src/modules/traceability/demo/us-dataset-unit-composition";
import { prepareDatasetShippingFixture } from "./support/us-dataset-shipping-fixture";
import { specialFixture } from "./support/us-dataset-special-fixture";
import { countActualQueries } from "./support/us-dataset-query-counter";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("closed dataset unit composition", () => {
  const h = specialFixture(base);

  it(
    "owns native Shipping and Trace proof for regular chain zero",
    h.phase(async () => {
      const started = performance.now();
      try {
        const owner = new UsDatasetUnitCompositionStore(h.f.db);
        const measured = await countActualQueries(h.f.pool, () =>
          owner.initialize(h.context, { kind: "regular", index: 0 }),
        );
        const actual = measured.value;
        expect(actual.trace.unitKey).toBe("chain_0000");
        if (actual.kind !== "regular") throw new Error("Expected regular composition");
        expect(actual.native.shippingResultDigest).toMatch(/^[0-9a-f]{64}$/);
        console.info("Unit composition chain zero forwarding", {
          queries: measured.count,
          elapsedMs: Math.round(measured.durationMs),
        });
      } finally {
        console.info(
          "Unit composition chain zero body ms",
          Math.round(performance.now() - started),
        );
      }
    }),
  );

  it(
    "releases the initializer's checked Shipping projection after native commit",
    h.phase(async () => {
      const started = performance.now();
      await prepareDatasetShippingFixture(h.f, h.context, 0);
      const prepared = performance.now();
      const shipping = new UsDatasetShippingSeedStore(h.f.db);
      const projection = await shipping.initializeTerminalProjection(h.context, 0);
      const initialized = performance.now();
      expect(projection.shipping.input.chain.unitKey).toBe("chain_0000");
      expect(canonicalExportDigest(projection.shipping)).toBe(
        canonicalExportDigest(await shipping.verify(h.context, 0)),
      );
      console.info("Unit composition Shipping body ms", {
        prepare: Math.round(prepared - started),
        initialize: Math.round(initialized - prepared),
        verifyAndCompare: Math.round(performance.now() - initialized),
      });
    }),
  );
});
