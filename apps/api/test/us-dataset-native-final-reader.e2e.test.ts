import { randomUUID } from "node:crypto";
import { US_CAPABILITY } from "@markiro/domain";
import type { createDb } from "@markiro/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as receivingVerification from "../src/modules/traceability/demo/us-dataset-receiving-verify";
import * as transformationVerification from "../src/modules/traceability/demo/us-dataset-transformation-verify";
import * as casesVerification from "../src/modules/traceability/demo/us-dataset-cases-verify";
import * as correctedCasesVerification from "../src/modules/traceability/demo/us-dataset-corrected-cases-verify";
import * as finalVerification from "../src/modules/traceability/demo/us-dataset-native-final-verify";
import * as correctedShippingVerification from "../src/modules/traceability/demo/us-dataset-corrected-shipping-verify";
import * as journalContract from "../src/modules/traceability/demo/us-demo-journal-contract";
import {
  parseUsDatasetSpecialResult,
  usDatasetSpecialRecordIds,
} from "../src/modules/traceability/demo/us-dataset-special-contract";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetReceivingSeedStore } from "../src/modules/traceability/demo/us-dataset-receiving-seed";
import { UsDatasetTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-transformation-seed";
import { UsDatasetCasesSeedStore } from "../src/modules/traceability/demo/us-dataset-cases-seed";
import { UsDatasetSpecialSeedStore } from "../src/modules/traceability/demo/us-dataset-special-seed";
import { UsDatasetCorrectedTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-transformation-seed";
import { UsDatasetCorrectedCasesSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-cases-seed";
import { UsDatasetCorrectedShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-shipping-seed";
import { datasetTransformationStores } from "./support/us-dataset-transformation-fixture";
import { driverCode, outcome } from "./support/us-transformation-lock-fixture";
import { specialFixture, specialFault } from "./support/us-dataset-special-fixture";

const base = process.env.US_TEST_DATABASE_URL;
function observe(pool: ReturnType<typeof createDb>["pool"]) {
  type Client = NonNullable<Parameters<Parameters<typeof pool.connect>[0]>[1]>;
  const queries: string[] = [];
  const restores = new Map<Client, () => void>();
  const acquire = (client: Client) => {
    if (restores.has(client)) return;
    const query = client.query;
    client.query = new Proxy(query, {
      apply(target, receiver, values: unknown[]) {
        const first = values[0];
        queries.push(
          typeof first === "string"
            ? first
            : first &&
                typeof first === "object" &&
                "text" in first &&
                typeof first.text === "string"
              ? first.text
              : "",
        );
        return Reflect.apply(target, receiver, values);
      },
    });
    restores.set(client, () => {
      client.query = query;
    });
  };
  pool.on("acquire", acquire);
  return {
    queries,
    close() {
      pool.off("acquire", acquire);
      for (const restore of restores.values()) restore();
    },
  };
}
describe.skipIf(!base)("native final-verifier protected raw rows", () => {
  const h = specialFixture(base);
  beforeEach(
    h.phase(async () => {
      await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
      await new UsDatasetReceivingSeedStore(h.f.db).initialize(h.context, 0);
      await new UsDatasetTransformationSeedStore(h.f.db).initialize(h.context, 0);
    }),
    60_000,
  );

  it(
    "extracts exact IDs from its own immutable Special result without reparsing and distrusts copies",
    h.phase(async () => {
      const result = parseUsDatasetSpecialResult(
        await new UsDatasetSpecialSeedStore(h.f.db).initialize(h.context, "correction"),
      );
      if (result.stage !== "amend_receiving") throw new Error("Missing real amendment");
      const expected = [
        ...result.original.documents.map(({ record }) => record.id),
        result.original.created.eventId,
        ...result.original.lots.map(({ id }) => id),
        result.finalized.eventId,
      ];
      const callerCopy = structuredClone(result);
      const frozenCopy = Object.freeze(structuredClone(result));
      const proxy = new Proxy(result, {});
      const guard = vi
        .spyOn(journalContract, "assertBoundedSyntheticJson")
        .mockImplementation(() => {
          throw new Error("untrusted_special_json_witness");
        });
      try {
        const first = usDatasetSpecialRecordIds(result);
        const second = usDatasetSpecialRecordIds(result);
        expect(first).toEqual(expected);
        expect(second).toEqual(expected);
        expect(first).not.toBe(second);
        expect(Object.isFrozen(first)).toBe(true);
        expect(guard).not.toHaveBeenCalled();
        for (const untrusted of [callerCopy, frozenCopy, proxy]) {
          expect(() => usDatasetSpecialRecordIds(untrusted)).toThrow(
            "us_dataset_special_result_invalid",
          );
        }
        expect(guard).toHaveBeenCalledTimes(3);
      } finally {
        guard.mockRestore();
      }
      expect(Reflect.set(callerCopy, "stage", "untrusted")).toBe(true);
      expect(() => usDatasetSpecialRecordIds(callerCopy)).toThrow(
        "us_dataset_special_result_invalid",
      );
    }),
  );

  it(
    "Receiving retains locked documents and keeps unobserved lots and membership fresh",
    h.phase(async () => {
      const original = receivingVerification.verifyUsDatasetReceivingResultCore;
      const observation = observe(h.f.pool);
      const spy = vi
        .spyOn(receivingVerification, "verifyUsDatasetReceivingResultCore")
        .mockImplementation(async (...args) => {
          const result = await original(...args);
          const [tx, context, , , d] = args;
          const lot = result.lots[0],
            document = result.documents[0];
          if (!lot || !document) throw new Error("Missing real fixture rows");
          const start = observation.queries.length;
          for (let i = 0; i < 2; i++) {
            expect(
              await d.lots.getLotInTransaction(tx, context.tenantId, context.actorUserId, lot.id),
            ).toEqual(lot);
            expect(
              await d.documents.getDocumentInTransaction(
                tx,
                context.tenantId,
                context.actorUserId,
                document.record.id,
              ),
            ).toEqual(document.record);
          }
          const queries = observation.queries.slice(start);
          expect(queries.filter((text) => text.includes('from "traceability_lots"'))).toHaveLength(
            2,
          );
          expect(
            queries.filter((text) => text.includes('from "reference_documents"')),
          ).toHaveLength(0);
          expect(queries.filter((text) => text.includes('from "member"'))).toHaveLength(4);
          const controlStart = observation.queries.length;
          const control = datasetTransformationStores(h.f.db);
          for (let i = 0; i < 2; i++) {
            await control.lots.getLotInTransaction(
              tx,
              context.tenantId,
              context.actorUserId,
              lot.id,
            );
            await control.documents.getDocumentInTransaction(
              tx,
              context.tenantId,
              context.actorUserId,
              document.record.id,
            );
          }
          const controlQueries = observation.queries.slice(controlStart);
          expect(
            controlQueries.filter(
              (text) =>
                text.includes('from "traceability_lots"') ||
                text.includes('from "reference_documents"'),
            ),
          ).toHaveLength(4);
          return result;
        });
      try {
        await new UsDatasetReceivingSeedStore(h.f.db).verify(h.context, 0);
        expect(spy).toHaveBeenCalledOnce();
      } finally {
        spy.mockRestore();
        observation.close();
      }
    }),
  );

  it(
    "Cases uses its own bounded final owner and revokes before returning",
    h.phase(async () => {
      const original = casesVerification.verifyUsDatasetCasesOriginCore;
      let after: (() => unknown) | undefined;
      const spy = vi
        .spyOn(casesVerification, "verifyUsDatasetCasesOriginCore")
        .mockImplementation(async (...args) => {
          const result = await original(...args);
          const [tx, context, , , , d] = args;
          after = () => d.points.event(tx, context.tenantId, result.transformation.created.id);
          return result;
        });
      try {
        const result = await new UsDatasetCasesSeedStore(h.f.db).initialize(h.context, 0);
        expect(result.linked.created).toHaveLength(55);
        expect(spy).toHaveBeenCalledOnce();
        if (!after) throw new Error("Missing final-owner witness");
        await expect(Promise.resolve().then(after)).rejects.toThrow(
          "us_dataset_terminal_reader_binding_invalid",
        );
      } finally {
        spy.mockRestore();
      }
    }),
  );

  it(
    "corrected final owners preserve their fixed adapters and fresh unsupported observations",
    h.phase(async () => {
      const lifecycle = await new UsDatasetSpecialSeedStore(h.f.db).initialize(
        h.context,
        "correction",
      );
      if (lifecycle.stage !== "amend_receiving") throw new Error("Missing real amendment");
      const origin = await new UsDatasetCorrectedTransformationSeedStore(h.f.db).initialize(
        h.context,
      );
      const original = correctedCasesVerification.verifyUsDatasetCorrectedCasesCore;
      const observation = observe(h.f.pool);
      let checked = false;
      const revoked: (() => unknown)[] = [];
      const spy = vi
        .spyOn(correctedCasesVerification, "verifyUsDatasetCorrectedCasesCore")
        .mockImplementation(async (...args) => {
          await original(...args);
          const [tx, context, , , , d] = args;
          expect(Object.keys(d.locks)).toHaveLength(10);
          await expect(
            Promise.resolve().then(() =>
              d.locks.receivingRoot(tx, randomUUID(), origin.input.receivingOrigin.rootId),
            ),
          ).rejects.toThrow("us_dataset_terminal_reader_binding_invalid");
          await expect(
            Promise.resolve().then(() =>
              d.journal.readHeaderInTransaction(tx, {
                ...context,
                expectedDatabaseName: "wrong_database",
              }),
            ),
          ).rejects.toThrow("us_dataset_terminal_reader_binding_invalid");
          revoked.push(
            () => d.locks.receivingRoot(tx, context.tenantId, origin.input.receivingOrigin.rootId),
            () => d.locks.transformationRevision(tx, context.tenantId, origin.created.id),
          );
          const start = observation.queries.length;
          for (let i = 0; i < 2; i++) {
            expect(
              await d.points.event(tx, context.tenantId, origin.input.receivingOrigin.eventId),
            ).toMatchObject({ id: origin.input.receivingOrigin.eventId });
            expect(await d.points.lot(tx, context.tenantId, origin.outputLot.id)).toMatchObject({
              id: origin.outputLot.id,
            });
          }
          const queries = observation.queries.slice(start);
          expect(
            queries.filter((text) => text.includes('from "traceability_events"')),
          ).toHaveLength(2);
          expect(queries.filter((text) => text.includes('from "traceability_lots"'))).toHaveLength(
            2,
          );
          checked = true;
        });
      try {
        await new UsDatasetCorrectedCasesSeedStore(h.f.db).initialize(h.context);
        expect(checked).toBe(true);
        spy.mockRestore();
        for (const read of revoked)
          await expect(Promise.resolve().then(read)).rejects.toThrow(
            "us_dataset_terminal_reader_binding_invalid",
          );
        revoked.length = 0;
        const shippingCore = correctedShippingVerification.verifyUsDatasetCorrectedShippingCore;
        const shippingSpy = vi
          .spyOn(correctedShippingVerification, "verifyUsDatasetCorrectedShippingCore")
          .mockImplementation(async (...args) => {
            const [tx, context, , , d] = args;
            expect(Object.keys(d.locks)).toHaveLength(13);
            await expect(
              Promise.resolve().then(() =>
                d.locks.receivingRoot(tx, randomUUID(), origin.input.receivingOrigin.rootId),
              ),
            ).rejects.toThrow("us_dataset_terminal_reader_binding_invalid");
            await expect(
              Promise.resolve().then(() =>
                d.journal.readHeaderInTransaction(tx, {
                  ...context,
                  expectedDatabaseName: "wrong_database",
                }),
              ),
            ).rejects.toThrow("us_dataset_terminal_reader_binding_invalid");
            revoked.push(
              () =>
                d.locks.receivingRoot(tx, context.tenantId, origin.input.receivingOrigin.rootId),
              () => d.locks.transformationRevision(tx, context.tenantId, origin.created.id),
            );
            return shippingCore(...args);
          });
        try {
          await new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context);
          expect(shippingSpy).toHaveBeenCalledOnce();
          for (const read of revoked)
            await expect(Promise.resolve().then(read)).rejects.toThrow(
              "us_dataset_terminal_reader_binding_invalid",
            );
        } finally {
          shippingSpy.mockRestore();
        }
      } finally {
        spy.mockRestore();
        observation.close();
      }
    }),
  );

  it(
    "revokes before receipt persistence and stays revoked after deferred COMMIT failure",
    h.phase(async () => {
      const name = "final_lifetime_" + randomUUID().replaceAll("-", "");
      await h.f.pool.query(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.unit_key='chain_0001' AND NEW.receipt IS NOT NULL THEN RAISE EXCEPTION 'owned_deferred_failure'; END IF; RETURN NEW; END $$`,
      );
      await h.f.pool.query(
        `CREATE CONSTRAINT TRIGGER ${name} AFTER UPDATE ON traceability_demo_dataset_stages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${name}()`,
      );
      let after: (() => unknown) | undefined;
      let beforePersistence = false;
      const core = receivingVerification.verifyUsDatasetReceivingResultCore;
      const final = finalVerification.verifyUsDatasetReceivingFinal;
      const coreSpy = vi
        .spyOn(receivingVerification, "verifyUsDatasetReceivingResultCore")
        .mockImplementation(async (...args) => {
          const result = await core(...args);
          const [tx, context, , , d] = args;
          after = () => d.journal.readHeaderInTransaction(tx, context);
          return result;
        });
      const finalSpy = vi
        .spyOn(finalVerification, "verifyUsDatasetReceivingFinal")
        .mockImplementation(async (...args) => {
          await final(...args);
          if (!after) throw new Error("Missing bounded lifetime");
          await expect(Promise.resolve().then(after)).rejects.toThrow(
            "us_dataset_terminal_reader_binding_invalid",
          );
          beforePersistence = true;
        });
      try {
        const result = await outcome(
          new UsDatasetReceivingSeedStore(h.f.db).initialize(h.context, 1),
        );
        expect(result.value).toBeUndefined();
        expect(driverCode(result.error)).toBe("P0001");
        expect(beforePersistence).toBe(true);
        if (!after) throw new Error("Missing bounded lifetime");
        await expect(Promise.resolve().then(after)).rejects.toThrow(
          "us_dataset_terminal_reader_binding_invalid",
        );
        expect(
          (
            await h.f.pool.query(
              "SELECT receipt FROM traceability_demo_dataset_stages WHERE unit_key='chain_0001' AND stage='receiving'",
            )
          ).rows,
        ).toEqual([{ receipt: null }]);
      } finally {
        finalSpy.mockRestore();
        coreSpy.mockRestore();
        await h.f.pool.query(`DROP TRIGGER ${name} ON traceability_demo_dataset_stages`);
        await h.f.pool.query(`DROP FUNCTION ${name}()`);
      }
    }),
  );

  it(
    "successful original locks admit keys while the first full point observation remains native",
    h.phase(async () => {
      const receiving = await new UsDatasetReceivingSeedStore(h.f.db).verify(h.context, 0);
      const transformation = await new UsDatasetTransformationSeedStore(h.f.db).verify(
        h.context,
        0,
      );
      const original = transformationVerification.verifyUsDatasetTransformationOriginCore;
      const observation = observe(h.f.pool);
      let checked = false;
      const spy = vi
        .spyOn(transformationVerification, "verifyUsDatasetTransformationOriginCore")
        .mockImplementation(async (...args) => {
          const [tx, context, , , d] = args;
          expect(
            await d.locks.transformation(tx, context, { receiving, transformation }),
          ).toBeUndefined();
          const lotId = receiving.lots[0]?.id;
          if (!lotId) throw new Error("Missing real input lot");
          const start = observation.queries.length;
          const row = await d.points.lot(tx, context.tenantId, lotId);
          if (!row) throw new Error("Missing protected full point row");
          const saved = structuredClone(row);
          row.createdAt.setTime(0);
          expect(await d.points.lot(tx, context.tenantId, lotId)).toEqual(saved);
          expect(
            observation.queries
              .slice(start)
              .filter((text) => text.includes('from "traceability_lots"')),
          ).toHaveLength(1);
          checked = true;
          return original(...args);
        });
      try {
        await new UsDatasetTransformationSeedStore(h.f.db).verify(h.context, 0);
        expect(checked).toBe(true);
      } finally {
        spy.mockRestore();
        observation.close();
      }
    }),
  );

  it.each(["success", "exception"] as const)(
    "Transformation binds, clones and revokes on %s",
    h.phase(async (completion) => {
      const original = transformationVerification.verifyUsDatasetTransformationOriginCore;
      const after: (() => unknown)[] = [];
      const failure = new Error("owned final verifier failure");
      const spy = vi
        .spyOn(transformationVerification, "verifyUsDatasetTransformationOriginCore")
        .mockImplementation(async (...args) => {
          const [tx, context, , , d] = args;
          await expect(
            Promise.resolve().then(() =>
              d.authorize(tx, randomUUID(), context.actorUserId, US_CAPABILITY.READ),
            ),
          ).rejects.toThrow("us_dataset_terminal_reader_binding_invalid");
          await expect(
            Promise.resolve().then(() =>
              d.authorize(tx, context.tenantId, randomUUID(), US_CAPABILITY.READ),
            ),
          ).rejects.toThrow("us_dataset_terminal_reader_binding_invalid");
          await h.f.db.transaction(async (other) => {
            await expect(
              Promise.resolve().then(() =>
                d.authorize(other, context.tenantId, context.actorUserId, US_CAPABILITY.READ),
              ),
            ).rejects.toThrow("us_dataset_terminal_reader_binding_invalid");
          });
          const result = await original(...args);
          const lotId = result.receiving.lots[0]?.id;
          if (!lotId) throw new Error("Missing real input lot");
          const lot = await d.points.lot(tx, context.tenantId, lotId);
          const event = await d.points.event(
            tx,
            context.tenantId,
            result.receiving.created.eventId,
          );
          if (
            !lot ||
            !event ||
            !event.finalizationSnapshot ||
            typeof event.finalizationSnapshot !== "object"
          )
            throw new Error("Missing protected raw values");
          const savedLot = structuredClone(lot),
            savedEvent = structuredClone(event);
          lot.createdAt.setTime(0);
          event.createdAt.setTime(0);
          Reflect.set(event.finalizationSnapshot, "notes", "caller-owned mutation");
          expect(await d.points.lot(tx, context.tenantId, lotId)).toEqual(savedLot);
          expect(await d.points.event(tx, context.tenantId, event.id)).toEqual(savedEvent);
          const root = await d.locks.receivingRoot(
            tx,
            context.tenantId,
            result.receiving.created.eventId,
          );
          const revision = await d.locks.receivingRevision(
            tx,
            context.tenantId,
            result.receiving.created.eventId,
          );
          if (!root || !revision) throw new Error("Missing actual full lock observations");
          const savedRoot = structuredClone(root),
            savedRevision = structuredClone(revision);
          root.lifecycleVersion = 0;
          revision.createdAt.setTime(0);
          expect(await d.points.receivingRoot(tx, context.tenantId, savedRoot.id)).toEqual(
            savedRoot,
          );
          expect(await d.points.event(tx, context.tenantId, savedRevision.id)).toEqual(
            savedRevision,
          );
          after.push(
            () => d.points.lot(tx, context.tenantId, lotId),
            () => d.authorize(tx, context.tenantId, context.actorUserId, US_CAPABILITY.READ),
            () => d.journal.readHeaderInTransaction(tx, context),
          );
          if (completion === "exception") throw failure;
          return result;
        });
      try {
        const owner = new UsDatasetTransformationSeedStore(h.f.db);
        if (completion === "exception")
          await expect(owner.verify(h.context, 0)).rejects.toBe(failure);
        else await owner.verify(h.context, 0);
        expect(after).toHaveLength(3);
        for (const read of after)
          await expect(Promise.resolve().then(read)).rejects.toThrow(
            "us_dataset_terminal_reader_binding_invalid",
          );
      } finally {
        spy.mockRestore();
      }
    }),
  );

  it(
    "allocates only after immediate INSERT trigger drift and rolls back",
    h.phase(async () => {
      const remove = await specialFault(
        h.f,
        "traceability_events",
        "INSERT",
        "NEW.type='transformation'",
        "P0001",
        true,
      );
      try {
        await new UsDatasetReceivingSeedStore(h.f.db).initialize(h.context, 1);
        const before = await h.f.pool.query(
          "SELECT id, notes FROM reference_documents ORDER BY id",
        );
        await expect(
          new UsDatasetTransformationSeedStore(h.f.db).initialize(h.context, 1),
        ).rejects.toThrow("us_dataset_transformation_mismatch");
        expect(
          (await h.f.pool.query("SELECT id, notes FROM reference_documents ORDER BY id")).rows,
        ).toEqual(before.rows);
      } finally {
        await remove();
      }
    }),
  );
});
