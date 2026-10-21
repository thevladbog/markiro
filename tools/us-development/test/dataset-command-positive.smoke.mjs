import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createDatasetPositiveFixture } from "./support/dataset-command-positive-fixture.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function assertion(action) {
  const start = performance.now();
  action();
  assert.ok(performance.now() - start <= 5000, "positive assertion exceeded 5000ms");
}
function keys(value, names) {
  assert.deepEqual(Object.keys(value).sort(), [...names].sort());
}
function strictSummary(value) {
  keys(value, [
    "synthetic",
    "state",
    "datasetComplete",
    "datasetId",
    "version",
    "definitionDigest",
    "plan",
    "requests",
  ]);
  assert.equal(value.synthetic, true);
  assert.equal(value.datasetComplete, false);
  assert.equal(value.state, "six_month_seed_stages_verified");
  assert.equal(value.version, "us-processor-six-month-v1");
  const uuid = (id) =>
    assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  const digest = (id) => assert.match(id, /^[a-f0-9]{64}$/);
  uuid(value.datasetId);
  digest(value.definitionDigest);
  keys(value.plan, ["id", "sha256"]);
  uuid(value.plan.id);
  digest(value.plan.sha256);
  assert.deepEqual(
    value.requests.map((r) => r.unitKey),
    ["request_scenario_a", "request_april", "request_september"],
  );
  for (const row of value.requests) {
    keys(row, [
      "unitKey",
      "requestId",
      "runId",
      "inputDigest",
      "artifacts",
      "artifactsDigest",
      "publicationDigest",
    ]);
    uuid(row.requestId);
    uuid(row.runId);
    for (const name of ["inputDigest", "artifactsDigest", "publicationDigest"]) digest(row[name]);
    assert.ok(row.artifacts.length > 0 && row.artifacts.length <= 6);
    for (const artifact of row.artifacts) {
      keys(artifact, ["id", "sha256"]);
      uuid(artifact.id);
      digest(artifact.sha256);
    }
  }
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024);
}

