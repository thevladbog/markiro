import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildChzKmOrderBody, parseKm, kmHash } from "@markiro/domain";

import {
  ChzKmOrderRunnerService,
  MAX_SIGN_ATTEMPTS,
} from "../src/modules/chz-km-orders/chz-km-order-runner.service";
import { ChzOmsTokenService } from "../src/modules/chz-km-orders/chz-oms-token.service";
import { ChzKmOrdersService } from "../src/modules/chz-km-orders/chz-km-orders.service";
import { CHZ_KM_ORDER_NOT_FAILED_CODE } from "../src/modules/chz-km-orders/dto";
import type { OmsClient } from "../src/modules/chz-km-orders/oms.client";
import type {
  OmsAuth,
  OmsBlockSummary,
  OmsBufferInfo,
  OmsCodesBlock,
  OmsCreatedOrder,
  OmsResult,
} from "../src/modules/chz-km-orders/oms.types";
import { ChzCryptoService } from "../src/modules/signer-agents/chz-crypto.service";
import { CHZ_CHANNEL_TYPE } from "../src/modules/signer-agents/chz-constants";
import type { JournalService } from "../src/modules/integrations/journal.service";
import { createOrganization } from "./support/subscription-fixtures";

const ready = Boolean(process.env.DATABASE_URL && process.env.CHZ_TOKEN_ENCRYPTION_KEY);

// `chz_product_groups` (migration 0099) seeds code 15 as alias "beer", and
// `CHZ_UNIT_TEMPLATE_ID_BY_GROUP.beer` (packages/domain/src/chz/km-orders.ts)
// is 18 -- two different numbering schemes, both asserted against directly.
const BEER_GROUP_CODE = 15;
const BEER_TEMPLATE_ID = 18;
const GTIN = "04607034690014";
const OMS_ID = "cdf12109-10d3-11e6-8b6f-0050569977a1";
const OMS_CONNECTION = "b7f0c8b0-10d3-11e6-8b6f-0050569977a1";
const OMS_ORDER_ID = "3f2a9b10-10d3-11e6-8b6f-0050569977a1";
const CLIENT_TOKEN = "true-api-client-token-should-never-be-journalled";

interface OmsCall {
  op: "createOrder" | "getBufferStatus" | "getCodes" | "listBlocks" | "retryBlock";
  [key: string]: unknown;
}

type Handlers = Partial<{
  createOrder: (
    auth: OmsAuth,
    body: string,
    signature: string,
  ) => Promise<OmsResult<OmsCreatedOrder>> | OmsResult<OmsCreatedOrder>;
  getBufferStatus: (
    auth: OmsAuth,
    orderId: string,
    gtin14: string,
  ) => Promise<OmsResult<OmsBufferInfo>> | OmsResult<OmsBufferInfo>;
  getCodes: (
    auth: OmsAuth,
    orderId: string,
    gtin14: string,
    quantity: number,
  ) => Promise<OmsResult<OmsCodesBlock>> | OmsResult<OmsCodesBlock>;
  listBlocks: (
    auth: OmsAuth,
    orderId: string,
    gtin14: string,
  ) => Promise<OmsResult<OmsBlockSummary[]>> | OmsResult<OmsBlockSummary[]>;
  retryBlock: (
    auth: OmsAuth,
    blockId: string,
  ) => Promise<OmsResult<OmsCodesBlock>> | OmsResult<OmsCodesBlock>;
}>;

