import { createDb, schema } from "@markiro/db";
import {
  transformationFinalizationSnapshotV2Schema,
  type ExportSourceRecord,
} from "@markiro/platform-contracts";
import {
  assessFrozenReadiness,
  buildUsExportWorkbook,
  traceExportRegistryHash,
} from "@markiro/domain";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { UsTraceStore } from "../src/modules/traceability/trace/us-trace-store";
import { readUsReadinessEvidence } from "../src/modules/traceability/trace/us-readiness-evidence";
import { transformationTransaction } from "../src/modules/traceability/transformation/us-transformation-operations";
import { readUsExportSources } from "../src/modules/traceability/export/source-reader";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { UsRequestValidationStore } from "../src/modules/traceability/requests/us-request-validation";
import { seedUsRequestPayloadPlan } from "./support/us-request-payload-fixture";
import { UsEventsStore } from "../src/modules/traceability/events/us-events-store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  seedFinalizableTransformation,
  type TransformationFixtureDatabase,
} from "./support/us-transformation-finalization-fixture";
import { createUsProfileTestDatabase } from "./support/us-profile-database";

const base = process.env.US_TEST_DATABASE_URL;
function exportRows(events: readonly ExportSourceRecord[], tenantId: string) {
  const workbook = buildUsExportWorkbook({
    schemaVersion: 1,
    tenantId,
    mode: "export_ready_candidate",
    events,
    findings: [],
    metadata: {
      mode: "export_ready_candidate",
      profile: "US_FSMA204_PROCESSOR",
      scopeLabel: "Native captured V2",
      timeZone: "America/Chicago",
      generatedAt: "2026-10-04T00:00:00.000Z",
      baselineId: "US-REG-2026-09-03",
      registryId: "fda_sortable_xlsx",
      registryVersion: 1,
      registryHash: traceExportRegistryHash(),
      build: { apiVersion: "native-v2", gitSha: "a".repeat(40), dirty: true },
    },
  });
  expect(workbook.failure).toBeNull();
  const sheet = workbook.model?.sheets.find((entry) => entry.name === "Transformation");
  if (!sheet) throw new Error("Missing native Transformation export sheet");
  return sheet.rows.map((row) => ({
    values: Object.fromEntries(
      sheet.columns.map((column, index) => [column.key, row.cells[index]?.value]),
    ),
  }));
}
describe.skipIf(!base)("native structured Transformation snapshots", () => {
  let f: TransformationFixtureDatabase;
  let databaseName: string;
  const work = new Set<Promise<unknown>>();
  function track<T>(promise: Promise<T>) {
    work.add(promise);
    void promise.then(
      () => work.delete(promise),
      () => work.delete(promise),
    );
    return promise;
  }
  beforeAll(async () => {
    if (!base) throw new Error("Missing synthetic database");
    await track(
      createUsProfileTestDatabase(base).then(async (value) => {
        f = value;
        const name = (await f.pool.query<{ name: string }>("SELECT current_database() AS name"))
          .rows[0]?.name;
        if (!name) throw new Error("Missing owned child identity");
        databaseName = name;
        process.stdout.write(`Owned structured snapshot database: ${databaseName}\n`);
      }),
    );
  }, 60_000);
  afterAll(async () => {
    while (work.size) await Promise.allSettled([...work]);
    await f?.close();
    if (base && databaseName) {
      const admin = createDb(base);
      try {
        expect(
          (
            await admin.pool.query("SELECT datname FROM pg_database WHERE datname=$1", [
              databaseName,
            ])
          ).rows,
        ).toEqual([]);
        process.stdout.write(
          `Disposed structured snapshot database: ${databaseName}; work drained; catalog absent\n`,
        );
      } finally {
        await admin.pool.end();
      }
    }
  }, 60_000);

  it("captures exact product, processor and reference-source KDEs from native finalization", () =>
    track(
      (async () => {
        const c = await seedFinalizableTransformation(f, true);
        const result = await c.store.finalize(
          c.tenant,
          c.actor,
          c.saved.id,
          c.command,
          "structured-native",
        );
        expect(result.snapshot.snapshotVersion).toBe(2);
        const snapshot = transformationFinalizationSnapshotV2Schema.parse(result.snapshot);
        const [processor] = await f.db
          .select()
          .from(schema.traceabilityLocations)
          .where(eq(schema.traceabilityLocations.id, c.processor));
        if (!processor) throw new Error("Missing locked processor fixture");
        const product = {
          snapshotVersion: 1,
          sourceProductId: c.product,
          productName: "Synthetic apples",
          brandName: null,
          commodity: null,
          variety: null,
          packagingSize: null,
          packagingStyle: null,
          gtin: null,
        };
        expect(snapshot.inputs.map((line) => line.product.kdes)).toEqual([product, product]);
        expect(snapshot.outputs[0]?.product.kdes).toEqual(product);
        expect(snapshot.processor.kdes).toEqual({
          schemaVersion: 1,
          partyId: processor.partyId,
          locationId: c.processor,
          businessName: "Synthetic processor",
          phoneNumber: "+1 555 020 0200",
          address: { kind: "street", streetAddress: "2 Processing Street" },
          city: "Madison",
          stateOrRegion: "WI",
          zipOrPostalCode: "53703",
          countryCode: "US",
          countryDisplay: "United States",
        });
        expect(snapshot.inputs[0]?.source).toEqual({
          kind: "reference",
          id: c.location,
          description: "Synthetic supplier, 1 Test Street, Chicago, IL, 60601, US, +1 555 010 0100",
          referenceKind: "web_url",
          referenceValue: "https://supplier.example.test/source/Ä?lot=001",
          kdes: {
            schemaVersion: 1,
            partyId: c.party,
            locationId: c.location,
            businessName: "Synthetic supplier",
            phoneNumber: "+1 555 010 0100",
            address: { kind: "street", streetAddress: "1 Test Street" },
            city: "Chicago",
            stateOrRegion: "IL",
            zipOrPostalCode: "60601",
            countryCode: "US",
            countryDisplay: "United States",
          },
        });
        expect(snapshot.outputs[0]?.source).toEqual({ kind: "location", ...snapshot.processor });
      })(),
    ));

  it("keeps captured KDEs and exported cells frozen after actual product and location master edits", () =>
    track(
      (async () => {
        const c = await seedFinalizableTransformation(f, true, true);
        await f.db
          .update(schema.productTraceabilityProfiles)
          .set({
            brandName: "Captured brand",
            commodity: "Apples",
            variety: "Gala",
            packagingSizeValue: "25.000",
            packagingSizeUom: "lb",
            packagingStyle: "case",
          })
          .where(eq(schema.productTraceabilityProfiles.productId, c.product));
        const ready = await c.store.checkReadiness(c.tenant, c.actor, c.saved.id, {
          expectedDraftVersion: 1,
        });
        const command = { ...c.command, expectedInputDigest: ready.inputDigest };
        const result = await c.store.finalize(
          c.tenant,
          c.actor,
          c.saved.id,
          command,
          "native-drift",
        );
        const snapshot = transformationFinalizationSnapshotV2Schema.parse(result.snapshot);
        expect(snapshot.inputs[0]?.product.kdes).toEqual({
          snapshotVersion: 1,
          sourceProductId: c.product,
          productName: "Synthetic apples",
          brandName: "Captured brand",
          commodity: "Apples",
          variety: "Gala",
          packagingSize: { value: "25.000", uom: "lb" },
          packagingStyle: "case",
          gtin: null,
        });
        expect(snapshot.inputs[0]?.product.description).toBe(
          "Synthetic apples, Captured brand, Apples, Gala, 25.000 lb, case",
        );
        const pins = [{ eventId: result.id, revision: 1 }];
        const sources = await readUsExportSources(
          f.db,
          c.tenant,
          c.actor,
          pins,
          "export_ready_candidate",
        );
        const rows = exportRows(sources, c.tenant);
        expect(
          rows.map((row) => [
            row.values.product_name,
            row.values.product_packaging_size_value,
            row.values.tlc_source_business_name,
            row.values.transformation_location_business_name,
            row.values.snapshot_version,
          ]),
        ).toEqual([
          ["Synthetic apples", "25.000", "Synthetic supplier", "Synthetic processor", 2],
          ["Synthetic apples", "25.000", "Synthetic supplier", "Synthetic processor", 2],
          ["Synthetic apples", "25.000", "Synthetic processor", "Synthetic processor", 2],
        ]);
        await seedUsRequestPayloadPlan(f.db, c);
        const request = await new UsRequestStore(f.db).create(c.tenant, c.actor, {
          requestNumber: randomUUID(),
          requesterName: "Native V2 capture",
          requesterOrganization: null,
          requesterContact: null,
          receivedAt: "2026-10-04T00:00:00Z",
          scope: { lotId: snapshot.outputs[0]!.lotId },
        });
        const validation = await new UsRequestValidationStore(f.db).validate(
          c.tenant,
          c.actor,
          request.id,
          { apiVersion: "native-v2", gitSha: "a".repeat(40), dirty: true },
        );
        expect(validation.matchedRevisionCount).toBe(2);
        expect(validation.findings.filter((finding) => finding.severity !== "info")).toEqual([]);
        expect(
          validation.findings.filter((finding) => finding.code === "REQUIRED_KDE_MISSING"),
        ).toEqual([]);
        expect(
          validation.findings.filter(
            (finding) =>
              finding.code === "NUMERIC_LEXEME_PRESERVED_AS_TEXT" &&
              finding.sourceRecord.startsWith("transformation:"),
          ),
        ).toHaveLength(3);
        expect(
          validation.findings
            .filter((finding) => finding.code === "NUMERIC_LEXEME_PRESERVED_AS_TEXT")
            .every((finding) => finding.severity === "info"),
        ).toBe(true);
        await f.db
          .update(schema.products)
          .set({ name: "Current renamed master" })
          .where(eq(schema.products.id, c.product));
        await f.db
          .update(schema.productTraceabilityProfiles)
          .set({
            productName: "Current profile",
            brandName: "Current brand",
            packagingSizeValue: "99.0",
          })
          .where(eq(schema.productTraceabilityProfiles.productId, c.product));
        for (const id of [c.location, c.processor])
          await f.db
            .update(schema.traceabilityLocations)
            .set({ businessName: "Current facility", streetAddress: "99 Current Street" })
            .where(eq(schema.traceabilityLocations.id, id));
        expect(await c.store.getRecord(c.tenant, c.actor, result.id)).toEqual(result);
        expect(await c.store.finalize(c.tenant, c.actor, result.id, command, "v2-replay")).toEqual(
          result,
        );
        expect(
          await readUsExportSources(f.db, c.tenant, c.actor, pins, "export_ready_candidate"),
        ).toEqual(sources);
        expect(
          exportRows(
            await readUsExportSources(f.db, c.tenant, c.actor, pins, "export_ready_candidate"),
            c.tenant,
          ),
        ).toEqual(rows);
      })(),
    ));

  it("accepts native V2 in current Trace, lot card, genealogy and Readiness including lot-scoped candidates", () =>
    track(
      (async () => {
        const c = await seedFinalizableTransformation(f);
        const result = await c.store.finalize(
          c.tenant,
          c.actor,
          c.saved.id,
          c.command,
          "native-readers",
        );
        expect(result.snapshot.snapshotVersion).toBe(2);
        const output = result.snapshot.outputs[0];
        if (!output) throw new Error("Missing output fixture");
        const trace = new UsTraceStore(f.db);
        expect(
          (
            await new UsEventsStore(f.db).list(c.tenant, c.actor, { type: "transformation" })
          ).items.map((event) => event.id),
        ).toEqual([result.id]);
        const graph = await trace.read(c.tenant, c.actor, output.lotId, { direction: "backward" });
        expect(graph).toMatchObject({ completion: { state: "complete" }, findings: [] });
        const genealogy = await c.store.getGenealogy(c.tenant, c.actor, {
          startLotId: output.lotId,
          direction: "upstream",
          mode: "current",
          maxDepth: 20,
          maxNodes: 500,
        });
        expect(genealogy).toMatchObject({ complete: true, selectedRevisionIds: [result.id] });
        expect(genealogy.events[0]?.snapshot).toEqual(result.snapshot);
        expect(await trace.card(c.tenant, c.actor, output.lotId)).toMatchObject({
          originState: "current",
          currentOriginProducts: [
            { kind: "transformation", productId: c.product, description: "Synthetic apples" },
          ],
        });
        expect(
          (await trace.cardEvidence(c.tenant, c.actor, output.lotId, {})).items[0],
        ).toMatchObject({ eventId: result.id, type: "transformation" });
        for (const lotId of [null, output.lotId]) {
          const evidence = await transformationTransaction(f.db, (tx) =>
            readUsReadinessEvidence(tx, c.tenant, {
              eventDateFrom: "2026-09-26",
              eventDateTo: "2026-09-26",
              lotId,
              productId: null,
              profileCode: "US_FSMA204_PROCESSOR",
              defaulted: false,
            }),
          );
          expect(evidence.selectedEventCount).toBe(1);
          expect(evidence.facts.events[0]?.id).toBe(result.id);
        }
      })(),
    ));

  it("replays a saved V1 receipt exactly and amends its unchanged predecessor into V2 with the same output identity", () =>
    track(
      (async () => {
        const c = await seedFinalizableTransformation(f);
        const result = await c.store.finalize(
          c.tenant,
          c.actor,
          c.saved.id,
          c.command,
          "legacy-setup",
        );
        const { processor, inputs, outputs, ...header } =
          transformationFinalizationSnapshotV2Schema.parse(result.snapshot);
        const legacy = {
          ...result,
          snapshot: {
            ...header,
            snapshotVersion: 1,
            processor: { id: processor.id, description: processor.description },
            inputs: inputs.map(({ product, source, ...line }) => ({
              ...line,
              product: {
                id: product.id,
                description: product.description,
                coverage: product.coverage,
              },
              source:
                source.kind === "reference"
                  ? {
                      kind: source.kind,
                      id: source.id,
                      description: source.description,
                      referenceKind: source.referenceKind,
                      referenceValue: source.referenceValue,
                    }
                  : { kind: source.kind, id: source.id, description: source.description },
            })),
            outputs: outputs.map(({ product, source, ...line }) => ({
              ...line,
              product: {
                id: product.id,
                description: product.description,
                coverage: product.coverage,
              },
              source: { kind: source.kind, id: source.id, description: source.description },
            })),
          },
        };
        await f.db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
          await tx
            .update(schema.traceabilityEvents)
            .set({ finalizationSnapshot: legacy.snapshot })
            .where(eq(schema.traceabilityEvents.id, result.id));
          await tx
            .update(schema.transformationOperations)
            .set({ result: legacy })
            .where(eq(schema.transformationOperations.operationKey, c.command.operationKey));
        });
        const before = (
          await f.pool.query<{ bytes: string }>(
            "SELECT finalization_snapshot::text AS bytes FROM traceability_events WHERE id=$1",
            [result.id],
          )
        ).rows[0]?.bytes;
        const receiptBefore = (
          await f.pool.query<{ bytes: string }>(
            "SELECT result::text AS bytes FROM transformation_operations WHERE tenant_id=$1 AND command='transformation.finalize' AND operation_key=$2",
            [c.tenant, c.command.operationKey],
          )
        ).rows[0]?.bytes;
        expect(
          await c.store.finalize(c.tenant, c.actor, result.id, c.command, "legacy-replay"),
        ).toEqual(legacy);
        expect(await c.store.getRecord(c.tenant, c.actor, result.id)).toEqual(legacy);
        // V1's existing nullable business lens must still produce a finding,
        // while the malformed V2 cases below must fail closed.
        await f.db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
          await tx.execute(
            sql`UPDATE traceability_events SET finalization_snapshot=jsonb_set(finalization_snapshot,'{inputs,0,product,description}','null'::jsonb) WHERE id=${result.id}`,
          );
        });
        const legacyEvidence = await transformationTransaction(f.db, (tx) =>
          readUsReadinessEvidence(tx, c.tenant, {
            eventDateFrom: "2026-09-26",
            eventDateTo: "2026-09-26",
            lotId: null,
            productId: null,
            profileCode: "US_FSMA204_PROCESSOR",
            defaulted: false,
          }),
        );
        expect(
          assessFrozenReadiness({ ...legacyEvidence.facts, profileCode: "US_FSMA204_PROCESSOR" }),
        ).toContainEqual(
          expect.objectContaining({
            eventId: result.id,
            code: "required_kde",
            field: "lines.inputs[1].productDescription",
          }),
        );
        await f.db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
          await tx
            .update(schema.traceabilityEvents)
            .set({ finalizationSnapshot: legacy.snapshot })
            .where(eq(schema.traceabilityEvents.id, result.id));
        });
        await f.db
          .update(schema.productTraceabilityProfiles)
          .set({ productName: "Amendment captured apples" })
          .where(eq(schema.productTraceabilityProfiles.productId, c.product));
        const amendment = await c.store.amend(
          c.tenant,
          c.actor,
          result.id,
          {
            operationKey: randomUUID(),
            expectedLifecycleVersion: 2,
            reason: "Capture updated facts",
          },
          "legacy-amend",
        );
        if (amendment.record.status !== "draft") throw new Error("Expected amendment draft");
        const ready = await c.store.checkReadiness(c.tenant, c.actor, amendment.record.id, {
          expectedDraftVersion: 1,
        });
        const amended = await c.store.finalize(
          c.tenant,
          c.actor,
          amendment.record.id,
          {
            operationKey: randomUUID(),
            expectedDraftVersion: 1,
            expectedInputDigest: ready.inputDigest,
          },
          "legacy-amend-finalize",
        );
        const v2 = transformationFinalizationSnapshotV2Schema.parse(amended.snapshot);
        expect(v2).toMatchObject({
          revision: 2,
          previousRevisionId: result.id,
          outputs: [
            {
              lotId: outputs[0]?.lotId,
              product: { id: c.product, kdes: { productName: "Amendment captured apples" } },
              tlc: "NEW-OUTPUT",
              source: { id: c.processor },
            },
          ],
        });
        expect(
          (
            await f.pool.query<{ bytes: string }>(
              "SELECT finalization_snapshot::text AS bytes FROM traceability_events WHERE id=$1",
              [result.id],
            )
          ).rows[0]?.bytes,
        ).toBe(before);
        expect(
          await c.store.finalize(
            c.tenant,
            c.actor,
            result.id,
            c.command,
            "legacy-replay-after-amend",
          ),
        ).toEqual(legacy);
        expect(
          (
            await f.pool.query<{ bytes: string }>(
              "SELECT result::text AS bytes FROM transformation_operations WHERE tenant_id=$1 AND command='transformation.finalize' AND operation_key=$2",
              [c.tenant, c.command.operationKey],
            )
          ).rows[0]?.bytes,
        ).toBe(receiptBefore);
      })(),
    ));

  it.each(["missing", "forged", "unknown"] as const)(
    "rejects %s V2 in Readiness rather than reporting complete",
    (kind) =>
      track(
        (async () => {
          const c = await seedFinalizableTransformation(f);
          const result = await c.store.finalize(
            c.tenant,
            c.actor,
            c.saved.id,
            c.command,
            "malformed-native",
          );
          await f.db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
            if (kind === "missing")
              await tx.execute(
                sql`UPDATE traceability_events SET finalization_snapshot=finalization_snapshot #- '{processor,kdes}' WHERE id=${result.id}`,
              );
            else if (kind === "forged")
              await tx.execute(
                sql`UPDATE traceability_events SET finalization_snapshot=jsonb_set(finalization_snapshot,'{processor,kdes,locationId}',to_jsonb(${randomUUID()}::text)) WHERE id=${result.id}`,
              );
            else
              await tx.execute(
                sql`UPDATE traceability_events SET finalization_snapshot=jsonb_set(finalization_snapshot,'{snapshotVersion}','3'::jsonb) WHERE id=${result.id}`,
              );
          });
          await expect(
            transformationTransaction(f.db, (tx) =>
              readUsReadinessEvidence(tx, c.tenant, {
                eventDateFrom: "2026-09-26",
                eventDateTo: "2026-09-26",
                lotId: result.snapshot.outputs[0]!.lotId,
                productId: null,
                profileCode: "US_FSMA204_PROCESSOR",
                defaulted: false,
              }),
            ),
          ).rejects.toMatchObject({ response: { code: "us_database_unavailable" } });
        })(),
      ),
  );
});
