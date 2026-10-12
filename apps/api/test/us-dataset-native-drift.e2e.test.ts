import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { UsDatasetNativeSeedStore } from "../src/modules/traceability/demo/us-dataset-native-seed";
import { UsDatasetRegularSeedStore } from "../src/modules/traceability/demo/us-dataset-regular-seed";
import { UsDatasetShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-shipping-seed";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { outcome } from "./support/us-transformation-lock-fixture";
import { specialFault, specialFixture } from "./support/us-dataset-special-fixture";

describe.skipIf(!process.env.US_TEST_DATABASE_URL)("native coordinator drift boundary", () => {
  const h = specialFixture(process.env.US_TEST_DATABASE_URL);
  const range = { startIndex: 0, count: 1 };
  const modes = ["verify", "initialize"] as const;

  // Without boundary translation, genuine saved-fact drift misses full11's denial contract.
  it.each(["document notes", "reference party"] as const)(
    "both native modes reject actual %s drift without writes and retain the original cause",
    h.phase(async (kind) => {
      await new UsDatasetRegularSeedStore(h.f.db).initialize(h.context, range);
      const changed = await h.f.pool.query(
        kind === "document notes"
          ? "UPDATE reference_documents SET notes='Owned native drift' WHERE tenant_id=$1"
          : "UPDATE traceability_parties SET legal_name='Owned native drift' WHERE tenant_id=$1",
        [h.context.tenantId],
      );
      expect(changed.rowCount).toBeGreaterThan(0);
      const before = await h.f.snapshot();
      expect(Object.keys(before)).toHaveLength(198);
      const message =
        kind === "document notes" ? "us_dataset_cases_mismatch" : "us_dataset_reference_mismatch";
      for (const mode of modes) {
        await expect(new UsDatasetRegularSeedStore(h.f.db)[mode](h.context, range)).rejects.toThrow(
          message,
        );
        const original = UsDatasetRegularSeedStore.prototype[mode];
        let forwarded: unknown;
        let descriptors: PropertyDescriptorMap | undefined;
        const spy = vi
          .spyOn(UsDatasetRegularSeedStore.prototype, mode)
          .mockImplementation(async function (this: UsDatasetRegularSeedStore, ...args) {
            try {
              return await original.apply(this, args);
            } catch (error) {
              forwarded = error;
              if (error instanceof Error) descriptors = Object.getOwnPropertyDescriptors(error);
              throw error;
            }
          });
        try {
          const failed = await outcome(new UsDatasetNativeSeedStore(h.f.db)[mode](h.context));
          expect(failed.error).toBeInstanceOf(Error);
          if (!(failed.error instanceof Error) || !(forwarded instanceof Error))
            throw new Error("Missing actual native rejection");
          expect(failed.error.message).toMatch(/drift|invalid/);
          expect(failed.error.message).toBe("us_dataset_native_drift");
          expect(failed.error.cause).toBe(forwarded);
          expect(forwarded.message).toBe(message);
          expect(forwarded).toMatchObject(
            kind === "document notes"
              ? { unitKey: "chain_0000", stage: "shipping" }
              : { unitKey: "references", stage: "references" },
          );
          expect(Object.getOwnPropertyDescriptors(forwarded)).toEqual(descriptors);
          for (const key of ["unitKey", "stage"])
            expect(Object.getOwnPropertyDescriptor(failed.error, key)?.value).toBe(
              Object.getOwnPropertyDescriptor(forwarded, key)?.value,
            );
        } finally {
          spy.mockRestore();
        }
        expect(await h.f.snapshot()).toEqual(before);
      }
      if (kind === "document notes")
        await expect(new UsDatasetShippingSeedStore(h.f.db).verify(h.context, 0)).rejects.toThrow(
          "us_dataset_cases_mismatch",
        );
      else
        await expect(new UsDatasetReferenceSeedStore(h.f.db).verify(h.context)).rejects.toThrow(
          "us_dataset_reference_mismatch",
        );
      expect(await h.f.snapshot()).toEqual(before);
    }),
    30_000,
  );

  // A broad catch or implicit retry would replace the real SQL Error or advance the sequence.
  it(
    "preserves the exact native SQL40001 error, cause, annotations and single attempt",
    h.phase(async () => {
      await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
      const sequence = "native_drift_attempts_" + randomUUID().replaceAll("-", "");
      await h.f.pool.query(`CREATE SEQUENCE ${sequence}`);
      const remove = await specialFault(
        h.f,
        "traceability_demo_dataset_stages",
        "UPDATE",
        `NEW.unit_key='chain_0000' AND NEW.stage='receiving' AND NEW.receipt IS NOT NULL AND nextval('${sequence}')>0`,
        "40001",
      );
      let forwarded: unknown;
      let descriptors: PropertyDescriptorMap | undefined;
      const original = UsDatasetRegularSeedStore.prototype.initialize;
      const spy = vi
        .spyOn(UsDatasetRegularSeedStore.prototype, "initialize")
        .mockImplementation(async function (this: UsDatasetRegularSeedStore, ...args) {
          try {
            return await original.apply(this, args);
          } catch (error) {
            forwarded = error;
            if (error instanceof Error) descriptors = Object.getOwnPropertyDescriptors(error);
            throw error;
          }
        });
      try {
        const failed = await outcome(new UsDatasetNativeSeedStore(h.f.db).initialize(h.context));
        expect(failed.error).toBe(forwarded);
        expect(failed.error).toMatchObject({
          cause: { code: "40001", message: "special_sql_fault" },
          unitKey: "chain_0000",
          stage: "receiving",
        });
        if (!(failed.error instanceof Error)) throw new Error("Missing SQL fault");
        expect(Object.getOwnPropertyDescriptors(failed.error)).toEqual(descriptors);
        expect((await h.f.pool.query(`SELECT last_value::int AS n FROM ${sequence}`)).rows).toEqual(
          [{ n: 1 }],
        );
        expect(
          (await h.f.pool.query("SELECT count(*)::int AS n FROM shipping_event_roots")).rows,
        ).toEqual([{ n: 0 }]);
      } finally {
        spy.mockRestore();
        try {
          await remove();
        } finally {
          await h.f.pool.query(`DROP SEQUENCE ${sequence}`);
        }
      }
    }),
    30_000,
  );

  it(
    "retains actual incomplete and target denials without writes",
    h.phase(async () => {
      const before = await h.f.snapshot();
      const native = new UsDatasetNativeSeedStore(h.f.db);
      await expect(native.verify(h.context)).rejects.toThrow(/incomplete/);
      for (const mode of modes)
        await expect(
          native[mode]({ ...h.context, expectedDatabaseName: "wrong_database" }),
        ).rejects.toThrow("us_dataset_target_invalid");
      expect(await h.f.snapshot()).toEqual(before);
    }),
    30_000,
  );

  // Supplement native witnesses with values that real drivers cannot reliably manufacture.
  it(
    "classifies only exact mutable semantic errors and conservatively preserves unsafe causes",
    h.phase(async () => {
      for (const name of [
        "reference",
        "receiving",
        "transformation",
        "cases",
        "shipping",
        "special",
        "corrected_transformation",
      ]) {
        for (const mode of modes) {
          const error = Object.assign(new Error(`us_dataset_${name}_mismatch`), {
            unitKey: "chain_0000",
            stage: "shipping",
          });
          const before = Object.getOwnPropertyDescriptors(error);
          const spy = vi
            .spyOn(UsDatasetJournalStore.prototype, "read")
            .mockRejectedValueOnce(error);
          try {
            const result = await outcome(new UsDatasetNativeSeedStore(h.f.db)[mode](h.context));
            expect(result.error).toMatchObject({
              message: "us_dataset_native_drift",
              cause: error,
              unitKey: "chain_0000",
              stage: "shipping",
            });
            if (!(result.error instanceof Error)) throw new Error("Missing classification error");
            expect(result.error.cause).toBe(error);
            expect(Object.getOwnPropertyDescriptors(error)).toEqual(before);
          } finally {
            spy.mockRestore();
          }
        }
      }
      let accessors = 0;
      const semantic = () => new Error("us_dataset_cases_mismatch");
      const cycle = semantic();
      Object.defineProperty(cycle, "cause", { value: cycle });
      let deep = semantic();
      for (let i = 0; i < 100; i++) deep = new Error("us_dataset_cases_mismatch", { cause: deep });
      const getter = () => {
        accessors++;
        throw new Error("Do not evaluate accessors");
      };
      const accessorErrors = ["cause", "code", "message", "unitKey", "stage"].map((key) =>
        Object.defineProperty(semantic(), key, { get: getter }),
      );
      const passthrough: unknown[] = [
        new Error("us_dataset_target_invalid"),
        new Error("us_dataset_cases_incomplete"),
        new Error("us_dataset_cases_conflict"),
        new Error("arbitrary mismatch"),
        new Error("prefix us_dataset_cases_mismatch"),
        Object.freeze(semantic()),
        "us_dataset_cases_mismatch",
        null,
        undefined,
        42,
        cycle,
        deep,
        ...accessorErrors,
        Object.assign(semantic(), { code: "40001" }),
        new Error("us_dataset_cases_mismatch", {
          cause: Object.assign(new Error("network"), { code: "ECONNRESET" }),
        }),
        new Error("us_dataset_cases_mismatch", {
          cause: new Error("wrapper", { cause: { code: "40001" } }),
        }),
        Object.defineProperty(semantic(), "message", { value: 7 }),
        new Error("us_dataset_cases_mismatch", { cause: Object.create({ code: "EPIPE" }) }),
        new Error("us_dataset_cases_mismatch", { cause: "uncertain cause" }),
        new Proxy(semantic(), {
          getOwnPropertyDescriptor() {
            throw new Error("reflection denied");
          },
        }),
      ];
      for (const error of passthrough)
        for (const mode of modes) {
          const spy = vi
            .spyOn(UsDatasetJournalStore.prototype, "read")
            .mockRejectedValueOnce(error);
          try {
            await expect(new UsDatasetNativeSeedStore(h.f.db)[mode](h.context)).rejects.toBe(error);
          } finally {
            spy.mockRestore();
          }
        }
      expect(accessors).toBe(0);
    }),
    30_000,
  );
});