/** The real client is covered by its own suite; here the transport is a fake that records every call. */
function fakeOmsClient(handlers: Handlers = {}): { client: OmsClient; calls: OmsCall[] } {
  const calls: OmsCall[] = [];
  const client = {
    createOrder: vi.fn(async (auth: OmsAuth, body: string, signature: string) => {
      calls.push({ op: "createOrder", body, signature });
      if (!handlers.createOrder) throw new Error("fakeOmsClient.createOrder not configured");
      return handlers.createOrder(auth, body, signature);
    }),
    getBufferStatus: vi.fn(async (auth: OmsAuth, orderId: string, gtin14: string) => {
      calls.push({ op: "getBufferStatus", orderId, gtin14 });
      if (!handlers.getBufferStatus)
        throw new Error("fakeOmsClient.getBufferStatus not configured");
      return handlers.getBufferStatus(auth, orderId, gtin14);
    }),
    getCodes: vi.fn(async (auth: OmsAuth, orderId: string, gtin14: string, quantity: number) => {
      calls.push({ op: "getCodes", orderId, gtin14, quantity });
      if (!handlers.getCodes) throw new Error("fakeOmsClient.getCodes not configured");
      return handlers.getCodes(auth, orderId, gtin14, quantity);
    }),
    listBlocks: vi.fn(async (auth: OmsAuth, orderId: string, gtin14: string) => {
      calls.push({ op: "listBlocks", orderId, gtin14 });
      if (!handlers.listBlocks) throw new Error("fakeOmsClient.listBlocks not configured");
      return handlers.listBlocks(auth, orderId, gtin14);
    }),
    retryBlock: vi.fn(async (auth: OmsAuth, blockId: string) => {
      calls.push({ op: "retryBlock", blockId });
      if (!handlers.retryBlock) throw new Error("fakeOmsClient.retryBlock not configured");
      return handlers.retryBlock(auth, blockId);
    }),
  };
  return { client: client as unknown as OmsClient, calls };
}

/** A syntactically valid Chestny ZNAK KM for `GTIN` with a unique serial. */
function makeKm(serial: string): string {
  return `01${GTIN}21${serial}`;
}

