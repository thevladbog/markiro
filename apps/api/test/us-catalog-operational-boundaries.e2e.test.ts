import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ensurePartitions, schema } from "@markiro/db";
import { buildSscc, canonicalizeKm, INVENTORY_CHZ_STATUSES, kmHash } from "@markiro/domain";

import { loadEnv } from "../src/env";
import { BoxesService } from "../src/modules/boxes/boxes.service";
import { ChzExportRunnerService } from "../src/modules/chz-exports/chz-export-runner.service";
import { ChzTokenService } from "../src/modules/chz-exports/chz-token.service";
import { TrueApiClient } from "../src/modules/chz-exports/true-api.client";
import { InventoriesService } from "../src/modules/inventories/inventories.service";
import { InventoryLifecycleService } from "../src/modules/inventories/inventory-lifecycle.service";
import { InventorySnapshotService } from "../src/modules/inventories/inventory-snapshot.service";
import { JournalService } from "../src/modules/integrations/journal.service";
import { KiosksService } from "../src/modules/kiosks/kiosks.service";
import { NationalCatalogClient } from "../src/modules/national-catalog/national-catalog.client";
import {
  DrizzleNationalCatalogProductsRepository,
  NationalCatalogProductsService,
} from "../src/modules/national-catalog/national-catalog-products.service";
import { OperatorsService } from "../src/modules/operators/operators.service";
import { ShiftsService } from "../src/modules/shifts/shifts.service";
import { ChzCryptoService } from "../src/modules/signer-agents/chz-crypto.service";
import { SsccService } from "../src/modules/sscc/sscc.service";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { createUsProfileTestDatabase } from "./support/us-profile-database";

const url = process.env.US_TEST_DATABASE_URL;

