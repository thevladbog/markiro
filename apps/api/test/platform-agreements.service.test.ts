import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { ConflictException, NotFoundException } from "@nestjs/common";
import { createDb, schema } from "@markiro/db";
import type { CreateAgreementInput } from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgreementDocumentsService } from "../src/modules/platform-agreements/agreement-documents.service";
import { PlatformAgreementsService } from "../src/modules/platform-agreements/platform-agreements.service";
import type { PlatformPrincipal } from "../src/platform-auth/platform-access-policy";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { createOrganization } from "./support/subscription-fixtures";

const databaseUrl = process.env.DATABASE_URL;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const COUNTERPARTY: CreateAgreementInput["counterparty"] = {
  kind: "legal_entity",
  name: "ООО «Пример»",
  inn: "7701234567",
  kpp: "770101001",
  ogrn: "1027700000000",
  address: "101000, Москва, ул. Примерная, д. 1",
  email: "buh@example.invalid",
  phone: "+7 495 000-00-00",
  bankName: "АО «Банк»",
  bic: "044525000",
  settlementAccount: "40702810000000000001",
  correspondentAccount: "30101810000000000002",
};

describe.skipIf(!databaseUrl)("platform agreements on isolated Postgres", () => {
  const databaseName = `markiro_agreements_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  const connection = createDb(scratchUrl.toString());
  const actorId = `agreement-actor-${randomUUID()}`;
  const actor: PlatformPrincipal = {
    userId: actorId,
    role: "accountant",
    capabilities: ["agreements.read", "agreements.write"],
    twoFactorReady: true,
  };
  const stored = new Map<string, Buffer>();
  let db: typeof connection.db;
  let service: PlatformAgreementsService;
  let documents: AgreementDocumentsService;
  let tenantId = "";

  const storageStub = {
    putVerified: async (key: string, body: Buffer) => {
      stored.set(key, body);
      return { byteSize: body.byteLength, sha256: "" };
    },
    presignRead: async (key: string) => `https://storage.invalid/${encodeURIComponent(key)}?sig=x`,
    deleteConfirmed: async (key: string) => {
      stored.delete(key);
    },
  };

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    db = connection.db;
    await db.insert(schema.platformUsers).values({
      id: actorId,
      name: "Agreement actor",
      email: `${actorId}@example.invalid`,
      role: actor.role,
      status: "active",
    });
    tenantId = await createOrganization(db);
    await db.insert(schema.tenantBillingProfiles).values({
      tenantId,
      revision: 1,
      isCurrent: true,
      kind: "legal_entity",
      fullName: "ООО «Пример»",
      displayName: "ООО «Пример»",
      inn: COUNTERPARTY.inn,
      kpp: "770101001",
      ogrn: "1027700000000",
      addressRaw: "101000, Москва",
      legalAddressRaw: "101000, Москва",
      createdByPlatformUserId: actorId,
    });
    await db.insert(schema.operatorBillingProfiles).values({
      revision: 1,
      isCurrent: true,
      kind: "sole_proprietor",
      fullName: "Богатырев Владислав Сергеевич",
      displayName: "ИП Богатырев Владислав Сергеевич",
      inn: "231000000000",
      ogrnip: "312231000000001",
      addressRaw: "353745, Краснодарский край",
      legalAddressRaw: "353745, Краснодарский край",
      bankDetails: { bankName: "АО «Тинькофф Банк»", bic: "044525974" },
      contact: { email: "hello@v-b.tech", phone: "+7 934 355-14-90" },
      createdByPlatformUserId: actorId,
    });

    const audit = new PlatformAuditService();
    documents = new AgreementDocumentsService(connection.db, storageStub as never, audit);
    service = new PlatformAgreementsService(connection.db, audit, documents);
  }, 120_000);

  afterAll(async () => {
    await connection.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    await maintenance.pool.end();
  });

  it("allocates the first number of the year and starts editable", async () => {
    const { agreement } = await service.create(actor, { counterparty: COUNTERPARTY });
    expect(agreement.number).toMatch(/^МКР-\d{4}-0001$/);
    expect(agreement.status).toBe("draft");
    expect(agreement.editable).toBe(true);
    expect(agreement.counterpartyInn).toBe("7701234567");
    // The seller side is taken from the operator profile, never from input.
    expect(agreement.contractor.name).toBe("ИП Богатырев Владислав Сергеевич");
  });

  it("continues the sequence on the next create", async () => {
    const { agreement } = await service.create(actor, { counterparty: COUNTERPARTY });
    expect(agreement.number).toMatch(/^МКР-\d{4}-0002$/);
  });

  it("rejects an update after signing and refuses to walk back", async () => {
    const { agreement } = await service.create(actor, { counterparty: COUNTERPARTY });
    await service.transition(actor, agreement.id, "sent", undefined);
    const signed = await service.transition(actor, agreement.id, "signed", undefined);
    expect(signed.agreement.editable).toBe(false);
    expect(signed.agreement.signedAt).not.toBeNull();

    await expect(service.update(actor, agreement.id, { city: "Москва" })).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(
      service.transition(actor, agreement.id, "draft", undefined),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("writes an audit row naming the exact actor, target and status move", async () => {
    const { agreement } = await service.create(actor, { counterparty: COUNTERPARTY });
    await service.transition(actor, agreement.id, "in_review", undefined);
    const rows = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.targetId, agreement.id));
    const move = rows.find((row) => row.action === "platform.agreement.status_changed");
    expect(move).toBeDefined();
    expect(move?.actorPlatformUserId).toBe(actorId);
    expect(move?.targetType).toBe("platform_agreement");
    expect(move?.outcome).toBe("success");
    expect(move?.before).toMatchObject({ status: "draft" });
    expect(move?.after).toMatchObject({ status: "in_review" });
  });

  it("suggests only tenants whose current profile INN matches", async () => {
    const { agreement } = await service.create(actor, { counterparty: COUNTERPARTY });
    const { candidates } = await service.tenantCandidates(agreement.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.tenantId).toBe(tenantId);

    const other = await service.create(actor, {
      counterparty: { ...COUNTERPARTY, inn: "7709999999" },
    });
    expect((await service.tenantCandidates(other.agreement.id)).candidates).toHaveLength(0);
  });

  it("links a tenant after signing without touching the frozen snapshot", async () => {
    const { agreement } = await service.create(actor, { counterparty: COUNTERPARTY });
    await service.transition(actor, agreement.id, "sent", undefined);
    await service.transition(actor, agreement.id, "signed", undefined);
    const [before] = await db
      .select({ snapshot: schema.platformAgreements.signedSnapshot })
      .from(schema.platformAgreements)
      .where(eq(schema.platformAgreements.id, agreement.id));

    const linked = await service.linkTenant(actor, agreement.id, tenantId);
    expect(linked.agreement.tenantId).toBe(tenantId);

    const [after] = await db
      .select({ snapshot: schema.platformAgreements.signedSnapshot })
      .from(schema.platformAgreements)
      .where(eq(schema.platformAgreements.id, agreement.id));
    expect(after?.snapshot).toEqual(before?.snapshot);

    await expect(service.linkTenant(actor, agreement.id, "missing-tenant")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("keeps one draft document per agreement and a separate signed one", async () => {
    const { agreement } = await service.create(actor, {
      counterparty: COUNTERPARTY,
      city: "Краснодар",
      conclusionDate: "2026-09-11",
    });
    const row = await service.requireAgreement(agreement.id);
    const first = await documents.renderDraft(actor, row);
    const second = await documents.renderDraft(actor, row);
    expect(first.id).toBe(second.id);
    expect(second.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.byteSize).toBeGreaterThan(0);

    await service.transition(actor, agreement.id, "sent", undefined);
    const signed = await service.transition(actor, agreement.id, "signed", undefined);
    const kinds = signed.agreement.documents.map((document) => document.kind).sort();
    expect(kinds).toEqual(["draft", "generated"]);

    const generated = signed.agreement.documents.find((doc) => doc.kind === "generated");
    expect(generated?.sha256).not.toBe(first.sha256);
  });

  it("puts the agreement number into the rendered DOCX", async () => {
    const { agreement } = await service.create(actor, {
      counterparty: COUNTERPARTY,
      city: "Краснодар",
    });
    const row = await service.requireAgreement(agreement.id);
    await documents.renderDraft(actor, row);
    const bytes = stored.get(`agreements/${agreement.id}/draft.docx`);
    expect(bytes).toBeDefined();
    const { unzipSync } = await import("fflate");
    const xml = new TextDecoder().decode(unzipSync(new Uint8Array(bytes!))["word/document.xml"]!);
    // Proves the fields reached the file rather than rendering blank.
    expect(xml).toContain(agreement.number);
    expect(xml).toContain("ООО «Пример»");
    expect(xml).toContain("Краснодар");
  });

  it("renders the bilingual form when the record asks for it", async () => {
    const { agreement } = await service.create(actor, {
      counterparty: COUNTERPARTY,
      city: "Краснодар",
      documentForm: "ru_en",
    });
    expect(agreement.documentForm).toBe("ru_en");
    const row = await service.requireAgreement(agreement.id);
    const document = await documents.renderDraft(actor, row);
    expect(document.filename).toContain("_ru-en");

    const bytes = stored.get(`agreements/${agreement.id}/draft.docx`);
    const { unzipSync } = await import("fflate");
    const xml = new TextDecoder().decode(unzipSync(new Uint8Array(bytes!))["word/document.xml"]!);
    // Both columns carry the number; the Russian accounting form appears once.
    expect(xml.split(agreement.number).length - 1).toBeGreaterThanOrEqual(2);
    expect(xml.split("Форма счёта на оплату").length - 1).toBe(1);
  });

  it("defaults to the Russian form and names the file without a suffix", async () => {
    const { agreement } = await service.create(actor, { counterparty: COUNTERPARTY });
    expect(agreement.documentForm).toBe("ru");
    const row = await service.requireAgreement(agreement.id);
    const document = await documents.renderDraft(actor, row);
    expect(document.filename).not.toContain("_ru-en");
  });

  it("replaces the generated document when the form changes", async () => {
    const { agreement } = await service.create(actor, { counterparty: COUNTERPARTY });
    const before = await documents.renderDraft(actor, await service.requireAgreement(agreement.id));
    expect(before.stale).toBe(false);

    const updated = await service.update(actor, agreement.id, { documentForm: "ru_en" });
    // The edit does not re-render, so the stored file now contradicts the
    // record — and says so instead of looking clean.
    expect(updated.agreement.documents.find((doc) => doc.kind === "draft")?.stale).toBe(true);

    const after = await documents.renderDraft(actor, await service.requireAgreement(agreement.id));
    // One agreement, one draft original: the row is reused, the bytes are not.
    expect(after.id).toBe(before.id);
    expect(after.sha256).not.toBe(before.sha256);
    expect(after.stale).toBe(false);
  });

  it("marks the draft stale after any edit that changes the printed document", async () => {
    for (const edit of [
      { number: "МКР-2026-9001" },
      { city: "Сочи" },
      { conclusionDate: "2026-10-01" },
      { documentForm: "ru_en" as const },
      { counterparty: { ...COUNTERPARTY, name: "ООО «Другое»" } },
    ]) {
      const { agreement } = await service.create(actor, { counterparty: COUNTERPARTY });
      await documents.renderDraft(actor, await service.requireAgreement(agreement.id));
      const updated = await service.update(actor, agreement.id, edit);
      const draft = updated.agreement.documents.find((doc) => doc.kind === "draft");
      // A rule that covered only the field added last would be worse than no
      // rule: four fields of five would quietly disagree with the record.
      expect(draft?.stale, `editing ${Object.keys(edit)[0]} left the draft looking clean`).toBe(
        true,
      );
    }
  });

  it("leaves the draft clean when an edit cannot change the printed document", async () => {
    const { agreement } = await service.create(actor, { counterparty: COUNTERPARTY });
    await documents.renderDraft(actor, await service.requireAgreement(agreement.id));
    // Re-submitting the same values must not invent staleness; neither must a
    // tenant link, which the renderer never reads.
    const same = await service.update(actor, agreement.id, { counterparty: COUNTERPARTY });
    expect(same.agreement.documents.find((doc) => doc.kind === "draft")?.stale).toBe(false);
  });

  it("never calls an attachment stale", async () => {
    const { agreement } = await service.create(actor, { counterparty: COUNTERPARTY });
    const uploaded = await documents.uploadAttachment(
      actor,
      await service.requireAgreement(agreement.id),
      {
        originalname: "scan.pdf",
        mimetype: "application/pdf",
        buffer: Buffer.from("%PDF-1.4 scan"),
      },
    );
    expect(uploaded.stale).toBe(false);
    await service.update(actor, agreement.id, { city: "Сочи" });
    const detail = await service.detail(agreement.id);
    expect(detail.agreement.documents.find((doc) => doc.kind === "attachment")?.stale).toBe(false);
  });

  it("requires a reason to terminate and records it", async () => {
    const { agreement } = await service.create(actor, { counterparty: COUNTERPARTY });
    await service.transition(actor, agreement.id, "sent", undefined);
    await service.transition(actor, agreement.id, "signed", undefined);
    const terminated = await service.transition(
      actor,
      agreement.id,
      "terminated",
      "Соглашение сторон",
    );
    expect(terminated.agreement.status).toBe("terminated");
    expect(terminated.agreement.terminationReason).toBe("Соглашение сторон");
    expect(terminated.agreement.terminatedAt).not.toBeNull();
  });

  it("rejects a duplicate manual number", async () => {
    await service.create(actor, { counterparty: COUNTERPARTY, number: "РУЧНОЙ-1" });
    await expect(
      service.create(actor, { counterparty: COUNTERPARTY, number: "РУЧНОЙ-1" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("stores an attachment under a generated key and deletes only attachments", async () => {
    const { agreement } = await service.create(actor, { counterparty: COUNTERPARTY });
    const row = await service.requireAgreement(agreement.id);
    const rendered = await documents.renderDraft(actor, row);

    const attachment = await documents.uploadAttachment(actor, row, {
      originalname: "../../подписанный скан.pdf",
      mimetype: "application/pdf",
      buffer: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]),
    });
    expect(attachment.kind).toBe("attachment");
    expect(attachment.sha256).toMatch(/^[0-9a-f]{64}$/);

    const [stored_] = await db
      .select({ objectKey: schema.platformAgreementDocuments.objectKey })
      .from(schema.platformAgreementDocuments)
      .where(eq(schema.platformAgreementDocuments.id, attachment.id));
    // The traversal in the client filename never reaches the bucket path.
    expect(stored_?.objectKey).toMatch(
      new RegExp(`^agreements/${agreement.id}/attachments/[0-9a-f-]{36}$`),
    );

    const { url } = await documents.download(agreement.id, attachment.id);
    expect(url).toContain("https://storage.invalid/");
    expect(url).not.toContain("подписанный");

    await expect(documents.deleteAttachment(actor, agreement.id, rendered.id)).rejects.toThrow(
      /Only an uploaded attachment/,
    );
    await expect(documents.deleteAttachment(actor, agreement.id, attachment.id)).resolves.toEqual({
      deleted: true,
    });
  });

  it("filters the list by status, missing tenant and search", async () => {
    const all = await service.list({});
    expect(all.agreements.length).toBeGreaterThan(0);

    const signedOnly = await service.list({ status: "signed" });
    expect(signedOnly.agreements.every((row) => row.status === "signed")).toBe(true);

    const unlinked = await service.list({ withoutTenant: true });
    expect(unlinked.agreements.every((row) => row.tenantId === null)).toBe(true);

    const byInn = await service.list({ search: "7709999999" });
    expect(byInn.agreements.every((row) => row.counterpartyInn === "7709999999")).toBe(true);
    expect(byInn.agreements.length).toBeGreaterThan(0);
  });
});