describe.skipIf(!ready)("ChzKmOrderRunnerService", () => {
  const databaseName = `markiro_chz_km_order_runner_${randomUUID().replaceAll("-", "_")}`;
  const maintenanceUrl = process.env.DATABASE_URL ?? "postgres://invalid";
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(maintenanceUrl);
  let connection: ReturnType<typeof createDb>;
  let db: Db;

  let tenantId: string;
  let userId: string;
  let productId: string;
  let crypto: ChzCryptoService;
  let tokens: ChzOmsTokenService;
  let journal: { append: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(scratchUrl.toString(), { max: 8 });
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    db = connection.db;
    crypto = new ChzCryptoService(randomBytes(32));
    tokens = new ChzOmsTokenService(db, crypto);
  }, 120_000);

  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.pool.end();
  });

  beforeEach(async () => {
    tenantId = await createOrganization(db);
    userId = randomUUID();
    productId = randomUUID();

    await db.insert(schema.user).values({
      id: userId,
      name: "Runner fixture operator",
      email: `${randomUUID()}@example.invalid`,
      emailVerified: false,
    });
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: tenantId,
      userId,
      role: "owner",
      createdAt: new Date(),
    });
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN,
      name: "Runner fixture product",
      chzProductGroupCode: BEER_GROUP_CODE,
    });

    journal = { append: vi.fn().mockResolvedValue(undefined) };
  });

  function runnerWith(client: OmsClient): ChzKmOrderRunnerService {
    return new ChzKmOrderRunnerService(
      db,
      tokens,
      client,
      crypto,
      journal as unknown as JournalService,
    );
  }

  async function seedOmsToken(overrides: { omsConnection?: string } = {}): Promise<void> {
    const omsConnection = overrides.omsConnection ?? OMS_CONNECTION;
    await db.insert(schema.integrationChannels).values({
      tenantId,
      type: CHZ_CHANNEL_TYPE,
      settings: { environment: "sandbox", omsId: OMS_ID, omsConnection },
    });
    const encrypted = crypto.encrypt(tenantId, CLIENT_TOKEN);
    await db.insert(schema.chzOmsTokens).values({
      tenantId,
      ...encrypted,
      sourceOmsConnection: omsConnection,
      sourceTrueApiBaseUrl: "https://suz.sandbox.crptech.ru/api/v3",
      obtainedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  }

  async function insertOrder(
    overrides: Partial<typeof schema.chzKmOrders.$inferInsert> = {},
  ): Promise<typeof schema.chzKmOrders.$inferSelect> {
    const id = overrides.id ?? randomUUID();
    const quantity = overrides.quantity ?? 5;
    const requestBody =
      overrides.requestBody ??
      buildChzKmOrderBody({
        productGroupAlias: "beer",
        gtin14: GTIN,
        quantity,
        templateId: BEER_TEMPLATE_ID,
        productionOrderId: id,
      });
    await db.insert(schema.chzKmOrders).values({
      id,
      tenantId,
      productId,
      gtin14: GTIN,
      productGroupAlias: "beer",
      productGroupCode: BEER_GROUP_CODE,
      templateId: BEER_TEMPLATE_ID,
      quantity,
      state: "created",
      requestBody,
      createdByUserId: userId,
      deadlineAt: new Date(Date.now() + 48 * 3600_000),
      ...overrides,
    });
    const [row] = await db
      .select()
      .from(schema.chzKmOrders)
      .where(and(eq(schema.chzKmOrders.tenantId, tenantId), eq(schema.chzKmOrders.id, id)));
    if (!row) throw new Error("fixture order was not inserted");
    return row;
  }

  async function loadOrder(id: string): Promise<typeof schema.chzKmOrders.$inferSelect> {
    const [row] = await db
      .select()
      .from(schema.chzKmOrders)
      .where(and(eq(schema.chzKmOrders.tenantId, tenantId), eq(schema.chzKmOrders.id, id)));
    if (!row) throw new Error(`order ${id} vanished`);
    return row;
  }

  async function signerTasksFor(
    orderId: string,
  ): Promise<(typeof schema.chzSignerTasks.$inferSelect)[]> {
    const rows = await db
      .select()
      .from(schema.chzSignerTasks)
      .where(
        and(
          eq(schema.chzSignerTasks.tenantId, tenantId),
          eq(schema.chzSignerTasks.type, "sign_detached"),
        ),
      );
    return rows.filter((row) => {
      const payload = row.payload as { orderId?: unknown };
      return payload.orderId === orderId;
    });
  }

  async function completeSignerTask(taskId: string): Promise<void> {
    await db
      .update(schema.chzSignerTasks)
      .set({
        status: "completed",
        resultSummary: { signatureBase64: "c2ln", certThumbprint: "AB12" },
        completedAt: new Date(),
      })
      .where(eq(schema.chzSignerTasks.id, taskId));
  }

  async function failSignerTask(taskId: string): Promise<void> {
    await db
      .update(schema.chzSignerTasks)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(schema.chzSignerTasks.id, taskId));
  }

  async function codesFor(orderId: string): Promise<(typeof schema.chzKmCodes.$inferSelect)[]> {
    return db
      .select()
      .from(schema.chzKmCodes)
      .where(and(eq(schema.chzKmCodes.tenantId, tenantId), eq(schema.chzKmCodes.orderId, orderId)))
      .orderBy(schema.chzKmCodes.seq);
  }

  it("created -> signing: inserts one sign_detached task and moves the order", async () => {
    const order = await insertOrder();
    const { client } = fakeOmsClient();
    const runner = runnerWith(client);

    const outcome = await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });

    expect(outcome).toEqual({ finished: false, retryAfterSeconds: 30 });
    const tasks = await signerTasksFor(order.id);
    expect(tasks).toHaveLength(1);
    const payload = tasks[0]!.payload as { dataBase64: string };
    expect(Buffer.from(payload.dataBase64, "base64").toString("utf8")).toBe(order.requestBody);

    const reloaded = await loadOrder(order.id);
    expect(reloaded.state).toBe("signing");
    expect(reloaded.signerTaskId).toBe(tasks[0]!.id);
    expect(reloaded.attempts).toBe(1);
  });

  it("refuses a second signing slot while one is already open for the tenant", async () => {
    const busyTaskId = randomUUID();
    await db.insert(schema.chzSignerTasks).values({
      id: busyTaskId,
      tenantId,
      type: "sign_detached",
      status: "pending",
      payload: { purpose: "oms_order", orderId: randomUUID(), dataBase64: "eA==" },
    });
    const order = await insertOrder();
    const { client } = fakeOmsClient();
    const runner = runnerWith(client);

    const outcome = await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });

    expect(outcome).toEqual({ finished: false, retryAfterSeconds: 30 });
    const allTasks = await db
      .select()
      .from(schema.chzSignerTasks)
      .where(eq(schema.chzSignerTasks.tenantId, tenantId));
    expect(allTasks).toHaveLength(1);
    expect(allTasks[0]!.id).toBe(busyTaskId);

    const reloaded = await loadOrder(order.id);
    expect(reloaded.state).toBe("created");
    expect(reloaded.signerTaskId).toBeNull();
  });

  it("signing -> submitted: sends the exact request body and signature, records the СУЗ order id", async () => {
    const order = await insertOrder();
    await seedOmsToken();
    const { client, calls } = fakeOmsClient({
      createOrder: () => ({
        status: "ok",
        value: { orderId: OMS_ORDER_ID, expectedCompleteMs: 5_000 },
      }),
    });
    const runner = runnerWith(client);

    await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });
    const [task] = await signerTasksFor(order.id);
    await completeSignerTask(task!.id);

    const outcome = await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });

    const createCall = calls.find((call) => call.op === "createOrder");
    expect(createCall).toMatchObject({ body: order.requestBody, signature: "c2ln" });
    const reloaded = await loadOrder(order.id);
    expect(reloaded.state).toBe("submitted");
    expect(reloaded.omsOrderId).toBe(OMS_ORDER_ID);
    expect(outcome.finished).toBe(false);
  });

  it("submitted -> buffer_pending -> buffer_active -> fetching -> completed", async () => {
    const order = await insertOrder({ quantity: 25, state: "submitted", omsOrderId: OMS_ORDER_ID });
    await seedOmsToken();
    let bufferCall = 0;
    let codesCall = 0;
    // СУЗ hands out exactly what was asked for. The earlier fake returned 15
    // codes for a 10-code request, so the counter jumped 0 -> 15 -> 25, the
    // final block was never reached and `listBlocks` was never called -- and
    // the over-delivery it simulated is the protocol violation the runner now
    // refuses outright.
    const issuedBlocks: OmsBlockSummary[] = [];
    const issuedCodes: string[] = [];
    const { client, calls } = fakeOmsClient({
      getBufferStatus: () => {
        bufferCall += 1;
        const info: OmsBufferInfo = {
          bufferStatus: bufferCall === 1 ? "PENDING" : "ACTIVE",
          availableCodes: 25,
          leftInBuffer: 25,
          totalCodes: 25,
          totalPassed: 0,
          expiredDate: null,
          rejectionReason: null,
        };
        return { status: "ok", value: info };
      },
      getCodes: (_auth, _orderId, _gtin14, quantity) => {
        codesCall += 1;
        const codes = Array.from({ length: quantity }, (_, i) => makeKm(`BLOCK${codesCall}N${i}`));
        const blockId = randomUUID();
        issuedBlocks.push({ blockId, quantity });
        issuedCodes.push(...codes);
        return { status: "ok", value: { codes, blockId } };
      },
      listBlocks: () => ({ status: "ok", value: [...issuedBlocks] }),
    });
    const runner = runnerWith(client);
    runner.blockSize = 10;

    const first = await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });
    expect(first.finished).toBe(false);
    expect((await loadOrder(order.id)).state).toBe("buffer_pending");

    const second = await runner.run(tenantId, order.id, { retryCount: 1, retryLimit: 5 });
    expect(second.finished).toBe(true);

    const reloaded = await loadOrder(order.id);
    expect(reloaded.state).toBe("completed");
    expect(reloaded.fetchedCount).toBe(25);

    // One reconcile opens the pass, the middle block needs none because the
    // counter has not moved since it, and the last one is reconciled before
    // the final block closes the sub-order.
    expect(calls.map((call) => call.op)).toEqual([
      "getBufferStatus",
      "getBufferStatus",
      "listBlocks",
      "getCodes",
      "getCodes",
      "listBlocks",
      "getCodes",
    ]);
    expect(calls.filter((call) => call.op === "getCodes").map((call) => call.quantity)).toEqual([
      10, 10, 5,
    ]);

    const rows = await codesFor(order.id);
    expect(rows).toHaveLength(25);
    for (const row of rows) {
      const decrypted = crypto.decryptWithAad(`${tenantId}/${order.id}/${row.seq}`, {
        encryptedToken: row.encryptedCode,
        tokenNonce: row.codeNonce,
        tokenTag: row.codeTag,
      });
      expect(kmHash(parseKm(decrypted))).toBe(row.codeHash);
    }

    const completionCall = journal.append.mock.calls.find(
      (call) => (call[0] as { message: string }).message === "Коды КМ получены",
    );
    expect(completionCall).toBeDefined();
    const details = (completionCall![0] as { details: Record<string, unknown> }).details;
    expect(details).toEqual({ orderId: order.id, omsOrderId: OMS_ORDER_ID, quantity: 25 });
    const journalled = JSON.stringify(journal.append.mock.calls);
    for (const code of issuedCodes) expect(journalled).not.toContain(code);
  });

  it("reconciles a block the database does not hold before requesting the final block", async () => {
    const order = await insertOrder({
      quantity: 20,
      state: "fetching",
      omsOrderId: OMS_ORDER_ID,
      fetchedCount: 10,
    });
    await seedOmsToken();

    const blockA = randomUUID();
    const blockB = randomUUID();
    const blockC = randomUUID();
    const rowsA = Array.from({ length: 10 }, (_, i) => {
      const code = makeKm(`HELD${i}`);
      const sealed = crypto.encryptWithAad(`${tenantId}/${order.id}/${i + 1}`, code);
      return {
        tenantId,
        orderId: order.id,
        seq: i + 1,
        encryptedCode: sealed.encryptedToken,
        codeNonce: sealed.tokenNonce,
        codeTag: sealed.tokenTag,
        codeHash: kmHash(parseKm(code)),
        blockId: blockA,
      };
    });
    await db.insert(schema.chzKmCodes).values(rowsA);

    const { client, calls } = fakeOmsClient({
      listBlocks: () => ({
        status: "ok",
        value: [
          { blockId: blockA, quantity: 10 },
          { blockId: blockB, quantity: 5 },
        ],
      }),
      retryBlock: (_auth, blockId) => {
        expect(blockId).toBe(blockB);
        return {
          status: "ok",
          value: {
            codes: Array.from({ length: 5 }, (_, i) => makeKm(`RECON${i}`)),
            blockId: blockB,
          },
        };
      },
      getCodes: () => ({
        status: "ok",
        value: { codes: Array.from({ length: 5 }, (_, i) => makeKm(`FINAL${i}`)), blockId: blockC },
      }),
    });
    const runner = runnerWith(client);

    const outcome = await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });

    expect(outcome.finished).toBe(true);
    const reconcileIndex = calls.findIndex((call) => call.op === "retryBlock");
    const finalIndex = calls.findIndex((call) => call.op === "getCodes");
    expect(reconcileIndex).toBeGreaterThanOrEqual(0);
    expect(finalIndex).toBeGreaterThan(reconcileIndex);

    const reloaded = await loadOrder(order.id);
    expect(reloaded.state).toBe("completed");
    expect(reloaded.fetchedCount).toBe(20);

    const reconciledRows = await db
      .select()
      .from(schema.chzKmCodes)
      .where(and(eq(schema.chzKmCodes.tenantId, tenantId), eq(schema.chzKmCodes.blockId, blockB)));
    expect(reconciledRows).toHaveLength(5);
  });

  it("REJECTED buffer fails the order with the verbatim reason, and retry() refuses it", async () => {
    const order = await insertOrder({ state: "submitted", omsOrderId: OMS_ORDER_ID });
    await seedOmsToken();
    const { client } = fakeOmsClient({
      getBufferStatus: () => ({
        status: "ok",
        value: {
          bufferStatus: "REJECTED",
          availableCodes: -1,
          leftInBuffer: -1,
          totalCodes: -1,
          totalPassed: -1,
          expiredDate: null,
          rejectionReason: "ЧЗ отклонил заказ: неверный GTIN",
        },
      }),
    });
    const runner = runnerWith(client);

    const outcome = await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });

    expect(outcome).toEqual({ finished: true, retryAfterSeconds: 30 });
    const reloaded = await loadOrder(order.id);
    expect(reloaded.state).toBe("rejected");
    expect(reloaded.rejectionReason).toBe("ЧЗ отклонил заказ: неверный GTIN");

    const service = new ChzKmOrdersService(db, tokens, {
      enqueueChzKmOrder: vi.fn().mockResolvedValue(null),
    });
    await expect(service.retry(tenantId, order.id)).rejects.toMatchObject({
      response: { code: CHZ_KM_ORDER_NOT_FAILED_CODE },
    });
  });

  it("resets a failed signing task back to created, then fails after MAX_SIGN_ATTEMPTS", async () => {
    const order = await insertOrder();
    const { client } = fakeOmsClient();
    const runner = runnerWith(client);

    for (let cycle = 1; cycle <= MAX_SIGN_ATTEMPTS; cycle += 1) {
      const created = await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });
      expect(created.finished).toBe(false);
      const { signerTaskId } = await loadOrder(order.id);
      await failSignerTask(signerTaskId!);

      const afterFailure = await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });
      expect(afterFailure.finished).toBe(false);
      const reloaded = await loadOrder(order.id);
      expect(reloaded.state).toBe("created");
      expect(reloaded.attempts).toBe(cycle);
    }

    const final = await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });
    expect(final).toEqual({ finished: true, retryAfterSeconds: 0 });
    const reloaded = await loadOrder(order.id);
    expect(reloaded.state).toBe("failed");
    expect(reloaded.errorCode).toBe("CHZ_SIGNING_FAILED");
  });

  it("a СУЗ order rejection fails the order with its own wording", async () => {
    const order = await insertOrder();
    await seedOmsToken();
    const { client } = fakeOmsClient({
      createOrder: () => ({
        status: "rejected",
        code: "400",
        message: "productionOrderId invalid",
      }),
    });
    const runner = runnerWith(client);

    await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });
    const [task] = await signerTasksFor(order.id);
    await completeSignerTask(task!.id);

    const outcome = await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });

    expect(outcome).toEqual({ finished: true, retryAfterSeconds: 0 });
    const reloaded = await loadOrder(order.id);
    expect(reloaded.state).toBe("failed");
    expect(reloaded.errorCode).toBe("CHZ_ORDER_REJECTED_BY_SUZ");
    expect(reloaded.errorMessage).toBe("productionOrderId invalid");
  });

  it("times out a past-deadline order before ever looking up the token", async () => {
    const order = await insertOrder({
      state: "submitted",
      omsOrderId: OMS_ORDER_ID,
      deadlineAt: new Date(Date.now() - 1_000),
    });
    // Deliberately no `seedOmsToken()`: the token row does not exist, and the
    // assertion below is that the token service is never even asked.
    const { client } = fakeOmsClient();
    const runner = runnerWith(client);
    const tokenSpy = vi.spyOn(tokens, "getActiveToken");

    const outcome = await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });

    expect(outcome).toEqual({ finished: true, retryAfterSeconds: 0 });
    expect(tokenSpy).not.toHaveBeenCalled();
    const reloaded = await loadOrder(order.id);
    expect(reloaded.state).toBe("failed");
    expect(reloaded.errorCode).toBe("CHZ_ORDER_TIMED_OUT");
    tokenSpy.mockRestore();
  });

  it("fails the order on an unparseable code and stores no partial rows for that block", async () => {
    const order = await insertOrder({ quantity: 3, state: "fetching", omsOrderId: OMS_ORDER_ID });
    await seedOmsToken();
    const { client, calls } = fakeOmsClient({
      // The whole order fits in one block, so `fetchCodes` reconciles against
      // СУЗ's own block list before requesting it (see `reconcileBlocks`);
      // an empty list means nothing was lost from a previous pass.
      listBlocks: () => ({ status: "ok", value: [] }),
      getCodes: () => ({
        status: "ok",
        value: {
          codes: [makeKm("GOOD1"), "not-a-valid-km", makeKm("GOOD2")],
          blockId: randomUUID(),
        },
      }),
    });
    const runner = runnerWith(client);

    const outcome = await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });

    expect(outcome).toEqual({ finished: true, retryAfterSeconds: 30 });
    // The whole order is one block, so the start-of-pass reconcile is also
    // the before-final-block one: asking twice would buy nothing.
    expect(calls.filter((call) => call.op === "listBlocks")).toHaveLength(1);
    const reloaded = await loadOrder(order.id);
    expect(reloaded.state).toBe("failed");
    expect(reloaded.errorCode).toBe("CHZ_CODES_UNPARSEABLE");
    expect(reloaded.fetchedCount).toBe(0);
    const rows = await codesFor(order.id);
    expect(rows).toHaveLength(0);
  });

  it("recovers a block lost before the commit by reconciling at the start of the pass", async () => {
    // The Fix 2 trace: a previous pass drew a block of 10 and died before its
    // commit, so СУЗ's buffer is 10 codes ahead of `fetchedCount`. A
    // reconcile keyed on our own counter would only fire once the tail block
    // had closed the sub-order -- too late for `retryBlock` to serve it.
    const order = await insertOrder({
      quantity: 25,
      state: "fetching",
      omsOrderId: OMS_ORDER_ID,
      fetchedCount: 10,
    });
    await seedOmsToken();
    const heldBlock = randomUUID();
    const lostBlock = randomUUID();
    await db.insert(schema.chzKmCodes).values(
      Array.from({ length: 10 }, (_, i) => {
        const code = makeKm(`HELDB${i}`);
        const sealed = crypto.encryptWithAad(`${tenantId}/${order.id}/${i + 1}`, code);
        return {
          tenantId,
          orderId: order.id,
          seq: i + 1,
          encryptedCode: sealed.encryptedToken,
          codeNonce: sealed.tokenNonce,
          codeTag: sealed.tokenTag,
          codeHash: kmHash(parseKm(code)),
          blockId: heldBlock,
        };
      }),
    );

    const { client, calls } = fakeOmsClient({
      listBlocks: () => ({
        status: "ok",
        value: [
          { blockId: heldBlock, quantity: 10 },
          { blockId: lostBlock, quantity: 10 },
        ],
      }),
      retryBlock: (_auth, blockId) => ({
        status: "ok",
        value: {
          codes: Array.from({ length: 10 }, (_, i) => makeKm(`LOST${i}`)),
          blockId,
        },
      }),
      getCodes: (_auth, _orderId, _gtin14, quantity) => ({
        status: "ok",
        value: {
          codes: Array.from({ length: quantity }, (_, i) => makeKm(`TAIL${i}`)),
          blockId: randomUUID(),
        },
      }),
    });
    const runner = runnerWith(client);
    runner.blockSize = 10;

    const outcome = await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });

    expect(outcome.finished).toBe(true);
    const retryIndex = calls.findIndex((call) => call.op === "retryBlock");
    const firstCodesIndex = calls.findIndex((call) => call.op === "getCodes");
    expect(retryIndex).toBeGreaterThanOrEqual(0);
    expect(firstCodesIndex).toBeGreaterThan(retryIndex);
    expect(calls[retryIndex]).toMatchObject({ blockId: lostBlock });
    // The recovered block put the counter at 20, so the tail is one request
    // for the 5 codes actually left -- and no second reconcile, because
    // nothing has moved since.
    expect(calls.filter((call) => call.op === "getCodes").map((call) => call.quantity)).toEqual([
      5,
    ]);
    expect(calls.filter((call) => call.op === "listBlocks")).toHaveLength(1);

    const reloaded = await loadOrder(order.id);
    expect(reloaded.state).toBe("completed");
    expect(reloaded.fetchedCount).toBe(25);
    expect(await codesFor(order.id)).toHaveLength(25);
  });

  it("ends the fetch when a block stores nothing: an empty block", async () => {
    const order = await insertOrder({ quantity: 5, state: "fetching", omsOrderId: OMS_ORDER_ID });
    await seedOmsToken();
    const { client, calls } = fakeOmsClient({
      listBlocks: () => ({ status: "ok", value: [] }),
      getCodes: () => ({ status: "ok", value: { codes: [], blockId: randomUUID() } }),
    });
    const runner = runnerWith(client);

    const outcome = await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });

    expect(outcome.finished).toBe(true);
    // The call count is the assertion that matters: the loop used to re-issue
    // this request forever, since an empty block advances nothing.
    expect(calls.filter((call) => call.op === "getCodes")).toHaveLength(1);
    const reloaded = await loadOrder(order.id);
    expect(reloaded.state).toBe("failed");
    expect(reloaded.errorCode).toBe("CHZ_CODES_INCOMPLETE");
    expect(reloaded.fetchedCount).toBe(0);
    expect(await codesFor(order.id)).toHaveLength(0);
  });

  it("ends the fetch when a block stores nothing: a block already held", async () => {
    const order = await insertOrder({ quantity: 25, state: "fetching", omsOrderId: OMS_ORDER_ID });
    await seedOmsToken();
    const blockId = randomUUID();
    const block = { codes: Array.from({ length: 10 }, (_, i) => makeKm(`SAME${i}`)), blockId };
    let handed = false;
    const { client, calls } = fakeOmsClient({
      listBlocks: () => ({ status: "ok", value: handed ? [{ blockId, quantity: 10 }] : [] }),
      getCodes: () => {
        handed = true;
        return { status: "ok", value: block };
      },
    });
    const runner = runnerWith(client);
    runner.blockSize = 10;

    const outcome = await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });

    expect(outcome.finished).toBe(true);
    expect(calls.filter((call) => call.op === "getCodes")).toHaveLength(2);
    const reloaded = await loadOrder(order.id);
    expect(reloaded.state).toBe("failed");
    expect(reloaded.errorCode).toBe("CHZ_CODES_INCOMPLETE");
    expect(reloaded.fetchedCount).toBe(10);
    expect(await codesFor(order.id)).toHaveLength(10);
  });

  it("fails the order when a block carries more codes than the order has room for", async () => {
    const order = await insertOrder({ quantity: 5, state: "fetching", omsOrderId: OMS_ORDER_ID });
    await seedOmsToken();
    const { client } = fakeOmsClient({
      listBlocks: () => ({ status: "ok", value: [] }),
      getCodes: () => ({
        status: "ok",
        value: {
          codes: Array.from({ length: 6 }, (_, i) => makeKm(`OVER${i}`)),
          blockId: randomUUID(),
        },
      }),
    });
    const runner = runnerWith(client);

    // `chz_km_orders_counts_check` would otherwise raise a raw 23514 straight
    // through the runner, so the point of the assertion is that `run` returns
    // at all.
    await expect(
      runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 }),
    ).resolves.toMatchObject({ finished: true });

    const reloaded = await loadOrder(order.id);
    expect(reloaded.state).toBe("failed");
    expect(reloaded.errorCode).toBe("CHZ_CODES_OVERDELIVERED");
    expect(reloaded.fetchedCount).toBe(0);
    expect(await codesFor(order.id)).toHaveLength(0);
  });

  it("fails a signed order whose tenant has no СУЗ settings instead of polling the token", async () => {
    const orderId = randomUUID();
    const taskId = randomUUID();
    await db.insert(schema.chzSignerTasks).values({
      id: taskId,
      tenantId,
      type: "sign_detached",
      payload: { purpose: "oms_order", orderId, dataBase64: "eA==" },
    });
    await completeSignerTask(taskId);
    // Deliberately no `seedOmsToken()`: with no СУЗ channel the token reads
    // `settings_missing`, which no amount of waiting fixes -- and waiting
    // would hold the tenant's only signing slot until the deadline.
    const order = await insertOrder({
      id: orderId,
      state: "signing",
      signerTaskId: taskId,
      attempts: 1,
    });
    const { client, calls } = fakeOmsClient();
    const runner = runnerWith(client);

    const outcome = await runner.run(tenantId, order.id, { retryCount: 0, retryLimit: 5 });

    expect(outcome).toEqual({ finished: true, retryAfterSeconds: 0 });
    expect(calls).toHaveLength(0);
    const reloaded = await loadOrder(order.id);
    expect(reloaded.state).toBe("failed");
    expect(reloaded.errorCode).toBe("CHZ_OMS_SETTINGS_MISSING");
  });

  it("abandonAfterJobRetriesExhausted fails a live order and leaves a terminal one untouched", async () => {
    const live = await insertOrder({ state: "submitted", omsOrderId: OMS_ORDER_ID });
    const done = await insertOrder({ state: "failed", errorCode: "CHZ_ORDER_TIMED_OUT" });
    const runner = runnerWith(fakeOmsClient().client);

    await runner.abandonAfterJobRetriesExhausted(tenantId, live.id);
    await runner.abandonAfterJobRetriesExhausted(tenantId, done.id);

    const reloadedLive = await loadOrder(live.id);
    expect(reloadedLive.state).toBe("failed");
    expect(reloadedLive.errorCode).toBe("CHZ_JOB_RETRIES_EXHAUSTED");

    const reloadedDone = await loadOrder(done.id);
    expect(reloadedDone.state).toBe("failed");
    expect(reloadedDone.errorCode).toBe("CHZ_ORDER_TIMED_OUT");
    expect(reloadedDone.updatedAt).toEqual(done.updatedAt);
  });
});