test("actual compiled initialize then verify on one attested CI installation and real private provider", async () => {
  // The fixture refuses locally before DB, Docker, provider or checkout I/O; never skip.
  const f = await createDatasetPositiveFixture();
  let failure;
  try {
    const initialized = await f.command("initialize");
    assertion(() => strictSummary(initialized.summary));
    const before = await f.snapshot();
    const counts = f.observer.counts();
    assertion(() => assert.equal(counts.active, 0));
    const verified = await f.command("verify");
    const verifyCounts = f.observer.counts();
    const after = await f.snapshot();
    assertion(() => {
      strictSummary(verified.summary);
      assert.deepEqual(verified.summary, initialized.summary);
      assert.deepEqual(after, before);
      assert.ok(Object.keys(before).length > 190);
      assert.ok(verifyCounts.reads > counts.reads);
      assert.equal(verifyCounts.mutations - counts.mutations, 0);
      assert.equal(verifyCounts.failures - counts.failures, 0);
      assert.equal(verifyCounts.active, 0);
    });
    console.info(
      "Compiled verify persisted-state and provider evidence",
      JSON.stringify({
        tables: before,
        verifyRequests: {
          reads: verifyCounts.reads - counts.reads,
          mutations: 0,
          failures: 0,
          active: 0,
        },
      }),
    );
    const independentStart = performance.now();
    const summary = initialized.summary;
    console.info("Compiled dataset canonical stable summary", JSON.stringify(summary));
    const { schema } = f.require("@markiro/db");
    const { canonicalExportDigest } = f.require("@markiro/domain");
    const { unzipSync } = f.require("fflate");
    const { usSixMonthDefinition } = f.compiled(
      "modules/traceability/demo/us-six-month-definition",
    );
    const { parseUsDatasetPlanResult } = f.compiled(
      "modules/traceability/demo/us-dataset-plan-contract",
    );
    const { parseUsDatasetRequestResult } = f.compiled(
      "modules/traceability/demo/us-dataset-request-contract",
    );
    const { parseUsPlanPublishedRow } = f.compiled("modules/traceability/plans/us-plan-published");
    const { readUsRequestPublishedState } = f.compiled(
      "modules/traceability/requests/us-request-publication-read",
    );
    const { requireUsRequestPackageEvidence } = f.compiled(
      "modules/traceability/requests/us-request-run-evidence",
    );
    const { UsPlanArtifactStore } = f.compiled("modules/traceability/plans/us-plan-artifacts");
    const { UsRequestPackageArtifactStore } = f.compiled(
      "modules/traceability/requests/us-request-package-artifacts",
    );
    const { loadUsPlanArtifactStorageConfig } = f.compiled(
      "modules/traceability/plans/us-plan-artifact-config",
    );
    const { loadUsRequestPackageArtifactStorageConfig } = f.compiled(
      "modules/traceability/requests/us-request-package-artifact-config",
    );
    let plans, packages;
    try {
      plans = new UsPlanArtifactStore(loadUsPlanArtifactStorageConfig(f.environment));
      packages = new UsRequestPackageArtifactStore(
        loadUsRequestPackageArtifactStorageConfig(f.environment),
      );
      const datasets = await f.db.select().from(schema.traceabilityDemoDatasets);
      const stages = (
        await f.pool.query(
          "SELECT dataset_id,unit_key,stage,revision,input_digest,input,receipt FROM traceability_demo_dataset_stages WHERE tenant_id=$1 ORDER BY unit_key,stage",
          [f.identity.tenantId],
        )
      ).rows;
      const census = (
        await f.pool.query(
          "WITH roots AS (SELECT tenant_id,current_event_id FROM receiving_event_roots UNION ALL SELECT tenant_id,current_event_id FROM transformation_event_roots UNION ALL SELECT tenant_id,current_event_id FROM shipping_event_roots) SELECT (SELECT count(*)::int FROM roots WHERE tenant_id=$1) roots,(SELECT count(*)::int FROM roots r JOIN traceability_events e ON e.tenant_id=r.tenant_id AND e.id=r.current_event_id WHERE r.tenant_id=$1 AND e.status='finalized') finalized,(SELECT count(*)::int FROM traceability_lots WHERE tenant_id=$1) lots,(SELECT count(DISTINCT b.id)::int FROM boxes b JOIN traceability_synthetic_case_origins o ON o.tenant_id=b.tenant_id AND o.box_id=b.id WHERE b.tenant_id=$1) boxes",
          [f.identity.tenantId],
        )
      ).rows;
      assertion(() => {
        assert.equal(datasets.length, 1);
        assert.deepEqual(
          [
            datasets[0].id,
            datasets[0].version,
            datasets[0].definitionDigest,
            datasets[0].tenantId,
            datasets[0].createdBy,
          ],
          [
            summary.datasetId,
            summary.version,
            summary.definitionDigest,
            f.identity.tenantId,
            f.identity.userId,
          ],
        );
        assert.deepEqual(datasets[0].manifest, usSixMonthDefinition.manifest);
        assert.deepEqual(census, [{ roots: 964, finalized: 963, lots: 785, boxes: 15700 }]);
        assert.deepEqual(
          stages.map((s) => `${s.unit_key}:${s.stage}`).sort(),
          usSixMonthDefinition.units.flatMap((u) => u.stages.map((s) => `${u.key}:${s}`)).sort(),
        );
        assert.equal(stages.filter((s) => s.stage === "trace_readiness").length, 262);
        for (const stage of stages) {
          assert.equal(stage.dataset_id, summary.datasetId);
          assert.equal(stage.revision, 2);
          assert.ok(stage.receipt);
          assert.ok(Buffer.byteLength(JSON.stringify(stage.input)) <= 256 * 1024);
          assert.ok(Buffer.byteLength(JSON.stringify(stage.receipt)) <= 256 * 1024);
          assert.equal(stage.receipt.resultDigest, canonicalExportDigest(stage.receipt.result));
          assert.equal(stage.input_digest, canonicalExportDigest(stage.input));
          if (stage.stage === "trace_readiness") {
            assert.deepEqual(
              [
                stage.receipt.result.datasetId,
                stage.receipt.result.version,
                stage.receipt.result.definitionDigest,
                stage.receipt.result.unitKey,
              ],
              [summary.datasetId, summary.version, summary.definitionDigest, stage.unit_key],
            );
            assert.equal(stage.receipt.result.state, "trace_readiness_verified");
            assert.equal(stage.receipt.result.datasetComplete, false);
          }
        }
      });
      const planResult = parseUsDatasetPlanResult(
        stages.find((s) => s.unit_key === "plan").receipt.result,
      );
      const planRows = await f.db.select().from(schema.traceabilityPlanVersions);
      assertion(() => {
        assert.equal(planRows.length, 1);
        assert.equal(planRows[0].id, summary.plan.id);
      });
      const plan = parseUsPlanPublishedRow(planRows[0]);
      const pdf = await plans.readVerified(
        { tenantId: f.identity.tenantId, versionId: plan.id },
        plan.artifact,
      );
      assertion(() => {
        assert.deepEqual(
          [planResult.plan.id, planResult.artifact.sha256],
          [summary.plan.id, summary.plan.sha256],
        );
        assert.equal(planResult.approvedEvidenceDigest, canonicalExportDigest(plan.evidence));
        assert.equal(planResult.artifact.descriptorDigest, canonicalExportDigest(plan.artifact));
        assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
        assert.deepEqual(
          [pdf.length, hash(pdf)],
          [planResult.artifact.byteSize, summary.plan.sha256],
        );
      });
      const selections = [
        { key: "request_scenario_a", chains: ["chain_0259"] },
        {
          key: "request_april",
          chains: Array.from({ length: 12 }, (_, i) => `chain_${String(i).padStart(4, "0")}`),
        },
        {
          key: "request_september",
          chains: Array.from({ length: 12 }, (_, i) => `chain_${String(i + 208).padStart(4, "0")}`),
        },
      ];
      for (const [index, selection] of selections.entries()) {
        const result = parseUsDatasetRequestResult(
          stages.find((s) => s.unit_key === selection.key && s.stage === "package").receipt.result,
        );
        const publication = await f.db.transaction((tx) =>
          readUsRequestPublishedState(tx, f.identity.tenantId, result.run.id),
        );
        const capture = requireUsRequestPackageEvidence(
          publication.run,
          f.identity.tenantId,
        ).validationSnapshot;
        const events = (
          await f.pool.query(
            "SELECT DISTINCT e.id AS \"eventId\",e.revision,e.root_event_id AS \"rootEventId\",'match' AS reason FROM traceability_demo_dataset_stages s CROSS JOIN LATERAL jsonb_array_elements_text(s.receipt->'recordIds') ids(id) JOIN traceability_events e ON e.id=ids.id::uuid AND e.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.unit_key=ANY($2) AND s.stage IN ('receiving','transformation','shipping') ORDER BY e.id",
            [f.identity.tenantId, selection.chains],
          )
        ).rows;
        const lots = (
          await f.pool.query(
            "SELECT DISTINCT l.id FROM traceability_demo_dataset_stages s CROSS JOIN LATERAL jsonb_array_elements_text(s.receipt->'recordIds') ids(id) JOIN traceability_lots l ON l.id=ids.id::uuid AND l.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.unit_key=ANY($2) AND s.stage IN ('receiving','transformation') ORDER BY l.id",
            [f.identity.tenantId, selection.chains],
          )
        ).rows;
        assertion(() => {
          for (const part of [planResult, result])
            assert.deepEqual(
              [part.datasetId, part.version, part.definitionDigest],
              [summary.datasetId, summary.version, summary.definitionDigest],
            );
          assert.deepEqual(summary.requests[index], {
            unitKey: result.unitKey,
            requestId: result.request.id,
            runId: result.run.id,
            inputDigest: result.run.inputDigest,
            artifacts: result.artifacts.map(({ id, sha256 }) => ({ id, sha256 })),
            artifactsDigest: result.artifactsDigest,
            publicationDigest: result.publicationDigest,
          });
          assert.equal(publication.run.status, "ready");
          assert.equal(publication.run.mode, "export_ready");
          assert.equal(publication.run.planVersionId, plan.id);
          assert.deepEqual(result.plan, summary.plan);
          assert.deepEqual(
            result.artifacts,
            publication.artifacts.map(({ objectKey, tenantId, runId, ...descriptor }) => {
              void objectKey;
              void tenantId;
              void runId;
              return descriptor;
            }),
          );
          assert.deepEqual(
            [...capture.selection.records].sort((a, b) => a.eventId.localeCompare(b.eventId)),
            events,
          );
          assert.deepEqual(
            capture.selection.lotIds,
            lots.map(({ id }) => id),
          );
          assert.ok(
            capture.selection.records.length >= selection.chains.length * 3 &&
              capture.selection.records.length < 500,
          );
          assert.ok(
            Buffer.byteLength(JSON.stringify(publication.run.inputSnapshot)) < 16 * 1024 * 1024,
          );
          assert.equal(canonicalExportDigest(publication.artifacts), result.artifactsDigest);
          assert.equal(
            canonicalExportDigest({
              ...publication,
              run: Object.fromEntries(
                Object.entries(publication.run).map(([key, value]) => [
                  key,
                  value instanceof Date ? value.toISOString() : value,
                ]),
              ),
            }),
            result.publicationDigest,
          );
        });
        const objects = new Map();
        for (const artifact of publication.artifacts) {
          const bytes = await packages.readVerified(
            { tenantId: f.identity.tenantId, runId: result.run.id },
            artifact,
          );
          assertion(() =>
            assert.deepEqual([bytes.length, hash(bytes)], [artifact.byteSize, artifact.sha256]),
          );
          objects.set(artifact.name, bytes);
        }
        const entries = unzipSync(objects.get("package.zip"));
        assertion(() => {
          assert.deepEqual(
            Object.keys(entries).sort(),
            publication.expectation.entries.map(({ name }) => name).sort(),
          );
          for (const entry of publication.expectation.entries)
            assert.deepEqual(
              [entries[entry.name].length, hash(entries[entry.name])],
              [entry.byteSize, entry.sha256],
            );
          assert.deepEqual(
            JSON.parse(Buffer.from(entries["manifest.json"]).toString()),
            publication.expectation.manifest,
          );
          assert.deepEqual(Buffer.from(entries["plan.pdf"]), pdf);
          assert.equal(
            Buffer.from(entries["request-report.pdf"]).subarray(0, 5).toString(),
            "%PDF-",
          );
        });
        console.info(
          "Compiled publication private bytes verified",
          JSON.stringify({
            unitKey: selection.key,
            chains: selection.chains.length,
            records: capture.selection.records.length,
            lots: capture.selection.lotIds.length,
            artifacts: result.artifacts,
          }),
        );
      }
    } finally {
      packages?.destroy();
      plans?.onModuleDestroy();
    }
    assert.ok(
      performance.now() - independentStart <= 60_000,
      "independent acceptance exceeded60000ms",
    );
    console.info(
      "Compiled dataset observed measurements",
      JSON.stringify({
        initialize: { elapsedMs: initialized.elapsedMs, maximumRssKiB: initialized.maximumRssKiB },
        verify: { elapsedMs: verified.elapsedMs, maximumRssKiB: verified.maximumRssKiB },
        databaseBytes: (
          await f.pool.query("SELECT pg_database_size(current_database())::text AS bytes")
        ).rows[0].bytes,
        privateBytes: await f.privateBytes(),
      }),
    );
  } catch (error) {
    failure = error;
  }
  try {
    await f.close();
  } catch (error) {
    throw new AggregateError(
      [...(failure ? [failure] : []), error],
      "us_dataset_positive_failed_disposal",
      { cause: error },
    );
  }
  if (failure) throw failure;
});
