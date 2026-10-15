import { createHash } from "node:crypto";
import { schema, type createDb } from "@markiro/db";
import { shippingFinalizationSnapshotV1Schema } from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { UsDatasetRegularSeedStore } from "../src/modules/traceability/demo/us-dataset-regular-seed";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsCatalogStore } from "../src/modules/traceability/catalog/us-catalog-store";
import { productResponse } from "../src/modules/traceability/catalog/us-catalog-support";
import { UsReferenceDocumentStore } from "../src/modules/traceability/documents/us-reference-document-store";
import { referenceDocumentResponse } from "../src/modules/traceability/documents/us-reference-document-support";
import { UsLotStore } from "../src/modules/traceability/lots/us-lot-store";
import { lotResponse } from "../src/modules/traceability/lots/us-lot-support";
import { UsMasterDataStore } from "../src/modules/traceability/master-data/us-master-data-store";
import {
  authorizeUsMasterData,
  locationResponse,
  partyResponse,
} from "../src/modules/traceability/master-data/us-master-data-support";
import { UsProductProfileStore } from "../src/modules/traceability/products/us-product-profile-store";
import {
  profileDefaults,
  storedProfileResponse,
} from "../src/modules/traceability/products/us-product-profile-support";
import { readReceivingBasis } from "../src/modules/traceability/receiving/us-receiving-basis";
import {
  readReceivingLiveRecord,
  readReceivingRevisions,
  receivingRecordIdentity,
} from "../src/modules/traceability/receiving/us-receiving-history";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { readTransformationRecord } from "../src/modules/traceability/transformation/us-transformation-persistence";
import { UsTransformationStore } from "../src/modules/traceability/transformation/us-transformation-store";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import { readShippingSnapshotRecord } from "../src/modules/traceability/shipping/us-shipping-finalization";
import {
  readShippingRecord,
  readShippingRevisions,
} from "../src/modules/traceability/shipping/us-shipping-history";
import { specialFixture } from "./support/us-dataset-special-fixture";

type DriverPool = ReturnType<typeof createDb>["pool"];
type DriverClient = NonNullable<Parameters<Parameters<DriverPool["connect"]>[0]>[1]>;

const originalPartySql = [
  "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
  "3dee3a51fafd070968fcbf96939e022e2f63fb3f2d941da9cba58df3d9e67ef3",
  "ba9346b34e0a82a2f83140685a188e0be28c937d28dca7b0353a1ccc36e298cd",
  "afd9d11dfd73dddf3afe16cea11c2669d9c59da7d2fa8c416d07697539dc50d8",
  "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
];

