import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, eq, inArray } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { schema, type Db } from "@markiro/db";
import { kmHash, parseKm } from "@markiro/domain";

import { AppModule } from "../src/app.module";
import { DB } from "../src/auth/auth.module";
import { SecurityAuditService } from "../src/authorization/security-audit.service";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { PgBossService } from "../src/jobs/jobs.module";
import { ChzKmOrderRunnerService } from "../src/modules/chz-km-orders/chz-km-order-runner.service";
import { ChzKmOrdersService } from "../src/modules/chz-km-orders/chz-km-orders.service";
import { OmsClient } from "../src/modules/chz-km-orders/oms.client";
import { ChzCryptoService } from "../src/modules/signer-agents/chz-crypto.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL &&
  process.env.BETTER_AUTH_SECRET &&
  process.env.BETTER_AUTH_URL &&
  process.env.CHZ_TOKEN_ENCRYPTION_KEY,
);

const FIXTURE_GTIN = "04607034690014";
const OMS_ID = "cdf12109-10d3-11e6-8b6f-0050569977a1";
const OMS_CONNECTION = "b7f0c8b0-10d3-11e6-8b6f-0050569977a1";
const OMS_ORDER_ID = "3f2a9b10-10d3-11e6-8b6f-0050569977a1";
// `chz_product_groups` (migration 0099) seeds code 15 as alias "beer", and
// `CHZ_UNIT_TEMPLATE_ID_BY_GROUP.beer` (packages/domain/src/chz/km-orders.ts)
// is 18 -- both asserted against directly below.
const BEER_GROUP_CODE = 15;
const BEER_TEMPLATE_ID = 18;

type Agent = ReturnType<typeof request.agent>;

