import { createHash, randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import type { createDb } from "@markiro/db";
import { beforeEach, describe, expect, it } from "vitest";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import { UsDatasetShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-shipping-seed";
import {
  verifyUsDatasetShippingProjection,
  verifyUsDatasetShippingProjectionCore,
} from "../src/modules/traceability/demo/us-dataset-shipping-verify";
import { freshUsDatasetTerminalDependencies } from "../src/modules/traceability/demo/us-dataset-terminal-read-fresh";
import { parseUsDatasetReceivingResult } from "../src/modules/traceability/demo/us-dataset-receiving-contract";
import { parseUsDatasetTransformationResult } from "../src/modules/traceability/demo/us-dataset-transformation-contract";
import { parseUsDatasetShippingResult } from "../src/modules/traceability/demo/us-dataset-shipping-contract";
import { prepareDatasetShippingFixture } from "./support/us-dataset-shipping-fixture";
import { datasetTransformationStores } from "./support/us-dataset-transformation-fixture";
import { specialFixture } from "./support/us-dataset-special-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("terminal verification routing", () => {
  const h = specialFixture(base);
  let prepared: Awaited<ReturnType<typeof prepareDatasetShippingFixture>>;
  beforeEach(
    h.phase(async () => {
      prepared = await prepareDatasetShippingFixture(h.f, h.context, 0);
      await new UsDatasetShippingSeedStore(h.f.db).initialize(h.context, 0);
    }),
    30_000,
  );

  it(
    "preserves the original recursive native projection, receipt identities and SQL sequence",
    h.phase(async () => {
      const { f, context } = h;
      const stores = { ...datasetTransformationStores(f.db), shipping: new UsShippingStore(f.db) };
      const stage = await stores.journal.readStage(
        context,
        prepared.datasetId,
        prepared.intent.unitKey,
        "shipping",
      );
      if (!stage?.receipt) throw new Error("Missing completed native Shipping stage");
      const receipt = stage.receipt;
      const before = await f.snapshot();
      const statements: string[] = [];
      const route: string[] = [];
      const fresh = freshUsDatasetTerminalDependencies(stores);
      const routed = {
        ...fresh,
        authorize: (...args: Parameters<typeof fresh.authorize>) => {
          route.push("write-authorize");
          return fresh.authorize(...args);
        },
        master: {
          getPartyInTransaction: (...args: Parameters<typeof fresh.master.getPartyInTransaction>) =>
            fresh.master.getPartyInTransaction(...args),
          getPartiesInTransaction: (
            ...args: Parameters<typeof fresh.master.getPartiesInTransaction>
          ) => {
            route.push("reference-parties");
            return fresh.master.getPartiesInTransaction(...args);
          },
          getLocationInTransaction: (
            ...args: Parameters<typeof fresh.master.getLocationInTransaction>
          ) => fresh.master.getLocationInTransaction(...args),
          getLocationsInTransaction: (
            ...args: Parameters<typeof fresh.master.getLocationsInTransaction>
          ) => fresh.master.getLocationsInTransaction(...args),
        },
        receiving: {
          getLiveRecordInTransaction: (
            ...args: Parameters<typeof fresh.receiving.getLiveRecordInTransaction>
          ) => {
            route.push("receiving-live");
            return fresh.receiving.getLiveRecordInTransaction(...args);
          },
          getLotReceivingBasisInTransaction: (
            ...args: Parameters<typeof fresh.receiving.getLotReceivingBasisInTransaction>
          ) => fresh.receiving.getLotReceivingBasisInTransaction(...args),
        },
        transformation: {
          getRecordInTransaction: (
            ...args: Parameters<typeof fresh.transformation.getRecordInTransaction>
          ) => {
            route.push("transformation-record");
            return fresh.transformation.getRecordInTransaction(...args);
          },
        },
        shipping: {
          getRecordInTransaction: (
            ...args: Parameters<typeof fresh.shipping.getRecordInTransaction>
          ) => {
            route.push("shipping-record");
            return fresh.shipping.getRecordInTransaction(...args);
          },
        },
        shippingRevisions: (...args: Parameters<typeof fresh.shippingRevisions>) => {
          route.push("shipping-revisions");
          return fresh.shippingRevisions(...args);
        },
        locks: {
          ...fresh.locks,
          shipping: (...args: Parameters<typeof fresh.locks.shipping>) => {
            route.push("shipping-root-lock");
            return fresh.locks.shipping(...args);
          },
          transformation: (...args: Parameters<typeof fresh.locks.transformation>) => {
            route.push("transformation-root-lock");
            return fresh.locks.transformation(...args);
          },
          referenceParents: (...args: Parameters<typeof fresh.locks.referenceParents>) => {
            route.push("reference-parent-lock");
            return fresh.locks.referenceParents(...args);
          },
          receivingDocuments: (...args: Parameters<typeof fresh.locks.receivingDocuments>) => {
            route.push("receiving-document-lock");
            return fresh.locks.receivingDocuments(...args);
          },
          transformationDocuments: (
            ...args: Parameters<typeof fresh.locks.transformationDocuments>
          ) => {
            route.push("transformation-document-lock");
            return fresh.locks.transformationDocuments(...args);
          },
          shippingReferences: (...args: Parameters<typeof fresh.locks.shippingReferences>) => {
            route.push("shipping-reference-lock");
            return fresh.locks.shippingReferences(...args);
          },
          shippingDocuments: (...args: Parameters<typeof fresh.locks.shippingDocuments>) => {
            route.push("shipping-document-lock");
            return fresh.locks.shippingDocuments(...args);
          },
        },
      };
      type Client = NonNullable<
        Parameters<Parameters<ReturnType<typeof createDb>["pool"]["connect"]>[0]>[1]
      >;
      const restores = new Map<Client, () => void>();
      const acquire = (client: Client) => {
        if (restores.has(client)) return;
        const original = client.query;
        client.query = new Proxy(original, {
          apply(target, receiver, args: unknown[]) {
            const first = args[0];
            const text =
              typeof first === "string"
                ? first
                : first &&
                    typeof first === "object" &&
                    "text" in first &&
                    typeof first.text === "string"
                  ? first.text
                  : "";
            statements.push(text);
            return Reflect.apply(target, receiver, args);
          },
        });
        restores.set(client, () => {
          client.query = original;
        });
      };
      f.pool.on("acquire", acquire);
      let projection;
      let routedProjection;
      let originalHashes: string[];
      let routedHashes: string[];
      try {
        projection = await f.db.transaction((tx) =>
          verifyUsDatasetShippingProjection(tx, context, stage.intent, receipt, stores, "replay"),
        );
        originalHashes = statements.map((statement) =>
          createHash("sha256").update(statement).digest("hex"),
        );
        const originalDigest = createHash("sha256").update(originalHashes.join("\n")).digest("hex");
        expect(originalHashes).toHaveLength(270);
        expect(originalDigest).toBe(
          "168657ae20a5ceea796b9e6a54baef5751da978690f4ec2f1fa765adade69b77",
        );
        console.info(
          `Pinned original terminal SQL count=${originalHashes.length} digest=${originalDigest}`,
        );
        statements.length = 0;
        routedProjection = await f.db.transaction((tx) =>
          verifyUsDatasetShippingProjectionCore(
            tx,
            context,
            stage.intent,
            receipt,
            routed,
            "replay",
          ),
        );
        routedHashes = statements.map((statement) =>
          createHash("sha256").update(statement).digest("hex"),
        );
      } finally {
        f.pool.off("acquire", acquire);
        for (const restore of restores.values()) restore();
      }
      expect(routedHashes).toEqual(originalHashes);
      expect(routedProjection).toEqual(projection);
      const ordered = [
        "write-authorize",
        "shipping-root-lock",
        "shipping-reference-lock",
        "shipping-document-lock",
        "transformation-root-lock",
        "reference-parent-lock",
        "reference-parties",
        "receiving-document-lock",
        "receiving-live",
        "transformation-record",
        "transformation-document-lock",
        "shipping-record",
        "shipping-revisions",
      ];
      for (const name of ordered) expect(route).toContain(name);
      for (const [index, name] of ordered.entries()) {
        const next = ordered[index + 1];
        if (next) expect(route.indexOf(name)).toBeLessThan(route.indexOf(next));
      }
      expect(route.filter((entry) => entry === "write-authorize")).toHaveLength(2);
      expect(route.filter((entry) => entry === "transformation-root-lock")).toHaveLength(2);
      expect(projection.receiving).toEqual(
        parseUsDatasetReceivingResult(prepared.receiving.receipt?.result),
      );
      expect(projection.transformation).toEqual(
        parseUsDatasetTransformationResult(prepared.transformation.receipt?.result),
      );
      expect(projection.shipping).toEqual(parseUsDatasetShippingResult(stage.receipt.result));
      expect(canonicalExportDigest(projection.shipping)).toBe(stage.receipt.resultDigest);
      expect(await f.snapshot()).toEqual(before);
    }),
  );

  it(
    "keeps pending transformation precedence over an earlier reference drift",
    h.phase(async () => {
      const { f, context } = h;
      const stores = { ...datasetTransformationStores(f.db), shipping: new UsShippingStore(f.db) };
      const stage = await stores.journal.readStage(
        context,
        prepared.datasetId,
        prepared.intent.unitKey,
        "shipping",
      );
      if (!stage?.receipt) throw new Error("Missing original receipt");
      const receipt = stage.receipt;
      const result = parseUsDatasetShippingResult(receipt.result);
      const changed = await f.pool.query(
        "UPDATE products SET name=name||' drift' WHERE tenant_id=$1 AND id=$2",
        [context.tenantId, result.input.outputProductId],
      );
      expect(changed.rowCount).toBe(1);
      const client = await f.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("ALTER TABLE traceability_demo_dataset_stages DISABLE TRIGGER USER");
        const pending = await client.query(
          "UPDATE traceability_demo_dataset_stages SET receipt=NULL,revision=1 WHERE tenant_id=$1 AND unit_key=$2 AND stage='transformation'",
          [context.tenantId, prepared.intent.unitKey],
        );
        expect(pending.rowCount).toBe(1);
        await client.query("ALTER TABLE traceability_demo_dataset_stages ENABLE TRIGGER USER");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const before = await f.snapshot();
      let error: unknown;
      try {
        await f.db.transaction((tx) =>
          verifyUsDatasetShippingProjection(tx, context, stage.intent, receipt, stores, "replay"),
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ message: "us_dataset_shipping_prerequisite_incomplete" });
      expect(error instanceof Error ? error.cause : undefined).toBeUndefined();
      expect(await f.snapshot()).toEqual(before);
    }),
  );

  it(
    "retains a native query failure as the owner error cause",
    h.phase(async () => {
      const { f, context } = h;
      const before = await f.snapshot();
      type Client = NonNullable<
        Parameters<Parameters<ReturnType<typeof createDb>["pool"]["connect"]>[0]>[1]
      >;
      const restores = new Map<Client, () => void>();
      let injected = false;
      let driverError: unknown;
      const acquire = (client: Client) => {
        if (restores.has(client)) return;
        const original = client.query;
        client.query = new Proxy(original, {
          apply(target, receiver, args: unknown[]) {
            const first = args[0];
            const text =
              typeof first === "string"
                ? first
                : first &&
                    typeof first === "object" &&
                    "text" in first &&
                    typeof first.text === "string"
                  ? first.text
                  : "";
            if (!injected && /from "receiving_operations"/i.test(text)) {
              injected = true;
              return client
                .query("SELECT terminal_routing_missing_column FROM receiving_operations")
                .catch((error: unknown) => {
                  driverError = error;
                  throw error;
                });
            }
            return Reflect.apply(target, receiver, args);
          },
        });
        restores.set(client, () => {
          client.query = original;
        });
      };
      f.pool.on("acquire", acquire);
      let error: unknown;
      try {
        await new UsDatasetShippingSeedStore(f.db).verifyTerminalProjection(context, 0);
      } catch (caught) {
        error = caught;
      } finally {
        f.pool.off("acquire", acquire);
        for (const restore of restores.values()) restore();
      }
      expect(injected).toBe(true);
      expect(error).toBeInstanceOf(Error);
      expect(
        driverError && typeof driverError === "object" ? Reflect.get(driverError, "code") : null,
      ).toBe("42703");
      expect(error instanceof Error ? error.cause : undefined).toBe(driverError);
      expect(await f.snapshot()).toEqual(before);
    }),
  );

  it(
    "refuses a foreign tenant before recursive receipt evidence",
    h.phase(async () => {
      const { f, context } = h;
      const stores = { ...datasetTransformationStores(f.db), shipping: new UsShippingStore(f.db) };
      const stage = await stores.journal.readStage(
        context,
        prepared.datasetId,
        prepared.intent.unitKey,
        "shipping",
      );
      if (!stage?.receipt) throw new Error("Missing original receipt");
      const receipt = stage.receipt;
      const before = await f.snapshot();
      let error: unknown;
      try {
        await f.db.transaction((tx) =>
          verifyUsDatasetShippingProjection(
            tx,
            { ...context, tenantId: randomUUID() },
            stage.intent,
            receipt,
            stores,
            "replay",
          ),
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ message: "us_dataset_target_invalid" });
      expect(await f.snapshot()).toEqual(before);
    }),
  );
});
