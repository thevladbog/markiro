import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorizationService } from "../src/authorization/authorization.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { NationalCatalogImportService } from "../src/modules/national-catalog/national-catalog-import.service";
import { NationalCatalogImportRepository } from "../src/modules/national-catalog/national-catalog-import.repository";
import { NationalCatalogRequestCoordinator } from "../src/modules/national-catalog/national-catalog-request-coordinator";
import type { NationalCatalogClient } from "../src/modules/national-catalog/national-catalog.client";
import type { ChzTokenService } from "../src/modules/chz-exports/chz-token.service";
import type {
  NationalCatalogListResult,
  NationalCatalogProduct,
  NationalCatalogResult,
  NationalCatalogProductsResponse,
} from "../src/modules/national-catalog/national-catalog.types";
import { createManagedSubscription, createOrganization } from "./support/subscription-fixtures";
const sessions = schema.nationalCatalogImportSessions;
const items = schema.nationalCatalogImportItems;
const GTIN = "04601234567893";
function gtin(index: number): string {
  const body = String(index).padStart(13, "0");
  const sum = [...body].reduce(
    (total, digit, i) => total + Number(digit) * (i % 2 === 0 ? 3 : 1),
    0,
  );
  return body + ((10 - (sum % 10)) % 10);
}
const query = { cursor: null, search: "", statuses: [], includeArchived: true, limit: 100 };
function page(ids: string[], nextOffset: number | null = null): NationalCatalogListResult {
  return {
    status: "ok",
    value: {
      rows: ids.map((cardId) => ({
        cardId,
        gtins: [GTIN],
        name: `Card ${cardId}`,
        brand: null,
        status: "published",
        detailedStatuses: ["published"],
        raw: {},
      })),
      nextOffset,
    },
    contentHash: ids.join(":"),
    etag: null,
    usage: { total: null, method: null },
  };
}
function product(id: number, gtins = [GTIN]): NationalCatalogProduct {
  return {
    id,
    name: `Card ${id}`,
    status: "published",
    detailedStatuses: ["published"],
    identifiers: gtins.map((value) => ({ value, type: "gtin", multiplier: null, level: null })),
    categories: [],
    attributes: [],
    images: [],
    imageIssues: [],
    raw: {},
  };
}
function feed(
  products: NationalCatalogProduct[],
): NationalCatalogResult<NationalCatalogProductsResponse> {
  return {
    status: "ok",
    value: { products },
    contentHash: "a".repeat(64),
    etag: null,
    usage: { total: null, method: null },
  };
}
describe.skipIf(!process.env.DATABASE_URL)("durable National Catalog sessions", () => {
  const dbName = `markiro_nc_session_${randomUUID().replaceAll("-", "_")}`;
  const maintenance = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  url.pathname = `/${dbName}`;
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let repository: NationalCatalogImportRepository;
  let service: NationalCatalogImportService;
  let actor: { tenantId: string; userId: string };
  const list = vi.fn<NationalCatalogClient["listOwnProducts"]>();
  const detail = vi.fn<NationalCatalogClient["getFeedProducts"]>();
  const client = { listOwnProducts: list, getFeedProducts: detail };
  const beforeToken = vi.fn<() => Promise<void>>();
  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${dbName}"`);
    connection = createDb(url.toString());
    db = connection.db;
    await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
  }, 120_000);
  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await maintenance.pool.end();
  });
  function build(flags = { ownCatalog: true, gtinLookup: true }) {
    repository = new NationalCatalogImportRepository(db);
    const tokens = {
      getCatalogToken: async () => {
        await beforeToken();
        return {
          status: "ok",
          auth: { baseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api", token: "test" },
          obtainedAt: new Date(),
        };
      },
      invalidateAndRequestRefresh: async () => {},
    } as unknown as ChzTokenService;
    const coordinator = new NationalCatalogRequestCoordinator(
      db,
      tokens,
      "https://api.nk.sandbox.crptech.ru",
    );
    return new NationalCatalogImportService(
      repository,
      client,
      coordinator,
      new AuthorizationService(db),
      new EntitlementsService(db, "managed_only"),
      flags,
    );
  }
  beforeEach(async () => {
    actor = { tenantId: await createOrganization(db), userId: randomUUID() };
    await db.insert(schema.user).values({
      id: actor.userId,
      name: "Session test",
      email: `${actor.userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.member).values({
      id: randomUUID(),
      userId: actor.userId,
      organizationId: actor.tenantId,
      role: "owner",
      createdAt: new Date(),
    });
    await db.insert(schema.integrationChannels).values({
      tenantId: actor.tenantId,
      type: "chestny_znak",
      settings: { environment: "sandbox" },
    });
    beforeToken.mockReset().mockResolvedValue();
    list.mockReset().mockResolvedValue(page([]));
    detail.mockReset().mockResolvedValue(feed([]));
    service = build();
  });
  async function row(id: string) {
    const [value] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenantId, actor.tenantId), eq(sessions.id, id)));
    if (!value) throw new Error("missing fixture");
    return value;
  }
  async function due(id: string) {
    const value = await row(id);
    await db
      .update(sessions)
      .set({ checkpoint: { ...(value.checkpoint as object), nextRetryAt: null } })
      .where(eq(sessions.id, id));
    await db
      .update(schema.nationalCatalogRequestLeases)
      .set({ nextAllowedAt: new Date(0), leaseUntil: new Date(0) })
      .where(eq(schema.nationalCatalogRequestLeases.tenantId, actor.tenantId));
  }
  it("persists queue intent and completes only after primary and frozen catch-up", async () => {
    const s = await service.start(actor, { mode: "own_catalog" });
    expect(s).toMatchObject({ state: "queued", complete: false, loaded: 0 });
    expect((await row(s.id)).checkpoint).toMatchObject({ enqueuePending: true, attempts: 0 });
    list.mockResolvedValueOnce(page(["1"]));
    await service.resume(actor.tenantId, s.id);
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({ complete: false, loaded: 1 });
    expect(list.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
    expect(list.mock.calls[0]?.[2]?.onResponse).toBeTypeOf("function");
    await service.resume(actor.tenantId, s.id);
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({
      state: "ready",
      complete: true,
      loaded: 1,
    });
    const request = list.mock.calls[1]?.[1];
    expect(request?.updatedFrom).toBe(
      new Date(Math.floor(Date.parse(s.startedAt) / 1000) * 1000 - 1000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " "),
    );
  });
  it("replays the same committed step without advancing the next page", async () => {
    const s = await service.start(actor, { mode: "own_catalog" });
    const checkpoint = (await row(s.id)).checkpoint as { stepId: string };
    list.mockResolvedValueOnce(page(["1"], 1000));
    await service.resume(actor.tenantId, s.id, checkpoint.stepId);
    const committed = await row(s.id);
    await service.resume(actor.tenantId, s.id, checkpoint.stepId);
    expect(await row(s.id)).toEqual(committed);
    expect(list).toHaveBeenCalledTimes(1);
  });
  it("preserves selection between pages and rejects stale revisions", async () => {
    const s = await service.start(actor, { mode: "own_catalog" });
    list.mockResolvedValueOnce(page(["1"], 1000));
    await service.resume(actor.tenantId, s.id);
    const first = (await service.items(actor.tenantId, s.id, query)).items[0]!;
    const current = await service.read(actor.tenantId, s.id);
    await service.select(actor, s.id, { expectedRevision: current.revision, itemIds: [first.id] });
    list.mockResolvedValueOnce(page(["1", "2"]));
    await service.resume(actor.tenantId, s.id);
    expect(
      (await service.items(actor.tenantId, s.id, query)).items.find((x) => x.id === first.id)
        ?.selected,
    ).toBe(true);
    await expect(
      service.select(actor, s.id, { expectedRevision: current.revision, itemIds: [] }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("makes invalid identifiers visible and requires one explicit card for ambiguous GTIN", async () => {
    detail.mockResolvedValue(feed([product(1, [GTIN, "bad"]), product(2)]));
    const s = await service.start(actor, { mode: "gtins", text: `${GTIN} invalid` });
    await service.resume(actor.tenantId, s.id);
    const found = (await service.items(actor.tenantId, s.id, query)).items;
    expect(found.filter((x) => x.match === "invalid")).toHaveLength(2);
    const candidates = found.filter((x) => x.gtin14 === GTIN);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((x) => x.match === "ambiguous" && x.selectable)).toBe(true);
    const current = await service.read(actor.tenantId, s.id);
    await expect(
      service.select(actor, s.id, {
        expectedRevision: current.revision,
        itemIds: candidates.map((x) => x.id),
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({
      selected: 0,
      revision: current.revision,
    });
    expect(
      await service.select(actor, s.id, {
        expectedRevision: current.revision,
        itemIds: [candidates[1]!.id],
      }),
    ).toMatchObject({ selected: 1 });
  });
  it.each(["forbidden", "not_found", "empty"] as const)(
    "distinguishes GTIN %s without public fallback",
    async (kind) => {
      detail.mockResolvedValue(
        kind === "empty"
          ? feed([])
          : kind === "forbidden"
            ? { status: kind, message: "denied" }
            : { status: kind },
      );
      const s = await service.start(actor, { mode: "gtins", text: GTIN });
      await service.resume(actor.tenantId, s.id);
      expect((await service.items(actor.tenantId, s.id, query)).items[0]).toMatchObject({
        selectable: false,
        reason: kind === "empty" ? "empty_result" : kind,
      });
    },
  );
  it("rejects other-tenant item atomically and never exposes other-tenant session", async () => {
    const s = await service.start(actor, { mode: "gtins", text: "invalid" });
    const other = await createOrganization(db);
    await expect(service.read(other, s.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      service.select(actor, s.id, { expectedRevision: s.revision, itemIds: [randomUUID()] }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({
      selected: 0,
      revision: s.revision,
    });
  });
  it("does not issue HTTP after cancellation, expiry, disabled flags or actor revocation", async () => {
    const s = await service.start(actor, { mode: "own_catalog" });
    await service.cancel(actor, s.id);
    await service.resume(actor.tenantId, s.id);
    expect(list).not.toHaveBeenCalled();
    const exp = await service.start(actor, { mode: "own_catalog" });
    await db
      .update(sessions)
      .set({ startedAt: new Date(Date.now() - 90_000_000), expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, exp.id));
    await service.resume(actor.tenantId, exp.id);
    expect(await service.read(actor.tenantId, exp.id)).toMatchObject({ state: "expired" });
    await expect(
      build({ ownCatalog: false, gtinLookup: false }).start(actor, { mode: "own_catalog" }),
    ).rejects.toMatchObject({ status: 403 });
    const revoked = await service.start(actor, { mode: "own_catalog" });
    await db.delete(schema.member).where(eq(schema.member.userId, actor.userId));
    await service.resume(actor.tenantId, revoked.id);
    expect(await service.read(actor.tenantId, revoked.id)).toMatchObject({
      state: "blocked",
      reason: "permission_denied",
    });
    expect(list).not.toHaveBeenCalled();
  });
  it("persists retry attempts across reconstructed services and exhausts exactly four", async () => {
    list.mockResolvedValue({ status: "unavailable" });
    const s = await service.start(actor, { mode: "own_catalog" });
    for (let n = 1; n <= 4; n++) {
      await due(s.id);
      await build().resume(actor.tenantId, s.id);
      expect((await row(s.id)).checkpoint).toMatchObject({ attempts: n });
    }
    await due(s.id);
    await build().resume(actor.tenantId, s.id);
    expect(list).toHaveBeenCalledTimes(4);
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({
      state: "partial",
      complete: false,
    });
  });
  it("does not allocate attempts on quota deferral", async () => {
    const s = await service.start(actor, { mode: "own_catalog" });
    await db.insert(schema.nationalCatalogRequestLeases).values({
      tenantId: actor.tenantId,
      owner: randomUUID(),
      leaseUntil: new Date(0),
      nextAllowedAt: new Date(Date.now() + 60_000),
    });
    await service.resume(actor.tenantId, s.id);
    expect((await row(s.id)).checkpoint).toMatchObject({
      attempts: 0,
      state: "deferred",
      enqueuePending: true,
    });
    expect(list).not.toHaveBeenCalled();
  });
  it("splits413 with overlap and marks a one-second gap incomplete", async () => {
    const s = await service.start(actor, { mode: "own_catalog" });
    list.mockResolvedValueOnce({ status: "selection_too_large" });
    await service.resume(actor.tenantId, s.id);
    expect((await row(s.id)).checkpoint).toMatchObject({ attempts: 0 });
    const value = await row(s.id);
    await db
      .update(sessions)
      .set({
        checkpoint: {
          ...(value.checkpoint as object),
          work: [{ kind: "list", from: 0, to: 1000, offset: 0, hashes: [] }],
        },
      })
      .where(eq(sessions.id, s.id));
    list.mockResolvedValueOnce({ status: "selection_too_large" });
    await service.resume(actor.tenantId, s.id);
    await service.resume(actor.tenantId, s.id);
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({
      state: "partial",
      complete: false,
      reason: "unsplittable_interval",
    });
  });
  it("rejects a repeated page before cursor advance", async () => {
    const s = await service.start(actor, { mode: "own_catalog" });
    list.mockResolvedValue(page(["1"], 1000));
    await service.resume(actor.tenantId, s.id);
    await service.resume(actor.tenantId, s.id);
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({
      loaded: 1,
      state: "partial",
      reason: "repeated_page",
      complete: false,
    });
  });
  it("rolls back HTTP result and cursor on crash before commit, retaining admitted attempts", async () => {
    const s = await service.start(actor, { mode: "own_catalog" });
    list.mockResolvedValueOnce(page(["1"], 1000));
    const upsert = repository.upsert.bind(repository);
    vi.spyOn(repository, "upsert").mockImplementationOnce(async (...args) => {
      await upsert(...args);
      throw new Error("simulated crash");
    });
    await expect(service.resume(actor.tenantId, s.id)).rejects.toThrow("simulated crash");
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({ loaded: 0 });
    expect((await row(s.id)).checkpoint).toMatchObject({
      attempts: 1,
      state: "started",
      enqueuePending: true,
    });
    await build().resume(actor.tenantId, s.id);
    expect(list).toHaveBeenCalledTimes(1);
    await due(s.id);
    list.mockResolvedValueOnce(page(["1"], 1000));
    await build().resume(actor.tenantId, s.id);
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({ loaded: 1 });
    expect(list).toHaveBeenCalledTimes(2);
  });
  it("clears selected rows atomically when catch-up archives their source", async () => {
    const s = await service.start(actor, { mode: "own_catalog" });
    list.mockResolvedValueOnce(page(["1"]));
    await service.resume(actor.tenantId, s.id);
    const item = (await service.items(actor.tenantId, s.id, query)).items[0]!;
    const current = await service.read(actor.tenantId, s.id);
    await service.select(actor, s.id, { expectedRevision: current.revision, itemIds: [item.id] });
    expect(await build().read(actor.tenantId, s.id)).toMatchObject({
      selected: 1,
      selectedItemIds: [item.id],
    });
    const archived = page(["1"]);
    if (archived.status !== "ok") throw new Error();
    archived.value.rows[0]!.detailedStatuses = ["archived"];
    list.mockResolvedValueOnce(archived);
    await service.resume(actor.tenantId, s.id);
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({
      selected: 0,
      selectedItemIds: [],
      loaded: 1,
    });
    expect((await service.items(actor.tenantId, s.id, query)).items[0]).toMatchObject({
      selectable: false,
      selected: false,
      reason: "archived_card",
    });
    expect(
      (await service.items(actor.tenantId, s.id, { ...query, includeArchived: false })).items,
    ).toHaveLength(0);
  });
  it("rejects101 choices atomically and paginates with an exact stable cursor", async () => {
    const s = await service.start(actor, { mode: "own_catalog" });
    const response = page(Array.from({ length: 101 }, (_, i) => String(i + 1)));
    if (response.status !== "ok") throw new Error();
    response.value.rows.forEach((r, i) => (r.gtins = [gtin(i + 1)]));
    list.mockResolvedValueOnce(response);
    await service.resume(actor.tenantId, s.id);
    const first = await service.items(actor.tenantId, s.id, query);
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.items(actor.tenantId, s.id, {
      ...query,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(1);
    expect(first.items.map((i) => i.id)).not.toContain(second.items[0]!.id);
    const current = await service.read(actor.tenantId, s.id);
    await expect(
      service.select(actor, s.id, {
        expectedRevision: current.revision,
        itemIds: [...first.items, ...second.items].map((i) => i.id),
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({
      revision: current.revision,
      selected: 0,
    });
    await expect(
      service.items(actor.tenantId, s.id, { ...query, limit: 101 }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      service.items(actor.tenantId, s.id, { ...query, search: "x".repeat(501) }),
    ).rejects.toMatchObject({ status: 422 });
  });
  it("stops before the100001st row without losing the prior100000", async () => {
    const s = await service.start(actor, { mode: "own_catalog" });
    await db.execute(
      sql`insert into national_catalog_import_items(tenant_id,session_id,input,match) select ${actor.tenantId},${s.id},'invalid-'||i,'invalid' from generate_series(1,100000) as i`,
    );
    await db.update(sessions).set({ loaded: 100000 }).where(eq(sessions.id, s.id));
    list.mockResolvedValueOnce(page(["1"]));
    await service.resume(actor.tenantId, s.id);
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({
      loaded: 100000,
      complete: false,
      state: "partial",
      reason: "session_row_limit",
    });
    const saved = await row(s.id);
    await service.resume(actor.tenantId, s.id);
    expect(await row(s.id)).toEqual(saved);
  });
  it("keeps successful GTIN chunks and explicitly retries only a failed chunk", async () => {
    const gtins = Array.from({ length: 26 }, (_, i) => gtin(i + 1));
    const s = await service.start(actor, { mode: "gtins", text: gtins.join(";") });
    detail
      .mockResolvedValueOnce({ status: "forbidden", message: "denied" })
      .mockResolvedValueOnce(feed([product(26, [gtins[25]!])]));
    await service.resume(actor.tenantId, s.id);
    await service.resume(actor.tenantId, s.id);
    expect(detail.mock.calls.map((call) => call[1].length)).toEqual([25, 1]);
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({
      loaded: 26,
      state: "partial",
      complete: false,
    });
    const retried = await service.retry(actor, s.id);
    expect(await service.retry(actor, s.id)).toEqual(retried);
    detail.mockResolvedValueOnce(feed(gtins.slice(0, 25).map((g, i) => product(i + 1, [g]))));
    await service.resume(actor.tenantId, s.id);
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({
      loaded: 26,
      state: "ready",
      complete: true,
    });
    expect(
      (await service.items(actor.tenantId, s.id, query)).items.every((i) => i.selectable),
    ).toBe(true);
  });
  it("does not apply a response after actor revocation, environment switch, or cancellation", async () => {
    for (const change of ["role", "environment", "cancel"] as const) {
      const s = await service.start(actor, { mode: "own_catalog" });
      list.mockImplementationOnce(async () => {
        if (change === "role")
          await db
            .update(schema.member)
            .set({ role: "reader" })
            .where(eq(schema.member.userId, actor.userId));
        if (change === "environment")
          await db
            .update(schema.integrationChannels)
            .set({ settings: { environment: "production" } })
            .where(eq(schema.integrationChannels.tenantId, actor.tenantId));
        if (change === "cancel") await service.cancel(actor, s.id);
        return page(["1"]);
      });
      await service.resume(actor.tenantId, s.id);
      expect(await service.read(actor.tenantId, s.id)).toMatchObject({
        loaded: 0,
        state: change === "cancel" ? "cancelled" : "blocked",
      });
      await db
        .update(schema.member)
        .set({ role: "owner" })
        .where(eq(schema.member.userId, actor.userId));
      await db
        .update(schema.integrationChannels)
        .set({ settings: { environment: "sandbox" } })
        .where(eq(schema.integrationChannels.tenantId, actor.tenantId));
    }
  });
  it("keeps archived local matches nonselectable and matches only this tenant", async () => {
    const other = await createOrganization(db);
    await db
      .insert(schema.products)
      .values({ tenantId: other, gtin14: GTIN, name: "Other tenant" });
    const local = randomUUID();
    await db.insert(schema.products).values({
      id: local,
      tenantId: actor.tenantId,
      gtin14: GTIN,
      name: "Archived local",
      archived: true,
    });
    detail.mockResolvedValueOnce(feed([product(1)]));
    const s = await service.start(actor, { mode: "gtins", text: GTIN });
    await service.resume(actor.tenantId, s.id);
    expect((await service.items(actor.tenantId, s.id, query)).items[0]).toMatchObject({
      productId: local,
      match: "archived_local",
      selectable: false,
      reason: "archived_local",
    });
  });

  it("durably blocks revocation during coordinator admission before HTTP", async () => {
    const s = await service.start(actor, { mode: "own_catalog" });
    beforeToken.mockImplementationOnce(async () => {
      await db.delete(schema.member).where(eq(schema.member.userId, actor.userId));
    });
    await service.resume(actor.tenantId, s.id);
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({
      state: "blocked",
      reason: "permission_denied",
    });
    expect((await row(s.id)).checkpoint).toMatchObject({ attempts: 0, enqueuePending: false });
    expect(list).not.toHaveBeenCalled();
  });
  it("does not overwrite an admitted marker when another delivery is lease deferred", async () => {
    const s = await service.start(actor, { mode: "own_catalog" });
    let release: () => void = () => {};
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    list.mockImplementationOnce(async () => {
      entered();
      await pause;
      return page(["1"]);
    });
    const first = service.resume(actor.tenantId, s.id);
    await started;
    const marker = await row(s.id);
    await build().resume(actor.tenantId, s.id);
    expect(await row(s.id)).toEqual(marker);
    release();
    await first;
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({ loaded: 1 });
  });
  it("blocks expired subscription with a safe machine reason and can manually recover", async () => {
    const sub = await createManagedSubscription(db, { tenantId: actor.tenantId });
    const s = await service.start(actor, { mode: "own_catalog" });
    list.mockImplementationOnce(async () => {
      await db
        .update(schema.tenantSubscriptions)
        .set({ endsAt: new Date(Date.now() - 1000) })
        .where(eq(schema.tenantSubscriptions.id, sub.subscriptionId));
      return page(["1"]);
    });
    await service.resume(actor.tenantId, s.id);
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({
      state: "blocked",
      reason: "subscription_read_only",
      loaded: 0,
    });
    await db
      .update(schema.tenantSubscriptions)
      .set({ endsAt: new Date(Date.now() + 3600000) })
      .where(eq(schema.tenantSubscriptions.id, sub.subscriptionId));
    const queued = await service.retry(actor, s.id);
    expect(queued.state).toBe("queued");
    list.mockResolvedValueOnce(page(["1"]));
    await service.resume(actor.tenantId, s.id);
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({ loaded: 1 });
  });
  it("supports status and literal search filters, rejecting foreign cursor anchors", async () => {
    const s = await service.start(actor, { mode: "own_catalog" });
    list.mockResolvedValueOnce(page(["1", "2"]));
    await service.resume(actor.tenantId, s.id);
    expect(
      (
        await service.items(actor.tenantId, s.id, {
          ...query,
          statuses: ["published"],
          search: "Card 2",
        })
      ).items,
    ).toHaveLength(1);
    expect(
      (await service.items(actor.tenantId, s.id, { ...query, search: "%" })).items,
    ).toHaveLength(0);
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: new Date().toISOString(), id: randomUUID() }),
    ).toString("base64url");
    await expect(service.items(actor.tenantId, s.id, { ...query, cursor })).rejects.toMatchObject({
      status: 422,
    });
  });
  it("rejects an invalid cursor and starts catch-up from offset zero", async () => {
    const s = await service.start(actor, { mode: "own_catalog" });
    list.mockResolvedValueOnce(page(["1"], 10001));
    await service.resume(actor.tenantId, s.id);
    expect(await service.read(actor.tenantId, s.id)).toMatchObject({
      state: "partial",
      loaded: 0,
      reason: "invalid_provider_cursor",
    });
    await service.resume(actor.tenantId, s.id);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[1].offset).toBe(0);
  });
  it("continues sibling intervals after an unsplittable gap without claiming completeness", async () => {
    const session = await service.start(actor, { mode: "own_catalog" });
    const saved = await row(session.id);
    await db
      .update(sessions)
      .set({
        checkpoint: {
          ...(saved.checkpoint as object),
          work: [
            { kind: "list", from: 0, to: 1000, offset: 0, hashes: [] },
            { kind: "list", from: 1000, to: 2000, offset: 0, hashes: [] },
          ],
        },
      })
      .where(eq(sessions.id, session.id));
    list
      .mockResolvedValueOnce({ status: "selection_too_large" })
      .mockResolvedValueOnce(page(["2"]))
      .mockResolvedValueOnce(page([]));
    await service.resume(actor.tenantId, session.id);
    await service.resume(actor.tenantId, session.id);
    await service.resume(actor.tenantId, session.id);
    expect(await service.read(actor.tenantId, session.id)).toMatchObject({
      state: "partial",
      reason: "unsplittable_interval",
      loaded: 1,
      complete: false,
    });
    expect(list.mock.calls[1]?.[1]).toMatchObject({
      updatedFrom: "1970-01-01 00:00:01",
      updatedTo: "1970-01-01 00:00:02",
    });
  });
  it("records the actual manual retry actor and revalidates that user", async () => {
    const session = await service.start(actor, { mode: "own_catalog" });
    await db.delete(schema.member).where(eq(schema.member.userId, actor.userId));
    await service.resume(actor.tenantId, session.id);
    const replacement = { tenantId: actor.tenantId, userId: randomUUID() };
    await db.insert(schema.user).values({
      id: replacement.userId,
      name: "Retry actor",
      email: `${replacement.userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.member).values({
      id: randomUUID(),
      userId: replacement.userId,
      organizationId: actor.tenantId,
      role: "manager",
      createdAt: new Date(),
    });
    await service.retry(replacement, session.id);
    expect((await row(session.id)).actorId).toBe(replacement.userId);
    await db.delete(schema.member).where(eq(schema.member.userId, replacement.userId));
    await db.insert(schema.member).values({
      id: randomUUID(),
      userId: actor.userId,
      organizationId: actor.tenantId,
      role: "owner",
      createdAt: new Date(),
    });
    await service.resume(actor.tenantId, session.id);
    expect(await service.read(actor.tenantId, session.id)).toMatchObject({
      state: "blocked",
      reason: "permission_denied",
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("bounds the final provider request within a10000-row interval", async () => {
    const session = await service.start(actor, { mode: "own_catalog" });
    const saved = await row(session.id);
    await db
      .update(sessions)
      .set({
        checkpoint: {
          ...(saved.checkpoint as object),
          work: [{ kind: "list", from: 0, to: 2000, offset: 9000, hashes: [] }],
        },
      })
      .where(eq(sessions.id, session.id));
    list.mockResolvedValueOnce(page(["1"], 9500)).mockResolvedValueOnce(page(["2"]));
    await service.resume(actor.tenantId, session.id);
    await service.resume(actor.tenantId, session.id);
    expect(list.mock.calls[1]?.[1]).toMatchObject({ offset: 9500, limit: 500 });
    expect(await service.read(actor.tenantId, session.id)).toMatchObject({
      loaded: 2,
      complete: false,
    });
  });

  it("persists the maximum100000 invalid inputs without a provider call", async () => {
    const text = Array.from({ length: 100000 }, (_, i) => `bad${String(i).padStart(5, "0")}`).join(
      ";",
    );
    const session = await service.start(actor, { mode: "gtins", text });
    expect(session).toMatchObject({ loaded: 100000, selected: 0, complete: true, state: "ready" });
    expect((await service.items(actor.tenantId, session.id, query)).items).toHaveLength(100);
    expect(detail).not.toHaveBeenCalled();
  }, 30000);
  it("rejects a real item belonging to another tenant without changing selection", async () => {
    const own = await service.start(actor, { mode: "gtins", text: "invalid" });
    const other = await createOrganization(db);
    const foreign = randomUUID();
    const foreignSession = randomUUID();
    await db.insert(sessions).values({
      id: foreignSession,
      tenantId: other,
      actorId: actor.userId,
      environment: "sandbox",
      mode: "gtins",
      throughAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
    });
    await db.insert(items).values({
      id: foreign,
      tenantId: other,
      sessionId: foreignSession,
      gtin14: GTIN,
      cardId: "1",
      match: "new",
      selectable: true,
    });
    await expect(
      service.select(actor, own.id, { expectedRevision: own.revision, itemIds: [foreign] }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await service.read(actor.tenantId, own.id)).toMatchObject({
      selected: 0,
      revision: own.revision,
    });
  });
  it("preserves a failed GTIN row as the first recovered card so existing cursors stay usable", async () => {
    const session = await service.start(actor, { mode: "gtins", text: GTIN });
    detail.mockResolvedValueOnce({ status: "forbidden", message: "denied" });
    await service.resume(actor.tenantId, session.id);
    const before = (await service.items(actor.tenantId, session.id, query)).items[0]!;
    await service.retry(actor, session.id);
    detail.mockResolvedValueOnce(feed([product(1), product(2)]));
    await service.resume(actor.tenantId, session.id);
    const after = (await service.items(actor.tenantId, session.id, query)).items;
    expect(after.map((item) => item.id)).toContain(before.id);
    expect(after).toHaveLength(2);
  });
  it("offers consumers one locked-session access check for tenant, permission and expiry", async () => {
    const session = await service.start(actor, { mode: "own_catalog" });
    const check = (currentActor = actor) =>
      repository.transaction(async (tx) => {
        const locked = await repository.lock(tx, actor.tenantId, session.id);
        await service.assertSessionAccess(tx, currentActor, locked);
      });
    await expect(check()).resolves.toBeUndefined();
    await expect(check({ ...actor, tenantId: randomUUID() })).rejects.toMatchObject({
      status: 403,
    });
    await db.delete(schema.member).where(eq(schema.member.userId, actor.userId));
    await expect(check()).rejects.toMatchObject({ status: 403 });
    await db.insert(schema.member).values({
      id: randomUUID(),
      userId: actor.userId,
      organizationId: actor.tenantId,
      role: "owner",
      createdAt: new Date(),
    });
    await service.cancel(actor, session.id);
    await expect(check()).rejects.toMatchObject({ status: 410 });
  });
  it("does not call a card linked when its bound GTIN differs from the current product", async () => {
    const productId = randomUUID();
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId: actor.tenantId, gtin14: GTIN, name: "Changed GTIN" });
    await db.insert(schema.nationalCatalogProductLinks).values({
      tenantId: actor.tenantId,
      productId,
      environment: "sandbox",
      cardId: "1",
      boundGtin14: gtin(42),
      confirmedBy: actor.userId,
    });
    const session = await service.start(actor, { mode: "gtins", text: GTIN });
    detail.mockResolvedValueOnce(feed([product(1)]));
    await service.resume(actor.tenantId, session.id);
    expect((await service.items(actor.tenantId, session.id, query)).items[0]).toMatchObject({
      productId,
      match: "other_link",
      selectable: false,
      reason: "other_link",
    });
  });
});
