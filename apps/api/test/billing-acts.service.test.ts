import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, schema, type Db } from "@markiro/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BillingActsService,
  type BillingActPdfUpload,
  validateBillingActPdf,
} from "../src/modules/billing-acts/billing-acts.service";
import { PlatformBillingRequestsService } from "../src/modules/platform-billing-requests/platform-billing-requests.service";
import type { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
} from "../src/platform-auth/platform-access-policy";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { createOrganization } from "./support/subscription-fixtures";

const databaseUrl = process.env.DATABASE_URL;
const fixedNow = new Date("2026-08-28T10:00:00.000+03:00");

describe.skipIf(!databaseUrl)("billing acts on isolated Postgres", () => {
  const databaseName = `markiro_billing_acts_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  const connection = createDb(scratchUrl.toString());
  const audit = new PlatformAuditService();
  const actorId = `billing-acts-${randomUUID()}`;
  const actor: PlatformPrincipal = {
    userId: actorId,
    role: "accountant",
    capabilities: platformCapabilitiesForRole("accountant"),
    twoFactorReady: true,
  };
  const storage = {
    putVerified: vi.fn(
      async (_key: string, body: Buffer, _contentType: string, sha256: string) => ({
        byteSize: body.byteLength,
        sha256,
      }),
    ),
    verifyObject: vi.fn(async (): Promise<"verified" | "missing" | "mismatch"> => "verified"),
    deleteConfirmed: vi.fn(async () => undefined),
  };
  let tenantA = "";
  let tenantB = "";
  let tenantUser = "";
  let requestId = "";
  let acts: TestBillingActsService;
  let requests: PlatformBillingRequestsService;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    tenantA = await createOrganization(connection.db);
    tenantB = await createOrganization(connection.db);
    tenantUser = `billing-acts-tenant-${randomUUID()}`;
    await connection.db.insert(schema.user).values({
      id: tenantUser,
      name: "Billing acts tenant user",
      email: `${tenantUser}@example.invalid`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await connection.db.insert(schema.platformUsers).values({
      id: actorId,
      name: "Billing acts actor",
      email: `${actorId}@example.invalid`,
      role: actor.role,
      status: "active",
    });
    const [request] = await connection.db
      .insert(schema.tenantBillingRequests)
      .values({
        tenantId: tenantA,
        number: `BR-ACT-${randomUUID()}`,
        type: "other",
        status: "in_progress",
        description: "Act fixture",
        responsibleSide: "markiro",
        idempotencyKey: randomUUID(),
        createdByUserId: tenantUser,
      })
      .returning();
    requestId = request!.id;
    acts = new TestBillingActsService(
      connection.db,
      storage as unknown as ObjectStorageService,
      audit,
    );
    requests = new PlatformBillingRequestsService(connection.db, audit);
  }, 120_000);

  beforeEach(() => {
    storage.putVerified
      .mockReset()
      .mockImplementation(
        async (_key: string, body: Buffer, _contentType: string, sha256: string) => ({
          byteSize: body.byteLength,
          sha256,
        }),
      );
    storage.verifyObject.mockReset().mockResolvedValue("verified");
    storage.deleteConfirmed.mockReset().mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await connection.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    await maintenance.pool.end();
  });

  it("creates payload-sensitive draft acts and tenant-scopes every source id", async () => {
    const idempotencyKey = randomUUID();
    const input = {
      tenantId: tenantA,
      requestId,
      number: `ACT-${randomUUID()}`,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-27",
      idempotencyKey,
    };
    const created = await acts.create(actor, input);
    const replay = await acts.create(actor, input);
    expect(replay).toEqual(created);
    expect(created).toMatchObject({
      tenantId: tenantA,
      requestId,
      status: "draft",
      issuedAt: null,
      document: null,
    });
    await expect(
      acts.create(actor, { ...input, number: `ACT-${randomUUID()}` }),
    ).rejects.toMatchObject({ response: { code: "idempotency_key_reused" }, status: 409 });
    await expect(
      acts.create(actor, {
        ...input,
        tenantId: tenantB,
        idempotencyKey: randomUUID(),
        number: `ACT-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ response: { code: "billing_source_tenant_mismatch" }, status: 409 });
  });

  it("persists a canonical pending intent before PUT, recovers ambiguity, and issues only once", async () => {
    const act = await acts.create(actor, {
      tenantId: tenantA,
      requestId,
      number: `ACT-${randomUUID()}`,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-27",
      idempotencyKey: randomUUID(),
    });
    const file = pdfUpload();
    storage.putVerified.mockImplementationOnce(async (key) => {
      const documentId = key
        .split("/")
        .at(-1)!
        .replace(/\.pdf$/, "");
      const pending = await connection.pool.query<{ state: string }>(
        `select state from billing_act_documents where tenant_id = $1 and act_id = $2 and id = $3`,
        [tenantA, act.id, documentId],
      );
      expect(pending.rows).toEqual([{ state: "pending" }]);
      throw new Error("PUT acknowledgement lost");
    });
    storage.verifyObject.mockResolvedValueOnce("verified");
    const idempotencyKey = randomUUID();
    const issued = await acts.issue(actor, act.id, { idempotencyKey }, file);
    const replay = await acts.issue(actor, act.id, { idempotencyKey }, file);

    expect(replay).toEqual(issued);
    expect(issued).toMatchObject({
      id: act.id,
      status: "issued",
      issuedByPlatformUserId: actorId,
      document: {
        state: "ready",
        contentType: "application/pdf",
        byteSize: file.buffer.byteLength,
        uploadedByPlatformUserId: actorId,
      },
    });
    expect(issued.document!.readyAt).not.toBeNull();
    const [putKey] = storage.putVerified.mock.calls[0]!;
    expect(putKey).toBe(`tenant-billing/${tenantA}/acts/${act.id}/${issued.document!.id}.pdf`);
    const links = await connection.db
      .select()
      .from(schema.tenantBillingRequestLinks)
      .where(eq(schema.tenantBillingRequestLinks.actId, act.id));
    expect(links).toEqual([
      expect.objectContaining({ tenantId: tenantA, requestId, actId: act.id }),
    ]);
    const events = await connection.db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(
        and(
          eq(schema.tenantBillingRequestEvents.requestId, requestId),
          eq(schema.tenantBillingRequestEvents.kind, "act_linked"),
        ),
      );
    expect(events).toEqual([
      expect.objectContaining({
        tenantId: tenantA,
        actorKind: "platform_user",
        actorPlatformUserId: actorId,
        metadata: { actId: act.id, documentId: issued.document!.id },
      }),
    ]);
    const audits = await connection.db
      .select()
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.targetId, act.id));
    expect(audits.filter((event) => event.action === "billing.act.issued")).toEqual([
      expect.objectContaining({
        actorPlatformUserId: actorId,
        actorRole: "accountant",
        tenantId: tenantA,
        targetType: "billing_act",
        outcome: "success",
        before: { status: "draft" },
        after: {
          status: "issued",
          number: act.number,
          documentId: issued.document!.id,
          sha256: issued.document!.sha256,
          byteSize: file.buffer.byteLength,
        },
      }),
    ]);
    await expect(
      acts.issue(actor, act.id, { idempotencyKey: randomUUID() }, file),
    ).rejects.toMatchObject({ response: { code: "billing_act_already_issued" }, status: 409 });
  });

  it("requires a completed ordered service, or a period end strictly before the Moscow business date", async () => {
    const periodAct = await acts.create(actor, {
      tenantId: tenantA,
      number: `ACT-${randomUUID()}`,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-28",
      idempotencyKey: randomUUID(),
    });
    await expect(
      acts.issue(actor, periodAct.id, { idempotencyKey: randomUUID() }, pdfUpload()),
    ).rejects.toMatchObject({ response: { code: "billing_act_period_not_closed" }, status: 409 });

    const orderedServiceId = await insertOrderedService(connection.db, tenantA, actorId, "ordered");
    const serviceAct = await acts.create(actor, {
      tenantId: tenantA,
      orderedServiceId,
      number: `ACT-${randomUUID()}`,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-28",
      idempotencyKey: randomUUID(),
    });
    await expect(
      acts.issue(actor, serviceAct.id, { idempotencyKey: randomUUID() }, pdfUpload()),
    ).rejects.toMatchObject({
      response: { code: "billing_act_service_not_completed" },
      status: 409,
    });
    const completedServiceId = await insertOrderedService(
      connection.db,
      tenantA,
      actorId,
      "completed",
    );
    const completedAct = await acts.create(actor, {
      tenantId: tenantA,
      orderedServiceId: completedServiceId,
      number: `ACT-${randomUUID()}`,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-28",
      idempotencyKey: randomUUID(),
    });
    await expect(
      acts.issue(actor, completedAct.id, { idempotencyKey: randomUUID() }, pdfUpload()),
    ).resolves.toMatchObject({ status: "issued" });
  });

  it("cancels without deleting an issued document", async () => {
    const act = await acts.create(actor, {
      tenantId: tenantA,
      number: `ACT-${randomUUID()}`,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-27",
      idempotencyKey: randomUUID(),
    });
    const issued = await acts.issue(actor, act.id, { idempotencyKey: randomUUID() }, pdfUpload());
    const key = randomUUID();
    const cancelled = await acts.cancel(actor, act.id, { idempotencyKey: key });
    const replay = await acts.cancel(actor, act.id, { idempotencyKey: key });
    expect(replay).toEqual(cancelled);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      document: { id: issued.document!.id, state: "ready" },
    });
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it("rejects cancellation while a durable upload intent is pending, then preserves the ready PDF", async () => {
    const act = await acts.create(actor, {
      tenantId: tenantA,
      number: `ACT-${randomUUID()}`,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-27",
      idempotencyKey: randomUUID(),
    });
    let notifyPutStarted!: () => void;
    let releasePut!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      notifyPutStarted = resolve;
    });
    const mayFinishPut = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    storage.putVerified.mockImplementationOnce(async (_key, body, _contentType, sha256) => {
      notifyPutStarted();
      await mayFinishPut;
      return { byteSize: body.byteLength, sha256 };
    });
    const file = pdfUpload();
    const issueOutcome = acts.issue(actor, act.id, { idempotencyKey: randomUUID() }, file).then(
      (result) => ({ kind: "success" as const, result }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    await putStarted;
    const cancelFailure = await acts
      .cancel(actor, act.id, { idempotencyKey: randomUUID() })
      .catch((error: unknown) => error);
    releasePut();
    const outcome = await issueOutcome;

    expect(cancelFailure).toMatchObject({
      response: { code: "act_issue_in_progress" },
      status: 409,
    });
    expect(outcome).toMatchObject({
      kind: "success",
      result: { status: "issued", document: { state: "ready" } },
    });
    if (outcome.kind !== "success") {
      throw new Error("act issue did not return a ready document");
    }
    const issued = outcome.result;
    const issuedDocumentId = issued.document?.id;
    if (!issuedDocumentId) throw new Error("act issue did not return a ready document");
    const cancelled = await acts.cancel(actor, act.id, { idempotencyKey: randomUUID() });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      document: { id: issuedDocumentId, state: "ready" },
    });
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it("reconciles a cleanup-required upload intent on the same issue key", async () => {
    const act = await acts.create(actor, {
      tenantId: tenantA,
      number: `ACT-${randomUUID()}`,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-27",
      idempotencyKey: randomUUID(),
    });
    const file = pdfUpload();
    const idempotencyKey = randomUUID();
    const uploadFailure = new Error("PUT failed after a possible write");
    storage.putVerified.mockRejectedValueOnce(uploadFailure);
    storage.verifyObject.mockResolvedValueOnce("mismatch").mockResolvedValueOnce("verified");
    storage.deleteConfirmed.mockRejectedValueOnce(new Error("DELETE acknowledgement lost"));

    await expect(acts.issue(actor, act.id, { idempotencyKey }, file)).rejects.toBe(uploadFailure);
    const [cleanupDocument] = await connection.db
      .select()
      .from(schema.billingActDocuments)
      .where(eq(schema.billingActDocuments.actId, act.id));
    expect(cleanupDocument).toMatchObject({ state: "cleanup_required" });
    await expect(
      acts.cancel(actor, act.id, { idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ response: { code: "act_issue_in_progress" }, status: 409 });

    const issued = await acts.issue(actor, act.id, { idempotencyKey }, file);
    expect(issued).toMatchObject({ status: "issued", document: { state: "ready" } });
    expect(storage.putVerified).toHaveBeenCalledTimes(1);
    expect(storage.verifyObject).toHaveBeenCalledTimes(2);
  });

  it("issues a pre-linked act without duplicating the tenant event or platform audit fact", async () => {
    const act = await acts.create(actor, {
      tenantId: tenantA,
      requestId,
      number: `ACT-${randomUUID()}`,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-27",
      idempotencyKey: randomUUID(),
    });
    await requests.link(actor, requestId, {
      type: "act",
      targetId: act.id,
      idempotencyKey: randomUUID(),
    });

    await expect(
      acts.issue(actor, act.id, { idempotencyKey: randomUUID() }, pdfUpload()),
    ).resolves.toMatchObject({ status: "issued" });
    const linkEvents = await connection.db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(
        and(
          eq(schema.tenantBillingRequestEvents.requestId, requestId),
          eq(schema.tenantBillingRequestEvents.kind, "act_linked"),
        ),
      );
    expect(
      linkEvents.filter((event) => jsonStringField(event.metadata, "targetId") === act.id),
    ).toHaveLength(1);
    const linkAudits = await connection.db
      .select()
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.targetId, requestId));
    expect(
      linkAudits.filter(
        (event) =>
          (event.action === "billing.request.linked" &&
            jsonStringField(event.after, "targetId") === act.id) ||
          (event.action === "billing.request.act_linked" &&
            jsonStringField(event.after, "actId") === act.id),
      ),
    ).toHaveLength(1);
  });

  it("serializes explicit act linking against issue without a deadlock or duplicate link fact", async () => {
    const act = await acts.create(actor, {
      tenantId: tenantA,
      requestId,
      number: `ACT-${randomUUID()}`,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-27",
      idempotencyKey: randomUUID(),
    });
    const [linkOutcome, issueOutcome] = await Promise.allSettled([
      requests.link(actor, requestId, {
        type: "act",
        targetId: act.id,
        idempotencyKey: randomUUID(),
      }),
      acts.issue(actor, act.id, { idempotencyKey: randomUUID() }, pdfUpload()),
    ]);

    expect(issueOutcome).toMatchObject({ status: "fulfilled", value: { status: "issued" } });
    if (linkOutcome.status === "rejected") {
      expect(linkOutcome.reason).toMatchObject({
        response: { code: "billing_request_link_exists" },
        status: 409,
      });
    }
    const links = await connection.db
      .select()
      .from(schema.tenantBillingRequestLinks)
      .where(eq(schema.tenantBillingRequestLinks.actId, act.id));
    expect(links).toHaveLength(1);
    const events = await connection.db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(eq(schema.tenantBillingRequestEvents.kind, "act_linked"));
    expect(
      events.filter(
        (event) =>
          jsonStringField(event.metadata, "actId") === act.id ||
          jsonStringField(event.metadata, "targetId") === act.id,
      ),
    ).toHaveLength(1);
  });

  it("writes a canonical act key for public tenant IDs containing dots and colons", async () => {
    const safeTenantId = `factory.${randomUUID().slice(0, 8)}:primary`;
    await connection.db.insert(schema.organization).values({
      id: safeTenantId,
      name: "Dot and colon tenant",
      slug: `dot-colon-${randomUUID()}`,
      createdAt: new Date(),
    });
    const act = await acts.create(actor, {
      tenantId: safeTenantId,
      number: `ACT-${randomUUID()}`,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-27",
      idempotencyKey: randomUUID(),
    });
    const issued = await acts.issue(actor, act.id, { idempotencyKey: randomUUID() }, pdfUpload());

    expect(storage.putVerified).toHaveBeenCalledWith(
      `tenant-billing/${safeTenantId}/acts/${act.id}/${issued.document!.id}.pdf`,
      expect.any(Buffer),
      "application/pdf",
      issued.document!.sha256,
    );
  });
});