function syntheticUsEnvironment(): NodeJS.ProcessEnv {
  const source = readFileSync(resolve("../../deploy/us-development/local.env.example"), "utf8");
  return Object.fromEntries(
    source
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe.skipIf(!url)("US catalog legacy boundaries with real isolated PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let shifts: ShiftsService;
  let kiosks: KiosksService;
  let boxes: BoxesService;
  let inventories: InventoriesService;
  let inventoryLifecycle: InventoryLifecycleService;
  let storage: ObjectStorageService;
  let chzTokens: ChzTokenService;
  let chzRunner: ChzExportRunnerService;
  let nationalCatalog: NationalCatalogProductsService;
  let tenantId: string;
  let actorUserId: string;
  let lineId: string;
  let nullProductId: string;
  let validProductId: string;
  const storageSend = vi.fn();
  const trueApiFetch = vi.fn<typeof fetch>();
  const nationalCatalogFetch = vi.fn<typeof fetch>();
  const crypto = new ChzCryptoService(Buffer.alloc(32, 0x71));

  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated test database");
    fixture = await createUsProfileTestDatabase(url);

    const entitlements = new EntitlementsService(fixture.db, "managed_only");
    shifts = new ShiftsService(
      fixture.db,
      new OperatorsService(fixture.db),
      new SsccService(fixture.db),
      entitlements,
    );
    kiosks = new KiosksService(fixture.db, entitlements);
    boxes = new BoxesService(fixture.db);
    inventoryLifecycle = new InventoryLifecycleService(fixture.db);

    const storageClient: NonNullable<ConstructorParameters<typeof ObjectStorageService>[1]> = {
      send: storageSend,
    };
    storage = new ObjectStorageService(loadEnv(syntheticUsEnvironment()), storageClient);
    const snapshots = new InventorySnapshotService(fixture.db, storage);
    inventories = new InventoriesService(fixture.db, storage, snapshots);

    chzTokens = new ChzTokenService(fixture.db, crypto);
    const trueApi = new TrueApiClient({
      fetch: trueApiFetch,
      scheduleAbort: () => () => undefined,
    });
    chzRunner = new ChzExportRunnerService(
      fixture.db,
      chzTokens,
      trueApi,
      inventories,
      new JournalService(fixture.db),
    );

    const nationalCatalogClient = new NationalCatalogClient({
      fetch: nationalCatalogFetch,
      scheduleAbort: () => () => undefined,
    });
    nationalCatalog = new NationalCatalogProductsService(
      new DrizzleNationalCatalogProductsRepository(fixture.db),
      nationalCatalogClient,
      chzTokens,
      "https://catalog.example.test",
    );
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    tenantId = randomUUID();
    actorUserId = randomUUID();
    lineId = randomUUID();
    nullProductId = randomUUID();
    validProductId = randomUUID();

    await fixture.db.insert(schema.organization).values({
      id: tenantId,
      name: "Synthetic US tenant",
      slug: tenantId,
      createdAt: new Date(),
    });
    await fixture.db.insert(schema.user).values({
      id: actorUserId,
      name: "Synthetic US owner",
      email: `${actorUserId}@example.test`,
    });
    await fixture.db.insert(schema.lines).values({ id: lineId, tenantId, name: "US line" });
    await fixture.db.insert(schema.products).values([
      {
        id: nullProductId,
        tenantId,
        gtin14: null,
        name: "US draft without GTIN",
        status: "active",
      },
      {
        id: validProductId,
        tenantId,
        gtin14: "10012345678902",
        name: "Legacy RU product",
        status: "active",
      },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects active null-GTIN shift creation before inserting a shift", async () => {
    await expect(
      shifts.createShift(tenantId, {
        productId: nullProductId,
        mode: "validation",
        boxLabelTemplateId: null,
      }),
    ).rejects.toMatchObject({ status: 422, response: { code: "GTIN_REQUIRED" } });

    expect(
      await fixture.db.select().from(schema.shifts).where(eq(schema.shifts.tenantId, tenantId)),
    ).toHaveLength(0);
  });

  it("rejects null-GTIN kiosk assignment without replacing the previous allowlist", async () => {
    const kioskId = randomUUID();
    await fixture.db.insert(schema.kiosks).values({ id: kioskId, tenantId, name: "US kiosk" });
    await fixture.db
      .insert(schema.kioskProducts)
      .values({ tenantId, kioskId, productId: validProductId });

    await expect(
      kiosks.setProducts(tenantId, kioskId, { productIds: [nullProductId] }),
    ).rejects.toMatchObject({ status: 422, response: { code: "GTIN_REQUIRED" } });

    expect(
      await fixture.db
        .select({ productId: schema.kioskProducts.productId })
        .from(schema.kioskProducts)
        .where(
          and(
            eq(schema.kioskProducts.tenantId, tenantId),
            eq(schema.kioskProducts.kioskId, kioskId),
          ),
        ),
    ).toEqual([{ productId: validProductId }]);
  });

  it("refuses a historical shift bundle when its current product has no GTIN", async () => {
    const shiftId = randomUUID();
    await fixture.db.insert(schema.shifts).values({
      id: shiftId,
      tenantId,
      productId: nullProductId,
      mode: "validation",
      numberMonthKey: "SEP26",
      numberSeq: 1,
    });

    await expect(shifts.getReferenceBundle(tenantId, shiftId)).rejects.toMatchObject({
      status: 422,
      response: { code: "GTIN_REQUIRED" },
    });
  });

  it("preserves specific empty and box-state errors after the GTIN guard", async () => {
    const now = new Date();
    const nullShiftId = randomUUID();
    const validShiftId = randomUUID();
    await fixture.db.insert(schema.shifts).values([
      {
        id: nullShiftId,
        tenantId,
        productId: nullProductId,
        mode: "validation",
        numberMonthKey: "SEP26",
        numberSeq: 2,
      },
      {
        id: validShiftId,
        tenantId,
        productId: validProductId,
        mode: "validation",
        numberMonthKey: "SEP26",
        numberSeq: 3,
      },
    ]);
    const nullBoxSscc = buildSscc(3, "4600682", 601);
    const emptyBoxSscc = buildSscc(3, "4600682", 602);
    const openBoxSscc = buildSscc(3, "4600682", 603);
    const disassembledBoxSscc = buildSscc(3, "4600682", 604);
    await fixture.db.insert(schema.boxes).values([
      {
        tenantId,
        shiftId: nullShiftId,
        deviceBoxId: "null-gtin-box",
        sscc: nullBoxSscc,
        closedAt: now,
        closureReceivedAt: now,
      },
      {
        tenantId,
        shiftId: validShiftId,
        deviceBoxId: "empty-box",
        sscc: emptyBoxSscc,
        closedAt: now,
        closureReceivedAt: now,
      },
      {
        tenantId,
        shiftId: nullShiftId,
        deviceBoxId: "open-box",
        sscc: openBoxSscc,
        closedAt: null,
        closureReceivedAt: null,
      },
      {
        tenantId,
        shiftId: nullShiftId,
        deviceBoxId: "disassembled-box",
        sscc: disassembledBoxSscc,
        closedAt: now,
        closureReceivedAt: now,
        disassembledAt: now,
      },
    ]);

    await expect(boxes.getSellCodes(tenantId, nullBoxSscc)).rejects.toMatchObject({
      status: 422,
      response: { code: "GTIN_REQUIRED" },
    });
    await expect(boxes.getSellCodes(tenantId, emptyBoxSscc)).rejects.toMatchObject({
      status: 409,
      response: { code: "box_empty" },
    });
    await expect(boxes.getSellCodes(tenantId, openBoxSscc)).rejects.toMatchObject({
      status: 409,
      response: { code: "box_not_closed" },
    });
    await expect(boxes.getSellCodes(tenantId, disassembledBoxSscc)).rejects.toMatchObject({
      status: 409,
      response: { code: "box_disassembled" },
    });
  });

  it("distinguishes missing canonical facts from mismatched and matching canonical GTINs", async () => {
    const closure = new Date();
    const scannedAt = new Date(closure.getTime() - 1_000);
    const shiftId = randomUUID();
    await fixture.db.insert(schema.shifts).values({
      id: shiftId,
      tenantId,
      productId: validProductId,
      mode: "validation",
      numberMonthKey: "SEP26",
      numberSeq: 4,
    });
    const missingBoxId = randomUUID();
    const mismatchBoxId = randomUUID();
    const matchingBoxId = randomUUID();
    const missingSscc = buildSscc(3, "4600682", 611);
    const mismatchSscc = buildSscc(3, "4600682", 612);
    const matchingSscc = buildSscc(3, "4600682", 613);
    await fixture.db.insert(schema.boxes).values([
      {
        id: missingBoxId,
        tenantId,
        shiftId,
        deviceBoxId: "missing-canonical-box",
        sscc: missingSscc,
        closedAt: closure,
        closureReceivedAt: closure,
      },
      {
        id: mismatchBoxId,
        tenantId,
        shiftId,
        deviceBoxId: "mismatched-canonical-box",
        sscc: mismatchSscc,
        closedAt: closure,
        closureReceivedAt: closure,
      },
      {
        id: matchingBoxId,
        tenantId,
        shiftId,
        deviceBoxId: "matching-canonical-box",
        sscc: matchingSscc,
        closedAt: closure,
        closureReceivedAt: closure,
      },
    ]);
    await ensurePartitions(fixture.db, [scannedAt]);
    const mismatch = canonicalizeKm("010400638133393121MISMATCH");
    const matching = canonicalizeKm("011001234567890221MATCHING");
    const mismatchHash = kmHash(mismatch);
    const matchingHash = kmHash(matching);
    await fixture.db.insert(schema.codes).values([
      {
        tenantId,
        codeHash: mismatchHash,
        shiftId,
        gtin14: mismatch.gtin14,
        serial: mismatch.serial,
        canonicalRaw: mismatch.raw,
        scannedAt,
      },
      {
        tenantId,
        codeHash: matchingHash,
        shiftId,
        gtin14: matching.gtin14,
        serial: matching.serial,
        canonicalRaw: matching.raw,
        scannedAt,
      },
    ]);
    await fixture.db.insert(schema.codeRegistry).values([
      { tenantId, codeHash: mismatchHash, shiftId, scannedAt, updatedAt: scannedAt },
      { tenantId, codeHash: matchingHash, shiftId, scannedAt, updatedAt: scannedAt },
    ]);
    await fixture.db.insert(schema.boxItems).values([
      {
        tenantId,
        boxId: missingBoxId,
        codeHash: "c".repeat(64),
        addedAt: scannedAt,
      },
      { tenantId, boxId: mismatchBoxId, codeHash: mismatchHash, addedAt: scannedAt },
      { tenantId, boxId: matchingBoxId, codeHash: matchingHash, addedAt: scannedAt },
    ]);

    await expect(boxes.getSellCodes(tenantId, missingSscc)).rejects.toMatchObject({
      status: 409,
      response: { code: "box_contents_changed" },
    });
    await expect(boxes.getSellCodes(tenantId, mismatchSscc)).rejects.toMatchObject({
      status: 409,
      response: { code: "box_contents_changed" },
    });
    await expect(boxes.getSellCodes(tenantId, matchingSscc)).resolves.toMatchObject({
      boxId: matchingBoxId,
      itemCount: 1,
      items: [{ gtin14: "10012345678902", serial: "MATCHING" }],
    });
  });

  it("rejects inventory creation before inventory, audit, or object-storage side effects", async () => {
    await expect(
      inventories.create(tenantId, actorUserId, {
        productId: nullProductId,
        lineId,
        mode: "check",
        productionDateFrom: "2026-09-01",
        productionDateTo: "2026-09-05",
      }),
    ).rejects.toMatchObject({ status: 422, response: { code: "GTIN_REQUIRED" } });

    expect(
      await fixture.db
        .select()
        .from(schema.inventories)
        .where(eq(schema.inventories.tenantId, tenantId)),
    ).toHaveLength(0);
    expect(
      await fixture.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, tenantId)),
    ).toHaveLength(0);
    expect(storageSend).not.toHaveBeenCalled();
  });

  it("keeps the changed-GTIN conflict when an import recheck observes value-to-null", async () => {
    const inventoryId = randomUUID();
    await fixture.db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId,
      number: `INVENTORY-26-${Date.now()}`,
      productId: validProductId,
      gtin14Snapshot: "10012345678902",
      lineId,
      mode: "check",
      productionDateFrom: "2026-09-01",
      productionDateTo: "2026-09-05",
      createdByUserId: actorUserId,
    });
    const deleteObject = vi.spyOn(storage, "delete").mockResolvedValueOnce(undefined);
    vi.spyOn(storage, "putVerified").mockImplementationOnce(
      async (_key, body, _contentType, sha256) => {
        await fixture.db
          .update(schema.products)
          .set({ gtin14: null })
          .where(
            and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, validProductId)),
          );
        return { byteSize: body.byteLength, sha256 };
      },
    );

    await expect(
      inventories.importEvidence(tenantId, actorUserId, inventoryId, "INTRODUCED", {
        originalName: "introduced.csv",
        mimeType: "text/csv",
        bytes: Buffer.from("synthetic import"),
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "INVENTORY_PRODUCT_GTIN_CHANGED" },
    });
    expect(deleteObject).toHaveBeenCalledOnce();
    expect(
      await fixture.db
        .select()
        .from(schema.inventoryImports)
        .where(eq(schema.inventoryImports.inventoryId, inventoryId)),
    ).toHaveLength(0);
  });

  it("keeps the changed-GTIN conflict when start observes value-to-null", async () => {
    const inventoryId = randomUUID();
    await fixture.db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId,
      number: `INVENTORY-26-${Date.now()}`,
      productId: validProductId,
      gtin14Snapshot: "10012345678902",
      lineId,
      mode: "check",
      productionDateFrom: "2026-09-01",
      productionDateTo: "2026-09-05",
      createdByUserId: actorUserId,
    });
    const imports = INVENTORY_CHZ_STATUSES.map((status, index) => ({
      id: randomUUID(),
      tenantId,
      inventoryId,
      declaredStatus: status,
      fileName: `${status.toLowerCase()}.csv`,
      containerKind: "csv" as const,
      byteSize: 1,
      sha256: index.toString(16).padStart(64, "0"),
      objectKey: `synthetic/${inventoryId}/${status}`,
      parsedStatus: status,
      includedGtin14: "10012345678902",
      parseOutcome: "succeeded" as const,
      rowCount: 0,
      errorCount: 0,
      duplicateCount: 0,
      createdByUserId: actorUserId,
    }));
    await fixture.db.insert(schema.inventoryImports).values(imports);
    const [snapshot] = await fixture.db
      .insert(schema.inventorySnapshots)
      .values({
        tenantId,
        inventoryId,
        combinedDigest: "a".repeat(64),
        productName: "Legacy RU product",
        lineName: "US line",
        boxCapacity: 12,
        emittedCount: 0,
        introducedCount: 0,
        appliedCount: 0,
        retiredCount: 0,
        writtenOffCount: 0,
        disaggregationCount: 0,
        protectedCount: 0,
        expectedCount: 0,
        packageCount: 0,
        looseCount: 0,
        fixedByUserId: actorUserId,
      })
      .returning({ id: schema.inventorySnapshots.id });
    if (!snapshot) throw new Error("Expected inventory snapshot fixture");
    await fixture.db.insert(schema.inventorySnapshotInputs).values(
      imports.map((input) => ({
        tenantId,
        snapshotId: snapshot.id,
        inventoryId,
        status: input.declaredStatus,
        importId: input.id,
        importParseOutcome: "succeeded" as const,
      })),
    );
    await fixture.db
      .update(schema.inventories)
      .set({ status: "ready", activeSnapshotId: snapshot.id })
      .where(eq(schema.inventories.id, inventoryId));
    await fixture.db
      .update(schema.products)
      .set({ gtin14: null })
      .where(eq(schema.products.id, validProductId));

    await expect(
      inventoryLifecycle.start(tenantId, actorUserId, inventoryId),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "INVENTORY_PRODUCT_GTIN_CHANGED" },
    });
    const [inventory] = await fixture.db
      .select({ status: schema.inventories.status })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, inventoryId));
    expect(inventory?.status).toBe("ready");
  });

  it("blocks CHZ export and National Catalog access before external provider calls", async () => {
    const [group] = await fixture.db
      .select({ code: schema.chzProductGroups.code })
      .from(schema.chzProductGroups)
      .limit(1);
    if (!group) throw new Error("Expected seeded CHZ product groups");

    await fixture.db
      .update(schema.products)
      .set({ chzProductGroupCode: group.code })
      .where(eq(schema.products.id, nullProductId));
    await fixture.db
      .insert(schema.orgProfiles)
      .values({ tenantId, inn: "7707083893", timeZone: "America/Chicago" });
    const encrypted = crypto.encrypt(tenantId, "synthetic-token");
    await fixture.db.insert(schema.chzApiTokens).values({
      tenantId,
      ...encrypted,
      obtainedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const inventoryId = randomUUID();
    await fixture.db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId,
      number: `INVENTORY-26-${Date.now()}`,
      productId: nullProductId,
      gtin14Snapshot: "10012345678902",
      lineId,
      mode: "check",
      productionDateFrom: "2026-09-01",
      productionDateTo: "2026-09-05",
      createdByUserId: actorUserId,
    });
    await fixture.db.insert(schema.chzExportRuns).values({
      tenantId,
      inventoryId,
      status: "EMITTED",
      orderedByUserId: actorUserId,
    });

    await expect(
      chzRunner.run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 }),
    ).resolves.toEqual({ finished: true });
    const [run] = await fixture.db
      .select({ state: schema.chzExportRuns.state, errorCode: schema.chzExportRuns.errorCode })
      .from(schema.chzExportRuns)
      .where(
        and(
          eq(schema.chzExportRuns.tenantId, tenantId),
          eq(schema.chzExportRuns.inventoryId, inventoryId),
        ),
      );
    expect(run).toEqual({ state: "failed", errorCode: "CHZ_ORDER_CONTEXT_MISSING" });
    expect(trueApiFetch).not.toHaveBeenCalled();

    await expect(nationalCatalog.lookup(tenantId, nullProductId)).rejects.toMatchObject({
      status: 422,
      response: { code: "GTIN_REQUIRED" },
    });
    expect(nationalCatalogFetch).not.toHaveBeenCalled();
  });
});
