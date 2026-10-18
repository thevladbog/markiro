import { randomUUID } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { schema, Db } from "@markiro/db";
import { describe, expect, it, vi } from "vitest";
import { BillingDocumentsService } from "../src/modules/billing/billing-documents.service";
import type { BillingService } from "../src/modules/billing/billing.service";
import type { ObjectStorageService } from "../src/modules/storage/object-storage.service";

function double<T>() {
  return <K extends keyof T>(value: Pick<T, K>): T => value as T;
}
type Row = typeof schema.invoiceDocuments.$inferSelect;

function fixture(taxId = "234106228141", failSignedPdfOnce = false) {
  const rows: Row[] = [];
  const uploads = new Map<string, Buffer>();
  const invoice = double<Awaited<ReturnType<BillingService["get"]>>>()({
    id: randomUUID(),
    tenantId: "invoice-variants",
    number: "INV-TEST-184",
    status: "issued",
    issueDate: new Date("2026-10-17T09:00:00Z"),
    dueDate: null,
    sellerSnapshot: { displayName: "Тестовый поставщик", inn: taxId },
    buyerSnapshot: { displayName: "Тестовый покупатель" },
    lines: [],
    subtotal: "0.00",
    vatTotal: "0.00",
    total: "0.00",
  });
  function query() {
    const promise = Promise.resolve(rows);
    const q = { from: () => q, where: () => q, then: promise.then.bind(promise) };
    return q;
  }
  const db: Db = Object.assign(Object.create(null), {
    select: vi.fn(query),
    insert: vi.fn(() => ({
      values: (values: Row[]) => ({
        onConflictDoNothing: async () => {
          for (const value of values) {
            if (
              rows.some(
                (row) =>
                  row.revision === value.revision &&
                  row.format === value.format &&
                  row.printVariant === value.printVariant,
              )
            )
              continue;
            rows.push({
              ...value,
              id: randomUUID(),
              objectKey: null,
              contentType: null,
              sha256: null,
              byteSize: null,
              errorCode: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          }
        },
      }),
    })),
    update: vi.fn(() => ({
      set: (patch: Partial<Row>) => ({
        where: (condition: SQL) => ({
          returning: async () => {
            // Each where clause contains the document UUID bound by eq().
            const [id] = new PgDialect().sqlToQuery(condition).params;
            const row = rows.find((candidate) => candidate.id === id);
            if (!row) throw new Error("document_not_found");
            Object.assign(row, patch);
            return [row];
          },
        }),
      }),
    })),
  });
  const billing = double<BillingService>()({ get: vi.fn(async () => invoice) });
  const storage = double<ObjectStorageService>()({
    ensureBucket: vi.fn(async () => undefined),
    put: vi.fn(async (key: string, body: Buffer) => {
      if (failSignedPdfOnce && key.endsWith("-signed.pdf")) {
        failSignedPdfOnce = false;
        throw new Error("synthetic_upload_failure");
      }
      uploads.set(key, body);
    }),
  });
  return { service: new BillingDocumentsService(db, billing, storage), invoice, rows, uploads };
}

describe("invoice document variants", () => {
  it.each(["clean", "signed"] as const)(
    "generates both variants for the authorized seller even when %s was requested",
    async (variant) => {
      const { service, invoice, uploads } = fixture();
      const result = await service.renderInvoice(invoice.id, 1, variant);
      expect(
        result.documents
          .map(({ format, printVariant, status }) => [format, printVariant, status])
          .sort(),
      ).toEqual([
        ["html", "clean", "ready"],
        ["html", "signed", "ready"],
        ["pdf", "clean", "ready"],
        ["pdf", "signed", "ready"],
      ]);
      expect(uploads.size).toBe(4);
      const clean = uploads
        .get(`tenants/${invoice.tenantId}/invoices/${invoice.id}/r1-clean.html`)
        ?.toString();
      const signed = uploads
        .get(`tenants/${invoice.tenantId}/invoices/${invoice.id}/r1-signed.html`)
        ?.toString();
      expect(clean).not.toContain('class="authorized-signature"');
      expect(signed).toContain('class="authorized-signature"');
      await service.renderInvoice(invoice.id, 1, variant);
      expect(uploads.size).toBe(4);
    },
  );

  it("retains an already ready legacy file when completing both variants", async () => {
    const { service, invoice, rows, uploads } = fixture();
    const legacyId = randomUUID();
    rows.push({
      id: legacyId,
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
      revision: 1,
      format: "pdf",
      printVariant: "clean",
      status: "ready",
      objectKey: "legacy/r1.pdf",
      contentType: "application/pdf",
      sha256: "a".repeat(64),
      byteSize: 123,
      rendererVersion: "billing-print-v3",
      errorCode: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await service.renderInvoice(invoice.id, 1);
    expect(result.documents).toHaveLength(4);
    expect(result.documents.find((document) => document.id === legacyId)).toMatchObject({
      sha256: "a".repeat(64),
      byteSize: 123,
      status: "ready",
    });
    expect(rows.find((document) => document.id === legacyId)?.objectKey).toBe("legacy/r1.pdf");
    expect(uploads.size).toBe(3);
    expect(uploads.has(`tenants/${invoice.tenantId}/invoices/${invoice.id}/r1-clean.pdf`)).toBe(
      false,
    );
  });

  it("keeps the other files ready and retries only the failed signed PDF", async () => {
    const { service, invoice, uploads } = fixture("234106228141", true);
    const first = await service.renderInvoice(invoice.id, 1);
    expect(first.documents.filter((document) => document.status === "ready")).toHaveLength(3);
    expect(first.documents.find((document) => document.status === "failed")).toMatchObject({
      format: "pdf",
      printVariant: "signed",
      errorCode: "synthetic_upload_failure",
    });
    expect(uploads.size).toBe(3);
    const retry = await service.renderInvoice(invoice.id, 1);
    expect(retry.documents.every((document) => document.status === "ready")).toBe(true);
    expect(uploads.size).toBe(4);
  });

  it("never applies another seller's signature and seal", async () => {
    const { service, invoice } = fixture("7700000000");
    const result = await service.renderInvoice(invoice.id, 1);
    expect(result.documents.map((document) => document.printVariant)).toEqual(["clean", "clean"]);
    await expect(service.renderInvoice(invoice.id, 2, "signed")).rejects.toThrow(
      "signed_print_seller_not_authorized",
    );
  });
});