describe("billing act PDF validation", () => {
  it("rejects declared PDFs without PDF magic", () => {
    expect(() =>
      validateBillingActPdf({
        originalname: "fake.pdf",
        mimetype: "application/pdf",
        size: 5,
        buffer: Buffer.from("hello"),
      }),
    ).toThrowError(expect.objectContaining({ response: { code: "billing_act_pdf_invalid" } }));
  });

  it("rejects MIME spoofing and files over five MiB", () => {
    expect(() => validateBillingActPdf({ ...pdfUpload(), mimetype: "text/plain" })).toThrow();
    const body = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(5 * 1024 * 1024)]);
    expect(() =>
      validateBillingActPdf({
        originalname: "large.pdf",
        mimetype: "application/pdf",
        size: body.byteLength,
        buffer: body,
      }),
    ).toThrowError(expect.objectContaining({ response: { code: "billing_act_pdf_size_invalid" } }));
  });
});

class TestBillingActsService extends BillingActsService {
  protected override now(): Date {
    return fixedNow;
  }
}

function pdfUpload(): BillingActPdfUpload {
  const buffer = Buffer.from("%PDF-1.7\nact fixture");
  return {
    originalname: "act.pdf",
    mimetype: "application/pdf",
    size: buffer.byteLength,
    buffer,
  };
}

function jsonStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
}

async function insertOrderedService(
  db: Db,
  tenantId: string,
  actorId: string,
  status: "ordered" | "completed",
) {
  const [offer] = await db
    .insert(schema.commercialOffers)
    .values({
      tenantId,
      revision: 1,
      status: "draft",
      total: "100.00",
      createdByPlatformUserId: actorId,
    })
    .returning();
  const [line] = await db
    .insert(schema.commercialOfferLines)
    .values({
      tenantId,
      offerId: offer!.id,
      position: 1,
      kind: "service",
      nameRu: "Услуга",
      nameEn: "Service",
      quantity: 1,
      unit: "услуга",
      agreedUnitPrice: "100.00",
      vatIncluded: false,
      lineTotal: "100.00",
    })
    .returning();
  await db
    .update(schema.commercialOffers)
    .set({
      status: "published",
      number: `KP-ACT-${randomUUID()}`,
      publishedAt: new Date(),
      publishedByPlatformUserId: actorId,
    })
    .where(eq(schema.commercialOffers.id, offer!.id));
  const [payment] = await db
    .insert(schema.payments)
    .values({
      tenantId,
      offerId: offer!.id,
      paidAt: new Date(),
      amount: "100.00",
      bankReference: randomUUID(),
      platformUserId: actorId,
      idempotencyKey: randomUUID(),
    })
    .returning();
  const [service] = await db
    .insert(schema.orderedServices)
    .values({
      tenantId,
      offerLineId: line!.id,
      paymentId: payment!.id,
      nameRu: "Услуга",
      nameEn: "Service",
      quantity: 1,
      unit: "услуга",
      status,
      orderedAt: new Date(),
    })
    .returning();
  return service!.id;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}