const originalFamilySql: Record<string, string[]> = {
  parties: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "3dee3a51fafd070968fcbf96939e022e2f63fb3f2d941da9cba58df3d9e67ef3",
    "ba9346b34e0a82a2f83140685a188e0be28c937d28dca7b0353a1ccc36e298cd",
    "fa24b615216d924150d407266f3f8c08286f8257b8352e2204a3b91670338245",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  location: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "3dee3a51fafd070968fcbf96939e022e2f63fb3f2d941da9cba58df3d9e67ef3",
    "ba9346b34e0a82a2f83140685a188e0be28c937d28dca7b0353a1ccc36e298cd",
    "edd9e13322855009b6a56a836acb721e254655558bd32d9f65afba20a6745b1e",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  locations: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "3dee3a51fafd070968fcbf96939e022e2f63fb3f2d941da9cba58df3d9e67ef3",
    "ba9346b34e0a82a2f83140685a188e0be28c937d28dca7b0353a1ccc36e298cd",
    "b199596f9ffa8a5d8d7a26c65d4b6832974190274ace04cf089afbfafd8871c4",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  product: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "3dee3a51fafd070968fcbf96939e022e2f63fb3f2d941da9cba58df3d9e67ef3",
    "ba9346b34e0a82a2f83140685a188e0be28c937d28dca7b0353a1ccc36e298cd",
    "2c81b48b8aff143bd2af955400ecb0c6dec53bf6aa4c78c97c534e5c6b11f353",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  products: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "3dee3a51fafd070968fcbf96939e022e2f63fb3f2d941da9cba58df3d9e67ef3",
    "ba9346b34e0a82a2f83140685a188e0be28c937d28dca7b0353a1ccc36e298cd",
    "d8511f2a8c8605eaa2e91e55545b08580f810c078a98eb312d3c26a33e4fb6a3",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  profile: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "3dee3a51fafd070968fcbf96939e022e2f63fb3f2d941da9cba58df3d9e67ef3",
    "ba9346b34e0a82a2f83140685a188e0be28c937d28dca7b0353a1ccc36e298cd",
    "459f219ad04c9d083bb88a54e5d15982e048b6cfa15d2d4607cc202d7fe879a3",
    "74728daff475b1b7012ff1d1abd7002ad0bdb29710fb2770e2ad97c07642a107",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  profiles: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "3dee3a51fafd070968fcbf96939e022e2f63fb3f2d941da9cba58df3d9e67ef3",
    "ba9346b34e0a82a2f83140685a188e0be28c937d28dca7b0353a1ccc36e298cd",
    "e43819b0be2b2a2cb66e658719fcde34eea288da5c1eecd50967d4e4633e1a86",
    "86b55197dd1fa265a0fc4e35bc02152a121cdb7046f6f4b74875cabe23c4b112",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  document: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "3dee3a51fafd070968fcbf96939e022e2f63fb3f2d941da9cba58df3d9e67ef3",
    "ba9346b34e0a82a2f83140685a188e0be28c937d28dca7b0353a1ccc36e298cd",
    "21d77bb5a3fe3fd774c64577fb3e5ad1827b2ce39966f833eb582bc1862d9753",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  lot: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "3dee3a51fafd070968fcbf96939e022e2f63fb3f2d941da9cba58df3d9e67ef3",
    "ba9346b34e0a82a2f83140685a188e0be28c937d28dca7b0353a1ccc36e298cd",
    "596ef1b1d71fb92570be2b1a18ddfe67dd1de4656dd4e5dc2bc7c6f1468e9112",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  receiving: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "3dee3a51fafd070968fcbf96939e022e2f63fb3f2d941da9cba58df3d9e67ef3",
    "ba9346b34e0a82a2f83140685a188e0be28c937d28dca7b0353a1ccc36e298cd",
    "ab9f580d53dfd34e5193351d0f311ad8d64c70de7723e249cbc7ac662c70014e",
    "ec470efc3ece734862e6245351e82c08773fecd711c9b4e52ad26d5b0999e892",
    "37fd4917f3d720116f733ef5f4a38123daf788844d51658a8ca040c5b638a036",
    "0970362bd4ca5df3d8f482f5ab04e6a440497ed9917984fd69e2d9dd715cd469",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  receivingHistory: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "ab9f580d53dfd34e5193351d0f311ad8d64c70de7723e249cbc7ac662c70014e",
    "ec470efc3ece734862e6245351e82c08773fecd711c9b4e52ad26d5b0999e892",
    "37fd4917f3d720116f733ef5f4a38123daf788844d51658a8ca040c5b638a036",
    "0970362bd4ca5df3d8f482f5ab04e6a440497ed9917984fd69e2d9dd715cd469",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  receivingRevisions: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "ab9f580d53dfd34e5193351d0f311ad8d64c70de7723e249cbc7ac662c70014e",
    "ec470efc3ece734862e6245351e82c08773fecd711c9b4e52ad26d5b0999e892",
    "37fd4917f3d720116f733ef5f4a38123daf788844d51658a8ca040c5b638a036",
    "1d097e9dcc421ced3726cec3b6ca7b55704f9b7c322932d1426248a81d6908ee",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  basis: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "3dee3a51fafd070968fcbf96939e022e2f63fb3f2d941da9cba58df3d9e67ef3",
    "ba9346b34e0a82a2f83140685a188e0be28c937d28dca7b0353a1ccc36e298cd",
    "6208f2cf605b544087662b6976dea0d31502eea2e50c54118eea02dff5bdedcf",
    "e6ee9e13d694b47dc89bbf366f58a29b1bc56ec43a68c00b7339198e8c90e5aa",
    "2598e315a20862d1b13784ec05467a95ca1c6ede8d3dc43767f19bcae3bc7009",
    "7231d3a00412f9997e366293e295cd5cf5ae1a13d5c2a1f906d83533d3935450",
    "f0ba35dd295e11a8d72e9d12652fb0a62cb8d0b0d14558e4bfcd9631fdafcaba",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  basisRaw: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "6208f2cf605b544087662b6976dea0d31502eea2e50c54118eea02dff5bdedcf",
    "e6ee9e13d694b47dc89bbf366f58a29b1bc56ec43a68c00b7339198e8c90e5aa",
    "2598e315a20862d1b13784ec05467a95ca1c6ede8d3dc43767f19bcae3bc7009",
    "7231d3a00412f9997e366293e295cd5cf5ae1a13d5c2a1f906d83533d3935450",
    "f0ba35dd295e11a8d72e9d12652fb0a62cb8d0b0d14558e4bfcd9631fdafcaba",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  transformation: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "3dee3a51fafd070968fcbf96939e022e2f63fb3f2d941da9cba58df3d9e67ef3",
    "ba9346b34e0a82a2f83140685a188e0be28c937d28dca7b0353a1ccc36e298cd",
    "c6b189aa8da6846db22787d92a7b569763eac9cebf057f415eea4471966fce95",
    "1912823ae26ccda05fdd59f4a7b1d7a49d691340ad12cbd94c90a21f6f5398ba",
    "c7d555bb36d1bca4d5442566ad24d0abf1a46ca3175f9ca036f2d20605ad2d2e",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  transformationRaw: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "c6b189aa8da6846db22787d92a7b569763eac9cebf057f415eea4471966fce95",
    "1912823ae26ccda05fdd59f4a7b1d7a49d691340ad12cbd94c90a21f6f5398ba",
    "c7d555bb36d1bca4d5442566ad24d0abf1a46ca3175f9ca036f2d20605ad2d2e",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  shipping: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "3dee3a51fafd070968fcbf96939e022e2f63fb3f2d941da9cba58df3d9e67ef3",
    "ba9346b34e0a82a2f83140685a188e0be28c937d28dca7b0353a1ccc36e298cd",
    "be0b963b805cd7a342efe297a37e71d8db8a6e1426d961e8c1252bf72bdb1ae5",
    "be0b963b805cd7a342efe297a37e71d8db8a6e1426d961e8c1252bf72bdb1ae5",
    "a86315c93f5673035e182aec8ebc9f7e5b2a788c26d910f4b803d9378089e6ed",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  shippingRaw: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "be0b963b805cd7a342efe297a37e71d8db8a6e1426d961e8c1252bf72bdb1ae5",
    "be0b963b805cd7a342efe297a37e71d8db8a6e1426d961e8c1252bf72bdb1ae5",
    "a86315c93f5673035e182aec8ebc9f7e5b2a788c26d910f4b803d9378089e6ed",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  shippingSnapshot: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "be0b963b805cd7a342efe297a37e71d8db8a6e1426d961e8c1252bf72bdb1ae5",
    "a86315c93f5673035e182aec8ebc9f7e5b2a788c26d910f4b803d9378089e6ed",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
  shippingRevisions: [
    "e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5",
    "a5600a5b42d3f68c0e14369f7e22939708715159ca268d16ea582c9406e7a969",
    "314812ebab0e679663c4618eea8aeda6ff9b8e9a1646898bebd4de9a5275c324",
    "3660f780d876675fe5fb99f40ac1d430dc67902b51e354e3dbd51a3c04c0d725",
    "9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098",
  ],
};