describe.skipIf(!ready)("chz-km-orders cabinet e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let crypto: ChzCryptoService;
  let runner: ChzKmOrderRunnerService;
  let orders: ChzKmOrdersService;
  let audit: SecurityAuditService;
  let jobs: PgBossService;
  const seededTenantIds: string[] = [];

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();

    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
    db = ref.get(DB);
    runner = ref.get(ChzKmOrderRunnerService);
    orders = ref.get(ChzKmOrdersService);
    audit = ref.get(SecurityAuditService);
    jobs = ref.get(PgBossService);
    crypto = new ChzCryptoService(env.CHZ_TOKEN_ENCRYPTION_KEY);
  });

  afterAll(async () => {
    if (seededTenantIds.length > 0) {
      // `chz_km_codes` and `chz_km_issues` both carry a composite FK to
      // `chz_km_orders` and neither cascades, so the orders row goes last.
      await db
        .delete(schema.chzKmCodes)
        .where(inArray(schema.chzKmCodes.tenantId, seededTenantIds));
      await db
        .delete(schema.chzKmIssues)
        .where(inArray(schema.chzKmIssues.tenantId, seededTenantIds));
      await db
        .delete(schema.chzKmOrders)
        .where(inArray(schema.chzKmOrders.tenantId, seededTenantIds));
    }
    await app?.close();
  });

  async function seedProduct(
    tenantId: string,
    overrides: Partial<typeof schema.products.$inferInsert> = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.products).values({
      id,
      tenantId,
      gtin14: FIXTURE_GTIN,
      name: "KM order fixture product",
      status: "active",
      ...overrides,
    });
    return id;
  }

  /** The sole member of a fixture tenant -- the `userId` every cabinet request below acts as. */
  async function memberUserId(tenantId: string): Promise<string> {
    const [membership] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    if (!membership) throw new Error("Expected the fixture tenant to have a member");
    return membership.userId;
  }

  /**
   * A `completed` order whose codes are already fetched and none issued --
   * the state Task 9's runner leaves behind, written directly because these
   * cases are about issuing, not about the СУЗ state machine.
   * `chz_km_orders_state_consistency_check` requires `oms_order_id` and
   * `fetched_count = quantity` for `completed`, and the codes are sealed with
   * the same AAD the runner uses (`tenantId/orderId/seq`) or they would not
   * decrypt on the way out.
   */
  async function seedCompletedOrder(
    tenantId: string,
    productId: string,
    codes: readonly string[],
  ): Promise<string> {
    const orderId = randomUUID();
    const blockId = randomUUID();
    await db.insert(schema.chzKmOrders).values({
      id: orderId,
      tenantId,
      productId,
      gtin14: FIXTURE_GTIN,
      productGroupAlias: "beer",
      productGroupCode: BEER_GROUP_CODE,
      templateId: BEER_TEMPLATE_ID,
      quantity: codes.length,
      state: "completed",
      requestBody: "{}",
      omsOrderId: OMS_ORDER_ID,
      fetchedCount: codes.length,
      createdByUserId: await memberUserId(tenantId),
      deadlineAt: new Date(Date.now() + 3_600_000),
    });
    await db.insert(schema.chzKmCodes).values(
      codes.map((code, index) => {
        const seq = index + 1;
        const sealed = crypto.encryptWithAad(`${tenantId}/${orderId}/${seq}`, code);
        return {
          tenantId,
          orderId,
          seq,
          encryptedCode: sealed.encryptedToken,
          codeNonce: sealed.tokenNonce,
          codeTag: sealed.tokenTag,
          codeHash: kmHash(parseKm(code)),
          blockId,
        };
      }),
    );
    return orderId;
  }

  /** Satisfies every pre-flight condition: settings, a paired agent, a usable token, and a supported product. */
  async function readyTenant(): Promise<{
    agent: Agent;
    tenantId: string;
    userId: string;
    productId: string;
  }> {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    seededTenantIds.push(tenantId);

    await db.insert(schema.integrationChannels).values({
      tenantId,
      type: "chestny_znak",
      settings: { environment: "sandbox", omsId: OMS_ID, omsConnection: OMS_CONNECTION },
    });

    const { body: issued } = await agent.post("/signer-agents/pairing-code").expect(201);
    await request(app!.getHttpServer())
      .post("/signer-agent/pair")
      .send({ pairingCode: issued.code, hostname: "KM-ORDER-PC", appVersion: "0.1.0" })
      .expect(201);

    const encrypted = crypto.encrypt(tenantId, "tok");
    await db.insert(schema.chzOmsTokens).values({
      tenantId,
      ...encrypted,
      sourceOmsConnection: OMS_CONNECTION,
      sourceTrueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
      obtainedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const productId = await seedProduct(tenantId, { chzProductGroupCode: BEER_GROUP_CODE });
    return { agent, tenantId, userId: await memberUserId(tenantId), productId };
  }

  it("refuses an order until СУЗ settings, an agent and a token exist", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    seededTenantIds.push(tenantId);
    const productId = await seedProduct(tenantId, { chzProductGroupCode: BEER_GROUP_CODE });

    const res = await agent.post("/chz-km-orders").send({ productId, quantity: 10 }).expect(422);
    expect(res.body).toMatchObject({
      code: "CHZ_KM_ORDER_PREFLIGHT_FAILED",
      blockedBy: expect.arrayContaining([
        "OMS_SETTINGS_MISSING",
        "AGENT_NOT_PAIRED",
        "OMS_TOKEN_UNAVAILABLE",
      ]),
    });
  });

  it("creates an order in state created with the exact request body, audits it and lists it", async () => {
    const { agent, tenantId, userId, productId } = await readyTenant();
    const mutations = vi.spyOn(audit, "credentialMutation");
    let created: Awaited<ReturnType<Agent["post"]>>;
    try {
      created = await agent
        .post("/chz-km-orders")
        .send({ productId, quantity: 10, contactPerson: "Ковалёва М. А." })
        .expect(201);
      // Ordering codes spends the tenant's СУЗ buffer: exact actor, tenant,
      // action, target and result, not a call count.
      expect(mutations).toHaveBeenCalledWith({
        tenantId,
        userId,
        action: "chz_km_order.create",
        resourceId: created.body.id,
        outcome: "succeeded",
      });
    } finally {
      mutations.mockRestore();
    }
    expect(created.body).toMatchObject({
      state: "created",
      quantity: 10,
      gtin14: FIXTURE_GTIN,
      templateId: BEER_TEMPLATE_ID,
      fetchedCount: 0,
      issuedCount: 0,
    });

    const [row] = await db
      .select()
      .from(schema.chzKmOrders)
      .where(eq(schema.chzKmOrders.id, created.body.id));
    expect(JSON.parse(row!.requestBody)).toMatchObject({
      productGroup: "beer",
      products: [
        {
          gtin: FIXTURE_GTIN,
          quantity: 10,
          templateId: BEER_TEMPLATE_ID,
          cisType: "UNIT",
          serialNumberType: "OPERATOR",
        },
      ],
      attributes: {
        releaseMethodType: "PRODUCTION",
        contactPerson: "Ковалёва М. А.",
        productionOrderId: created.body.id,
      },
    });

    const list = await agent.get("/chz-km-orders").expect(200);
    expect(list.body.orders.map((o: { id: string }) => o.id)).toContain(created.body.id);
  });

  it("denies another tenant's order", async () => {
    const { agent, productId } = await readyTenant();
    const created = await agent.post("/chz-km-orders").send({ productId, quantity: 1 }).expect(201);

    const other = request.agent(app!.getHttpServer());
    const otherTenantId = await signUpAndActivate(other);
    seededTenantIds.push(otherTenantId);

    await other.get(`/chz-km-orders/${created.body.id}`).expect(404);
    await other.post(`/chz-km-orders/${created.body.id}/retry`).expect(404);
  });

  it("refuses retry unless the order failed", async () => {
    const { agent, productId } = await readyTenant();
    const created = await agent.post("/chz-km-orders").send({ productId, quantity: 1 }).expect(201);

    await agent.post(`/chz-km-orders/${created.body.id}/retry`).expect(409);
  });

  it("puts a failed order back in flight and re-enqueues it on the durable queue", async () => {
    const { agent, tenantId, userId, productId } = await readyTenant();
    const created = await agent.post("/chz-km-orders").send({ productId, quantity: 5 }).expect(201);
    const orderId: string = created.body.id;

    // Drive the order to `failed` through the real runner rather than
    // writing `state = 'failed'` by hand: a block carrying more codes than
    // the order has room for is `CHZ_CODES_OVERDELIVERED` (staged the same
    // way in chz-km-order-runner.service.test.ts). The order is first placed
    // where the fetch loop starts; `chz_km_orders_state_consistency_check`
    // requires `oms_order_id` for that state.
    await db
      .update(schema.chzKmOrders)
      .set({ state: "fetching", omsOrderId: OMS_ORDER_ID })
      .where(and(eq(schema.chzKmOrders.tenantId, tenantId), eq(schema.chzKmOrders.id, orderId)));
    // Everything from here runs under a terminalising `finally`. While this
    // order is non-terminal it carries an `oms_order_id` and belongs to a
    // tenant whose СУЗ token decrypts, so a row left behind by a failing
    // assertion would be picked up by `reconcileUnfinishedChzKmOrders` the
    // next time any suite boots `AppModule` against a shared development
    // database -- and `CHZ_OMS_BASE_URLS` points at the real suzgrid host.
    try {
      const listBlocks = vi
        .spyOn(OmsClient.prototype, "listBlocks")
        .mockResolvedValue({ status: "ok", value: [] });
      const getCodes = vi.spyOn(OmsClient.prototype, "getCodes").mockResolvedValue({
        status: "ok",
        value: {
          codes: Array.from({ length: 6 }, (_, i) => `01${FIXTURE_GTIN}21OVER${i}`),
          blockId: randomUUID(),
        },
      });
      try {
        await runner.run(tenantId, orderId, { retryCount: 0, retryLimit: 5 });
      } finally {
        listBlocks.mockRestore();
        getCodes.mockRestore();
      }

      const failed = await agent.get(`/chz-km-orders/${orderId}`).expect(200);
      expect(failed.body).toMatchObject({ state: "failed", errorCode: "CHZ_CODES_OVERDELIVERED" });

      // The retry must both reopen the order and hand it back to the durable
      // queue -- until Task 10 that second half was a no-op placeholder, so a
      // retried order sat in `created` with nothing to advance it.
      const enqueue = vi.spyOn(jobs, "enqueueChzKmOrder").mockResolvedValue("job-id");
      const mutations = vi.spyOn(audit, "credentialMutation");
      try {
        const retried = await agent.post(`/chz-km-orders/${orderId}/retry`).expect(200);
        expect(retried.body).toMatchObject({
          id: orderId,
          state: "created",
          errorCode: null,
          omsOrderId: null,
          fetchedCount: 0,
          // The signing budget goes back with it, or the next pass would fail
          // the order again on an agent that is now healthy.
          attempts: 0,
        });
        expect(enqueue).toHaveBeenCalledWith(tenantId, orderId);
        // Nothing durable records who re-sent an order, so this is the whole
        // answer to that question: exact actor, tenant, action, target, result.
        expect(mutations).toHaveBeenCalledWith({
          tenantId,
          userId,
          action: "chz_km_order.retry",
          resourceId: orderId,
          outcome: "succeeded",
        });
      } finally {
        mutations.mockRestore();
        enqueue.mockRestore();
      }
    } finally {
      // `failed` is terminal, so the boot sweep skips it. `error_code` must
      // be non-null for that state (`chz_km_orders_state_consistency_check`).
      await db
        .update(schema.chzKmOrders)
        .set({ state: "failed", errorCode: "CHZ_CODES_OVERDELIVERED", omsOrderId: null })
        .where(and(eq(schema.chzKmOrders.tenantId, tenantId), eq(schema.chzKmOrders.id, orderId)));
    }
  });
  it("issues the lowest available codes contiguously and serves them as TXT", async () => {
    const { agent, tenantId, userId, productId } = await readyTenant();
    const codes = [
      "010460703469001421AAA0001\u001d93AAAA",
      "010460703469001421AAA0002\u001d93BBBB",
      "010460703469001421AAA0003\u001d93CCCC",
    ];
    const orderId = await seedCompletedOrder(tenantId, productId, codes);
    const mutations = vi.spyOn(audit, "credentialMutation");
    const reads = vi.spyOn(audit, "sensitiveRead");
    try {
      const issue = await agent
        .post(`/chz-km-orders/${orderId}/issues`)
        .send({ kind: "export", format: "txt", count: 2 })
        .expect(201);
      expect(issue.body).toMatchObject({
        kind: "export",
        format: "txt",
        fromSeq: 1,
        toSeq: 2,
        count: 2,
      });
      expect(mutations).toHaveBeenCalledWith({
        tenantId,
        userId,
        action: "chz_km_order.issue",
        resourceId: issue.body.id,
        outcome: "succeeded",
      });

      const file = await agent
        .get(`/chz-km-orders/${orderId}/issues/${issue.body.id}/file`)
        .expect(200);
      expect(file.headers["content-disposition"]).toBe(
        'attachment; filename="km-04607034690014-1-2.txt"',
      );
      expect(file.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(file.headers["cache-control"]).toBe("no-store");
      expect(file.text).toBe(`${codes[0]}\n${codes[1]}\n`);
      expect(reads).toHaveBeenCalledWith({
        tenantId,
        userId,
        action: "chz_km_order.codes_read",
        resourceId: issue.body.id,
      });

      const second = await agent
        .post(`/chz-km-orders/${orderId}/issues`)
        .send({ kind: "print", count: 1 })
        .expect(201);
      expect(second.body).toMatchObject({ fromSeq: 3, toSeq: 3 });
      const list = await agent
        .get(`/chz-km-orders/${orderId}/issues/${second.body.id}/codes`)
        .expect(200);
      expect(list.body).toEqual({ codes: [{ seq: 3, code: codes[2] }] });
      expect(list.headers["cache-control"]).toBe("no-store");

      const order = await agent.get(`/chz-km-orders/${orderId}`).expect(200);
      expect(order.body).toMatchObject({ issuedCount: 3, availableForIssue: 0 });

      // A print issue carries no format, so it has no file to download.
      const notExport = await agent
        .get(`/chz-km-orders/${orderId}/issues/${second.body.id}/file`)
        .expect(409);
      expect(notExport.body).toMatchObject({ code: "CHZ_KM_ISSUE_NOT_EXPORT" });
    } finally {
      mutations.mockRestore();
      reads.mockRestore();
    }
  });

  it("refuses more codes than the order has available", async () => {
    const { agent, tenantId, productId } = await readyTenant();
    const orderId = await seedCompletedOrder(tenantId, productId, [
      "010460703469001421AAA0009\u001d93AAAA",
    ]);
    const res = await agent
      .post(`/chz-km-orders/${orderId}/issues`)
      .send({ kind: "print", count: 2 })
      .expect(409);
    expect(res.body).toMatchObject({ code: "CHZ_KM_ISSUE_TOO_MANY", available: 1 });

    // The refusal must leave nothing behind: a half-written issue would
    // strand codes that no later issue can ever hand out.
    const [order] = await db
      .select({ issuedCount: schema.chzKmOrders.issuedCount })
      .from(schema.chzKmOrders)
      .where(and(eq(schema.chzKmOrders.tenantId, tenantId), eq(schema.chzKmOrders.id, orderId)));
    expect(order?.issuedCount).toBe(0);
    const issues = await db
      .select({ id: schema.chzKmIssues.id })
      .from(schema.chzKmIssues)
      .where(
        and(eq(schema.chzKmIssues.tenantId, tenantId), eq(schema.chzKmIssues.orderId, orderId)),
      );
    expect(issues).toEqual([]);
  });

  it("refuses an issue from an order that has not completed", async () => {
    const { agent, tenantId, productId } = await readyTenant();
    const created = await agent.post("/chz-km-orders").send({ productId, quantity: 3 }).expect(201);
    const orderId: string = created.body.id;
    try {
      const res = await agent
        .post(`/chz-km-orders/${orderId}/issues`)
        .send({ kind: "print", count: 1 })
        .expect(409);
      // State comes before availability: a `created` order also has zero
      // available codes, and answering CHZ_KM_ISSUE_TOO_MANY would tell the
      // office to order fewer rather than to wait.
      expect(res.body).toMatchObject({ code: "CHZ_KM_ORDER_NOT_COMPLETED" });
      expect(res.body.available).toBeUndefined();
    } finally {
      // Same reasoning as the retry case above: a non-terminal order left
      // behind by a failing assertion would be picked up by
      // `reconcileUnfinishedChzKmOrders` the next time any suite boots
      // `AppModule` against a shared development database.
      await db
        .update(schema.chzKmOrders)
        .set({ state: "failed", errorCode: "CHZ_TEST_FIXTURE" })
        .where(and(eq(schema.chzKmOrders.tenantId, tenantId), eq(schema.chzKmOrders.id, orderId)));
    }
  });

  it("never hands two concurrent issues the same code", async () => {
    const { agent, tenantId, productId } = await readyTenant();
    const codes = Array.from({ length: 6 }, (_, i) => `010460703469001421AAA00${i}Z\u001d93AAAA`);
    const orderId = await seedCompletedOrder(tenantId, productId, codes);

    // `Promise.all` on its own proves nothing about the server: had the three
    // requests been serialised before reaching it, the partition below would
    // hold trivially. `peak` records how many calls sat inside `issue` at the
    // same moment, so a serialised run fails here instead of passing under a
    // title it never earned.
    let inFlight = 0;
    let peak = 0;
    const realIssue = orders.issue.bind(orders);
    const spy = vi
      .spyOn(orders, "issue")
      .mockImplementation(async (issueTenantId, actorUserId, issueOrderId, input) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          return await realIssue(issueTenantId, actorUserId, issueOrderId, input);
        } finally {
          inFlight -= 1;
        }
      });
    let results: Awaited<ReturnType<Agent["post"]>>[];
    try {
      results = await Promise.all(
        [1, 2, 3].map(() =>
          agent.post(`/chz-km-orders/${orderId}/issues`).send({ kind: "print", count: 2 }),
        ),
      );
    } finally {
      spy.mockRestore();
    }
    expect(peak).toBeGreaterThan(1);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    const ranges = results
      .map((r): [number, number] => [r.body.fromSeq, r.body.toSeq])
      .sort((a, b) => a[0] - b[0]);
    expect(ranges).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);

    // Six codes, three issues, no overlap and no gap: every code is claimed
    // exactly once, which is the property those ranges stand for.
    const marked = await db
      .select({ seq: schema.chzKmCodes.seq, issueId: schema.chzKmCodes.issueId })
      .from(schema.chzKmCodes)
      .where(and(eq(schema.chzKmCodes.tenantId, tenantId), eq(schema.chzKmCodes.orderId, orderId)));
    expect(marked).toHaveLength(6);
    expect(marked.every((row) => row.issueId !== null)).toBe(true);
    expect(new Set(marked.map((row) => row.issueId)).size).toBe(3);
  });

  it("keeps another tenant out of the file and codes endpoints", async () => {
    const { agent, tenantId, productId } = await readyTenant();
    const orderId = await seedCompletedOrder(tenantId, productId, [
      "010460703469001421AAA0008\u001d93AAAA",
    ]);
    const issue = await agent
      .post(`/chz-km-orders/${orderId}/issues`)
      .send({ kind: "export", format: "csv", count: 1 })
      .expect(201);
    // The owning tenant first, so the CSV branch of `issueFile` -- its own
    // content type, its own extension -- is driven through the route and not
    // only through the domain serializer's unit test.
    const own = await agent
      .get(`/chz-km-orders/${orderId}/issues/${issue.body.id}/file`)
      .expect(200);
    expect(own.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(own.headers["content-disposition"]).toBe(
      'attachment; filename="km-04607034690014-1-1.csv"',
    );

    const other = request.agent(app!.getHttpServer());
    seededTenantIds.push(await signUpAndActivate(other));
    await other.get(`/chz-km-orders/${orderId}/issues/${issue.body.id}/file`).expect(404);
    await other.get(`/chz-km-orders/${orderId}/issues/${issue.body.id}/codes`).expect(404);
  });
});
