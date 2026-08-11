import { createHash } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { ObjectStorageService } from "../storage/object-storage.service";
import { BillingService } from "./billing.service";

@Injectable()
export class BillingDocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly billing: BillingService,
    private readonly storage: ObjectStorageService,
  ) {}

  async renderAndStore(invoiceId: string) {
    const invoice = await this.billing.get(invoiceId);
    const html = renderInvoice(invoice);
    const body = Buffer.from(html, "utf8");
    const revision = 1;
    const key = `tenants/${invoice.tenantId}/invoices/${invoice.id}/r${revision}.html`;
    await this.storage.ensureBucket();
    await this.storage.put(key, body, "text/html; charset=utf-8");
    const checksum = createHash("sha256").update(body).digest("hex");
    const [document] = await this.db
      .insert(schema.invoiceDocuments)
      .values({
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        revision,
        format: "html",
        status: "ready",
        objectKey: key,
        contentType: "text/html; charset=utf-8",
        sha256: checksum,
        byteSize: body.byteLength,
        rendererVersion: "billing-html-v1",
      })
      .onConflictDoUpdate({
        target: [schema.invoiceDocuments.invoiceId, schema.invoiceDocuments.revision, schema.invoiceDocuments.format],
        set: { status: "ready", objectKey: key, sha256: checksum, byteSize: body.byteLength, updatedAt: new Date(), errorCode: null },
      })
      .returning();
    return { document, url: await this.storage.presignRead(key) };
  }

  async url(invoiceId: string) {
    const [document] = await this.db
      .select()
      .from(schema.invoiceDocuments)
      .where(eq(schema.invoiceDocuments.invoiceId, invoiceId))
      .limit(1);
    if (!document?.objectKey || document.status !== "ready") {
      throw new NotFoundException({ code: "invoice_document_not_ready" });
    }
    return { url: await this.storage.presignRead(document.objectKey) };
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderInvoice(invoice: { number: string; issueDate: Date | null; dueDate: Date | null; total: string; subtotal: string; vatTotal: string; lines: Array<{ position: number; nameRu: string; unit: string; quantity: number; agreedUnitPrice: string; lineTotal: string }>; }) {
  const rows = invoice.lines.map((line) => `<tr><td>${line.position}</td><td>${escapeHtml(line.nameRu)}</td><td>${escapeHtml(line.unit)}</td><td>${line.quantity}</td><td>${escapeHtml(line.agreedUnitPrice)}</td><td>${escapeHtml(line.lineTotal)}</td></tr>`).join("");
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Счет ${escapeHtml(invoice.number)}</title><style>body{font:14px Arial;color:#171717;margin:40px}h1{font-size:24px}table{border-collapse:collapse;width:100%;margin-top:24px}th,td{border:1px solid #bbb;padding:8px;text-align:left}th{background:#f3f3f3}.totals{margin-top:24px;margin-left:auto;width:280px}.totals div{display:flex;justify-content:space-between;padding:4px}</style><h1>Счет ${escapeHtml(invoice.number)}</h1><p>Дата: ${invoice.issueDate?.toISOString().slice(0, 10) ?? "черновик"}</p><table><thead><tr><th>№</th><th>Позиция</th><th>Ед.</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>${rows}</tbody></table><div class="totals"><div><span>Подытог</span><strong>${escapeHtml(invoice.subtotal)} ₽</strong></div><div><span>НДС</span><strong>${escapeHtml(invoice.vatTotal)} ₽</strong></div><div><span>Итого</span><strong>${escapeHtml(invoice.total)} ₽</strong></div></div></html>`;
}