async function statementHashes<T>(pool: DriverPool, run: () => Promise<T>) {
  const statements: string[] = [];
  const restore = new Map<object, () => void>();
  pool.on("acquire", instrument);
  function instrument(client: DriverClient) {
    if (restore.has(client)) return;
    const original = client.query;
    client.query = new Proxy(original, {
      apply(target, receiver, args) {
        const input: unknown = args[0];
        const text =
          typeof input === "string"
            ? input
            : input && typeof input === "object" && "text" in input
              ? input.text
              : undefined;
        if (typeof text !== "string") throw new Error("Unexpected driver query shape");
        statements.push(createHash("sha256").update(text).digest("hex"));
        return Reflect.apply(target, receiver, args);
      },
    });
    restore.set(client, () => {
      client.query = original;
    });
  }
  try {
    const result = await run();
    return { result, statements };
  } finally {
    pool.off("acquire", instrument);
    for (const reset of restore.values()) reset();
  }
}

describe.skipIf(!process.env.US_TEST_DATABASE_URL)("native terminal reader extraction", () => {
  const harness = specialFixture(process.env.US_TEST_DATABASE_URL);

  it(
    "records the original fresh party SQL and returns the known persisted party",
    harness.phase(async () => {
      const { f, context } = harness;
      const refs = await new UsDatasetReferenceSeedStore(f.db).initialize(context);
      const id = refs.bindings.parties[0]?.id;
      if (!id) throw new Error("Missing reference party");
      const [persisted] = await f.db
        .select()
        .from(schema.traceabilityParties)
        .where(
          and(
            eq(schema.traceabilityParties.tenantId, context.tenantId),
            eq(schema.traceabilityParties.id, id),
          ),
        );
      if (!persisted) throw new Error("Missing persisted party");
      const before = await f.snapshot();
      const { result, statements } = await statementHashes(f.pool, () =>
        f.db.transaction((tx) =>
          new UsMasterDataStore(f.db).getPartyInTransaction(
            tx,
            context.tenantId,
            context.actorUserId,
            id,
          ),
        ),
      );
      expect(result).toEqual({
        id,
        name: persisted.name,
        legalName: persisted.legalName,
        contactName: persisted.contactName,
        contactPhone: persisted.contactPhone,
        contactEmail: persisted.contactEmail,
        notes: persisted.notes,
        archived: persisted.archived,
        createdAt: persisted.createdAt.toISOString(),
        updatedAt: persisted.updatedAt.toISOString(),
      });
      expect(await f.snapshot()).toEqual(before);
      expect(statements).toEqual(originalPartySql);
    }),
  );

  describe("ready regular chain reader sequences", () => {
    beforeEach(
      harness.phase(async () => {
        const { f, context } = harness;
        await new UsDatasetRegularSeedStore(f.db).initialize(context, { startIndex: 0, count: 1 });
      }),
      30_000,
    );
    it(
      "preserves the saved original SQL sequences for each native reader family",
      harness.phase(async () => {
        const { f, context } = harness;
        const tenant = context.tenantId;
        const actor = context.actorUserId;
        const [party] = await f.db.select().from(schema.traceabilityParties).limit(1);
        const [location] = await f.db.select().from(schema.traceabilityLocations).limit(1);
        const [product] = await f.db.select().from(schema.products).limit(1);
        const [profile] = await f.db.select().from(schema.productTraceabilityProfiles).limit(1);
        const [document] = await f.db.select().from(schema.referenceDocuments).limit(1);
        const [support] = await f.db.select().from(schema.receivingEventItems).limit(1);
        const [lot] = await f.db.select().from(schema.traceabilityLots).limit(1);
        const [receiving] = await f.db
          .select()
          .from(schema.traceabilityEvents)
          .where(eq(schema.traceabilityEvents.type, "receiving"))
          .limit(1);
        const [transformation] = await f.db
          .select()
          .from(schema.traceabilityEvents)
          .where(eq(schema.traceabilityEvents.type, "transformation"))
          .limit(1);
        const [shipping] = await f.db
          .select()
          .from(schema.traceabilityEvents)
          .where(eq(schema.traceabilityEvents.type, "shipping"))
          .limit(1);
        const [receivingRoot] = receiving
          ? await f.db
              .select()
              .from(schema.receivingEventRoots)
              .where(eq(schema.receivingEventRoots.id, receiving.rootEventId))
          : [];
        const [transformationRoot] = transformation
          ? await f.db
              .select()
              .from(schema.transformationEventRoots)
              .where(eq(schema.transformationEventRoots.id, transformation.rootEventId))
          : [];
        const [shippingRoot] = shipping
          ? await f.db
              .select()
              .from(schema.shippingEventRoots)
              .where(eq(schema.shippingEventRoots.id, shipping.rootEventId))
          : [];
        if (
          !party ||
          !location ||
          !product ||
          !document ||
          !lot ||
          !support?.lotId ||
          !receiving ||
          !transformation ||
          !shipping ||
          !receivingRoot ||
          !transformationRoot ||
          !shippingRoot
        )
          throw new Error("Missing native reader reference rows");
        const lotId = support.lotId;
        const master = new UsMasterDataStore(f.db);
        const catalog = new UsCatalogStore(f.db);
        const profiles = new UsProductProfileStore(f.db);
        const documents = new UsReferenceDocumentStore(f.db);
        const lots = new UsLotStore(f.db);
        const receivingStore = new UsReceivingStore(f.db);
        const transformationStore = new UsTransformationStore(f.db);
        const shippingStore = new UsShippingStore(f.db);
        const before = await f.snapshot();
        const observed: Record<string, string[]> = {};
        const capture = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
          const { result, statements } = await statementHashes(f.pool, run);
          observed[name] = statements;
          return result;
        };
        const receivingExpected = {
          ...receivingRecordIdentity(receiving, receivingRoot),
          content: {
            kind: "finalized",
            finalizedAt: receiving.finalizedAt?.toISOString(),
            finalizedBy: receiving.finalizedBy,
            snapshot: receiving.finalizationSnapshot,
          },
        };
        const basisExpected = {
          lotId,
          basisVersion: lot.receivingBasisVersion,
          state: "present",
          supportCount: 1,
          items: [
            {
              rootId: receivingRoot.id,
              eventId: receiving.id,
              eventNumber: receiving.eventNumber,
              revision: receiving.revision,
              lineNos: [support.lineNo],
            },
          ],
          limit: 50,
          offset: 0,
          hasMore: false,
        };
        const transformationExpected = {
          id: transformation.id,
          eventNumber: transformation.eventNumber,
          revision: transformation.revision,
          draftVersion: transformation.draftVersion,
          timeZone: transformation.timeZone,
          createdBy: transformation.createdBy,
          updatedBy: transformation.updatedBy,
          createdAt: transformation.createdAt.toISOString(),
          updatedAt: transformation.updatedAt.toISOString(),
          status: transformation.status,
          lifecycle: {
            rootId: transformationRoot.id,
            lifecycleVersion: transformationRoot.lifecycleVersion,
            currentEventId: transformationRoot.currentEventId,
            pendingDraftId: transformationRoot.pendingDraftId,
            previousRevisionId: transformation.previousRevisionId,
            amendmentReason: transformation.amendmentReason,
            supersededByEventId: transformation.supersededByEventId,
            supersededAt: transformation.supersededAt?.toISOString() ?? null,
            supersededBy: transformation.supersededBy,
            voidedAt: transformation.voidedAt?.toISOString() ?? null,
            voidedBy: transformation.voidedBy,
            voidReason: transformation.voidReason,
          },
          finalizedAt: transformation.finalizedAt?.toISOString(),
          finalizedBy: transformation.finalizedBy,
          snapshot: transformation.finalizationSnapshot,
        };
        const shippingSnapshot = shippingFinalizationSnapshotV1Schema.parse(
          shipping.finalizationSnapshot,
        );
        const shippingExpected = {
          id: shipping.id,
          eventNumber: shipping.eventNumber,
          revision: shipping.revision,
          draftVersion: shipping.draftVersion,
          timeZone: shipping.timeZone,
          createdBy: shipping.createdBy,
          updatedBy: shipping.updatedBy,
          createdAt: shipping.createdAt.toISOString(),
          updatedAt: shipping.updatedAt.toISOString(),
          status: shipping.status,
          snapshot: shippingSnapshot,
          draft: {
            eventDate: shippingSnapshot.eventDate,
            shipFromLocationId: shippingSnapshot.shipFrom.locationId,
            recipientLocationId: shippingSnapshot.recipient.locationId,
            carrierReference: shippingSnapshot.carrierReference,
            notes: shippingSnapshot.notes,
            items: shippingSnapshot.items.map((line) => ({
              lotId: line.lotId,
              quantity: line.quantity,
              unitOfMeasure: line.unitOfMeasure,
            })),
            documentIds: shippingSnapshot.documents.map((row) => row.id),
          },
          lifecycle: {
            rootId: shippingRoot.id,
            lifecycleVersion: shippingRoot.lifecycleVersion,
            currentEventId: shippingRoot.currentEventId,
            pendingDraftId: shippingRoot.pendingDraftId,
            previousRevisionId: shipping.previousRevisionId,
            amendmentReason: shipping.amendmentReason,
            supersededByEventId: shipping.supersededByEventId,
            supersededAt: shipping.supersededAt?.toISOString() ?? null,
            supersededBy: shipping.supersededBy,
            voidedAt: shipping.voidedAt?.toISOString() ?? null,
            voidedBy: shipping.voidedBy,
            voidReason: shipping.voidReason,
          },
        };
        expect(
          await capture("parties", () =>
            f.db.transaction((tx) => master.getPartiesInTransaction(tx, tenant, actor, [party.id])),
          ),
        ).toEqual([partyResponse(party)]);
        expect(
          await capture("location", () =>
            f.db.transaction((tx) =>
              master.getLocationInTransaction(tx, tenant, actor, location.id),
            ),
          ),
        ).toEqual(locationResponse(location));
        expect(
          await capture("locations", () =>
            f.db.transaction((tx) =>
              master.getLocationsInTransaction(tx, tenant, actor, [location.id]),
            ),
          ),
        ).toEqual([locationResponse(location)]);
        expect(
          await capture("product", () =>
            f.db.transaction((tx) =>
              catalog.getProductInTransaction(tx, tenant, actor, product.id),
            ),
          ),
        ).toEqual(productResponse(product));
        expect(
          await capture("products", () =>
            f.db.transaction((tx) =>
              catalog.getProductsInTransaction(tx, tenant, actor, [product.id]),
            ),
          ),
        ).toEqual([productResponse(product)]);
        expect(
          await capture("profile", () =>
            f.db.transaction((tx) =>
              profiles.getProfileInTransaction(tx, tenant, actor, product.id),
            ),
          ),
        ).toEqual(
          profile
            ? storedProfileResponse(profile, "US_FSMA204_PROCESSOR")
            : profileDefaults(product),
        );
        expect(
          await capture("profiles", () =>
            f.db.transaction((tx) =>
              profiles.getProfilesInTransaction(tx, tenant, actor, [product.id]),
            ),
          ),
        ).toEqual([
          profile
            ? storedProfileResponse(profile, "US_FSMA204_PROCESSOR")
            : profileDefaults(product),
        ]);
        expect(
          await capture("document", () =>
            f.db.transaction((tx) =>
              documents.getDocumentInTransaction(tx, tenant, actor, document.id),
            ),
          ),
        ).toEqual(referenceDocumentResponse(document));
        expect(
          await capture("lot", () =>
            f.db.transaction((tx) => lots.getLotInTransaction(tx, tenant, actor, lot.id)),
          ),
        ).toEqual(lotResponse(lot));
        expect(
          await capture("receiving", () =>
            f.db.transaction((tx) =>
              receivingStore.getLiveRecordInTransaction(tx, tenant, actor, receiving.id),
            ),
          ),
        ).toEqual(receivingExpected);
        expect(
          await capture("receivingHistory", () =>
            f.db.transaction((tx) => readReceivingLiveRecord(tx, tenant, receiving.id)),
          ),
        ).toEqual(receivingExpected);
        expect(
          await capture("receivingRevisions", () =>
            f.db.transaction((tx) =>
              readReceivingRevisions(tx, tenant, receiving.id, { limit: 50, offset: 0 }),
            ),
          ),
        ).toEqual({
          items: [
            {
              ...receivingRecordIdentity(receiving, receivingRoot),
              dateReceived: receiving.dateReceived,
              locationId: receiving.locationId,
              previousSourceLocationId: receiving.previousSourceLocationId,
              lineCount: 2,
              documentCount: 2,
            },
          ],
          limit: 50,
          offset: 0,
          lifecycleVersion: receivingRoot.lifecycleVersion,
        });
        expect(
          await capture("basis", () =>
            f.db.transaction((tx) =>
              receivingStore.getLotReceivingBasisInTransaction(tx, tenant, actor, lotId, {}),
            ),
          ),
        ).toEqual(basisExpected);
        expect(
          await capture("basisRaw", () =>
            f.db.transaction((tx) =>
              readReceivingBasis(tx, tenant, lotId, { limit: 50, offset: 0 }),
            ),
          ),
        ).toEqual(basisExpected);
        expect(
          await capture("transformation", () =>
            f.db.transaction((tx) =>
              transformationStore.getRecordInTransaction(tx, tenant, actor, transformation.id),
            ),
          ),
        ).toEqual(transformationExpected);
        expect(
          await capture("transformationRaw", () =>
            f.db.transaction((tx) => readTransformationRecord(tx, tenant, transformation.id)),
          ),
        ).toEqual(transformationExpected);
        expect(
          await capture("shipping", () =>
            f.db.transaction((tx) =>
              shippingStore.getRecordInTransaction(tx, tenant, actor, shipping.id),
            ),
          ),
        ).toEqual(shippingExpected);
        expect(
          await capture("shippingRaw", () =>
            f.db.transaction((tx) => readShippingRecord(tx, tenant, shipping.id)),
          ),
        ).toEqual(shippingExpected);
        expect(
          await capture("shippingSnapshot", () =>
            f.db.transaction((tx) => readShippingSnapshotRecord(tx, tenant, shipping.id)),
          ),
        ).toEqual(shippingExpected);
        expect(
          await capture("shippingRevisions", () =>
            f.db.transaction((tx) =>
              readShippingRevisions(tx, tenant, shipping.id, { limit: 50, offset: 0 }),
            ),
          ),
        ).toEqual({
          items: [
            {
              id: shipping.id,
              rootId: shippingRoot.id,
              eventNumber: shipping.eventNumber,
              revision: shipping.revision,
              status: shipping.status,
              timeZone: shipping.timeZone,
              lifecycleVersion: shippingRoot.lifecycleVersion,
              currentEventId: shippingRoot.currentEventId,
              pendingDraftId: shippingRoot.pendingDraftId,
              previousRevisionId: shipping.previousRevisionId,
              amendmentReason: shipping.amendmentReason,
              voidReason: shipping.voidReason,
            },
          ],
          limit: 50,
          offset: 0,
          lifecycleVersion: shippingRoot.lifecycleVersion,
        });
        expect(await f.snapshot()).toEqual(before);
        expect(observed).toEqual(originalFamilySql);
      }),
    );
    it(
      "reloads ordinary facade authority, profile and changed business rows within one transaction",
      harness.phase(async () => {
        const { f, context } = harness;
        const tenant = context.tenantId;
        const actor = context.actorUserId;
        const [party] = await f.db.select().from(schema.traceabilityParties).limit(1);
        const [document] = await f.db.select().from(schema.referenceDocuments).limit(1);
        const [lot] = await f.db.select().from(schema.traceabilityLots).limit(1);
        if (!party || !document || !lot) throw new Error("Missing native freshness rows");
        const before = await f.snapshot();
        const rollback = new Error("native freshness rollback");
        const master = new UsMasterDataStore(f.db);
        const docs = new UsReferenceDocumentStore(f.db);
        const lots = new UsLotStore(f.db);
        const profiles = new UsProductProfileStore(f.db);
        await expect(
          f.db.transaction(async (tx) => {
            const getParty = () => master.getPartyInTransaction(tx, tenant, actor, party.id);
            const getDoc = () => docs.getDocumentInTransaction(tx, tenant, actor, document.id);
            const getLot = () => lots.getLotInTransaction(tx, tenant, actor, lot.id);
            expect(await getParty()).toEqual(partyResponse(party));
            expect(await getDoc()).toEqual(referenceDocumentResponse(document));
            expect(await getLot()).toEqual(lotResponse(lot));
            await tx
              .update(schema.traceabilityParties)
              .set({ name: "Fresh party" })
              .where(eq(schema.traceabilityParties.id, party.id));
            await tx
              .update(schema.referenceDocuments)
              .set({ number: "FRESH-DOCUMENT" })
              .where(eq(schema.referenceDocuments.id, document.id));
            await tx
              .update(schema.traceabilityLots)
              .set({ status: "archived" })
              .where(eq(schema.traceabilityLots.id, lot.id));
            expect(await getParty()).toEqual(partyResponse({ ...party, name: "Fresh party" }));
            expect(await getDoc()).toEqual(
              referenceDocumentResponse({ ...document, number: "FRESH-DOCUMENT" }),
            );
            expect(await getLot()).toEqual(lotResponse({ ...lot, status: "archived" }));
            await tx
              .update(schema.member)
              .set({ role: "member" })
              .where(
                and(eq(schema.member.organizationId, tenant), eq(schema.member.userId, actor)),
              );
            await expect(
              master.getPartyInTransaction(tx, tenant, actor, "malformed"),
            ).rejects.toMatchObject({ response: { code: "insufficient_permission" } });
            await expect(
              profiles.getProfileInTransaction(tx, tenant, actor, "malformed"),
            ).rejects.toMatchObject({ response: { code: "invalid_master_data" } });
            await tx
              .update(schema.member)
              .set({ role: "unknown,\u2003traceability_auditor\u2003" })
              .where(
                and(eq(schema.member.organizationId, tenant), eq(schema.member.userId, actor)),
              );
            expect(await getParty()).toEqual(partyResponse({ ...party, name: "Fresh party" }));
            await expect(authorizeUsMasterData(tx, tenant, actor, [])).rejects.toMatchObject({
              response: { code: "insufficient_permission" },
            });
            await tx
              .update(schema.traceabilityProfiles)
              .set({ code: "RU_CHZ" })
              .where(eq(schema.traceabilityProfiles.tenantId, tenant));
            await expect(getParty()).rejects.toMatchObject({
              response: { code: "traceability_profile_invalid" },
            });
            await tx
              .update(schema.traceabilityProfiles)
              .set({ code: "US_FSMA204_PROCESSOR" })
              .where(eq(schema.traceabilityProfiles.tenantId, tenant));
            await tx
              .update(schema.orgProfiles)
              .set({ timeZone: "invalid" })
              .where(eq(schema.orgProfiles.tenantId, tenant));
            await expect(getParty()).rejects.toMatchObject({
              response: { code: "traceability_profile_invalid" },
            });
            throw rollback;
          }),
        ).rejects.toBe(rollback);
        expect(await f.snapshot()).toEqual(before);
      }),
    );
    it(
      "preserves ordered and repeated batch identities, empty lists and exact responses",
      harness.phase(async () => {
        const { f, context } = harness;
        const parties = await f.db.select().from(schema.traceabilityParties).limit(2);
        const locations = await f.db.select().from(schema.traceabilityLocations).limit(2);
        const products = await f.db.select().from(schema.products).limit(2);
        const savedProfiles = await f.db.select().from(schema.productTraceabilityProfiles);
        if (parties.length !== 2 || locations.length !== 2 || products.length !== 2)
          throw new Error("Missing native batch rows");
        const [p0, p1] = parties;
        const [l0, l1] = locations;
        const [r0, r1] = products;
        if (!p0 || !p1 || !l0 || !l1 || !r0 || !r1)
          throw new Error("Missing native batch identities");
        const before = await f.snapshot();
        const tenant = context.tenantId;
        const actor = context.actorUserId;
        const master = new UsMasterDataStore(f.db);
        const catalog = new UsCatalogStore(f.db);
        const profiles = new UsProductProfileStore(f.db);
        const expectedProfile = (product: typeof r0) => {
          const row = savedProfiles.find((entry) => entry.productId === product.id);
          return row
            ? storedProfileResponse(row, "US_FSMA204_PROCESSOR")
            : profileDefaults(product);
        };
        await f.db.transaction(async (tx) => {
          expect(
            await master.getPartiesInTransaction(tx, tenant, actor, [p1.id, p0.id, p1.id]),
          ).toEqual([partyResponse(p1), partyResponse(p0), partyResponse(p1)]);
          expect(
            await master.getLocationsInTransaction(tx, tenant, actor, [l1.id, l0.id, l1.id]),
          ).toEqual([locationResponse(l1), locationResponse(l0), locationResponse(l1)]);
          expect(
            await catalog.getProductsInTransaction(tx, tenant, actor, [r1.id, r0.id, r1.id]),
          ).toEqual([productResponse(r1), productResponse(r0), productResponse(r1)]);
          expect(
            await profiles.getProfilesInTransaction(tx, tenant, actor, [r1.id, r0.id, r1.id]),
          ).toEqual([expectedProfile(r1), expectedProfile(r0), expectedProfile(r1)]);
          expect(await master.getPartiesInTransaction(tx, tenant, actor, [])).toEqual([]);
          expect(await master.getLocationsInTransaction(tx, tenant, actor, [])).toEqual([]);
          expect(await catalog.getProductsInTransaction(tx, tenant, actor, [])).toEqual([]);
          expect(await profiles.getProfilesInTransaction(tx, tenant, actor, [])).toEqual([]);
        });
        expect(await f.snapshot()).toEqual(before);
      }),
    );
  });

  it(
    "enters the mandatory native party core after acquiring its real database fixture",
    harness.phase(async () => {
      const { f, context } = harness;
      const refs = await new UsDatasetReferenceSeedStore(f.db).initialize(context);
      const id = refs.bindings.parties[0]?.id;
      if (!id) throw new Error("Missing reference party");
      const before = await f.snapshot();
      const readers = await import("../src/modules/traceability/master-data/us-master-data-read");
      const result = await f.db.transaction((tx) =>
        readers.readUsPartyCore(
          tx,
          context.tenantId,
          context.actorUserId,
          id,
          readers.freshUsMasterDataReaders,
        ),
      );
      expect(result.id).toBe(id);
      expect(await f.snapshot()).toEqual(before);
    }),
  );
});
