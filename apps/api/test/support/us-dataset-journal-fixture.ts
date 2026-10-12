import { canonicalExportDigest } from "@markiro/domain";
import { createDb } from "@markiro/db";
import { parseUsDatasetDefinition } from "../../src/modules/traceability/demo/us-dataset-contract";
import { createUsDemoJournalFixture } from "./us-demo-journal-fixture";
import { snapshotUsDatasetTables } from "./us-dataset-snapshot";

export async function createUsDatasetJournalFixture(
  base: string,
): Promise<Awaited<ReturnType<typeof createUsDemoJournalFixture>>> {
  const fixture = await createUsDemoJournalFixture(base);
  return {
    ...fixture,
    async snapshot() {
      return snapshotUsDatasetTables(fixture.pool);
    },
    async close() {
      await fixture.close();
      const admin = createDb(base);
      try {
        const result = await admin.pool.query(
          "SELECT datname FROM pg_database WHERE datname = $1",
          [fixture.databaseName],
        );
        if (result.rowCount !== 0) throw new Error("us_dataset_fixture_disposal_failed");
        console.info(`Disposed dataset database verified absent: ${fixture.databaseName}`);
      } finally {
        await admin.pool.end();
      }
    },
  };
}
export function datasetDefinition(count = 2) {
  const body = {
    version: "us-processor-six-month-v1",
    manifest: { synthetic: true, period: ["2026-04-01", "2026-09-30"] },
    units: Array.from({ length: count }, (_, index) => ({
      key: `chain_${String(index).padStart(3, "0")}`,
      kind: "chain",
      stages: ["receiving", "transformation", "cases", "shipping", "trace_readiness"],
    })),
  };
  return parseUsDatasetDefinition({ ...body, digest: canonicalExportDigest(body) });
}
