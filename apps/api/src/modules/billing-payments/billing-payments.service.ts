import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { BillingApplicationService } from "../billing/billing-application.service";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import type { ImportBankFileDto, ManualPaymentDto } from "./dto";

@Injectable()
export class BillingPaymentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly application: BillingApplicationService,
    private readonly audit: PlatformAuditService,
  ) {}

  async list(tenantId?: string) {
    const query = this.db
      .select()
      .from(schema.billingPayments)
      .orderBy(desc(schema.billingPayments.paidAt));
    return {
      items: tenantId
        ? await query.where(eq(schema.billingPayments.tenantId, tenantId))
        : await query,
    };
  }

  async recordManual(principal: PlatformPrincipal, invoiceId: string, input: ManualPaymentDto) {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`billing-payment:${input.idempotencyKey}`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(schema.billingPayments)
        .where(eq(schema.billingPayments.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (existing) {
        if (
          existing.invoiceId === invoiceId &&
          existing.amount === input.amount &&
          existing.bankReference === input.bankReference &&
          existing.paidAt.getTime() === input.paidAt.getTime()
        ) {
          return existing;
        }
        throw new ConflictException({ code: "payment_idempotency_key_reused" });
      }
      await tx.execute(sql`select id from invoices where id = ${invoiceId} for update`);
      const [invoice] = await tx
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.id, invoiceId))
        .limit(1);
      if (!invoice) throw new NotFoundException({ code: "invoice_not_found" });
      if (invoice.status !== "issued")
        throw new ConflictException({
          code:
            invoice.status === "cancelled"
              ? "invoice_cancelled"
              : invoice.status === "paid"
                ? "invoice_already_paid"
                : "invoice_not_issued",
        });
      if (input.amount !== invoice.total)
        throw new BadRequestException({ code: "payment_amount_mismatch" });
      const [payment] = await tx
        .insert(schema.billingPayments)
        .values({
          tenantId: invoice.tenantId,
          invoiceId,
          source: "manual",
          paidAt: input.paidAt,
          amount: input.amount,
          bankReference: input.bankReference,
          platformUserId: principal.userId,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      await tx
        .update(schema.invoices)
        .set({ status: "paid", paidAt: input.paidAt })
        .where(eq(schema.invoices.id, invoiceId));
      const lines = await tx
        .select()
        .from(schema.invoiceLines)
        .where(eq(schema.invoiceLines.invoiceId, invoiceId));
      if (lines.length > 0) {
        await tx.insert(schema.invoiceApplicationEvents).values(
          lines.map((line) => ({
            tenantId: invoice.tenantId,
            invoiceId,
            invoiceLineId: line.id,
            attempt: 1,
            status: "pending" as const,
            kind: line.kind,
            source: "payment",
            beforeSnapshot: null,
            afterSnapshot: null,
            errorCode: null,
            actorPlatformUserId: principal.userId,
          })),
        );
      }
      if (invoice.applicationMode === "automatic" && payment) {
        await this.application.applyAutomaticInTransaction(
          tx,
          principal,
          { ...invoice, status: "paid", paidAt: input.paidAt },
          payment,
          lines,
        );
      }
      if (!payment) throw new ConflictException({ code: "payment_recording_failed" });
      await this.audit.record(tx, {
        actorPlatformUserId: principal.userId,
        actorRole: principal.role,
        action: "billing.payment.recorded",
        outcome: "success",
        tenantId: invoice.tenantId,
        targetType: "billing_payment",
        targetId: payment.id,
        reason: null,
        before: { invoiceStatus: invoice.status },
        after: {
          invoiceStatus: "paid",
          applicationMode: invoice.applicationMode,
          lineCount: lines.length,
        },
        requestId: null,
      });
      return payment;
    });
  }

  async importFile(principal: PlatformPrincipal, input: ImportBankFileDto) {
    const checksum = createHash("sha256").update(input.content).digest("hex");
    const [existing] = await this.db
      .select()
      .from(schema.paymentImports)
      .where(eq(schema.paymentImports.sourceChecksum, checksum))
      .limit(1);
    if (existing) return existing;
    return this.db.transaction(async (tx) => {
      const [record] = await tx
        .insert(schema.paymentImports)
        .values({
          sourceChecksum: checksum,
          fileName: input.fileName,
          parserVersion: "bank-csv-v1",
          createdByPlatformUserId: principal.userId,
        })
        .returning();
      if (!record) throw new BadRequestException({ code: "payment_import_failed" });
      const rows = parseRows(input.content);
      let errors = 0;
      for (const row of rows) {
        const [created] = await tx
          .insert(schema.paymentImportRows)
          .values({
            importId: record.id,
            sourceRowId: row.sourceRowId,
            operationDate: row.operationDate,
            amount: row.amount,
            currency: row.currency,
            payerName: row.payerName,
            paymentPurpose: row.paymentPurpose,
            bankReference: row.bankReference,
            rawFields: row.rawFields,
            parseError: row.parseError,
          })
          .returning();
        if (row.parseError || !created) errors += 1;
        if (created && row.amount && row.paymentPurpose) {
          const number = row.paymentPurpose.match(/INV-\d{6}/)?.[0];
          if (number) {
            const [invoice] = await tx
              .select()
              .from(schema.invoices)
              .where(eq(schema.invoices.number, number))
              .limit(1);
            await tx.insert(schema.paymentMatches).values({
              importRowId: created.id,
              tenantId: invoice?.tenantId ?? null,
              invoiceId: invoice?.id ?? null,
              status: invoice ? "suggested" : "unmatched",
              score: invoice ? 90 : 0,
              reason: invoice ? "invoice_number_in_purpose" : "invoice_not_found",
            });
          }
        }
      }
      const [updated] = await tx
        .update(schema.paymentImports)
        .set({ status: "ready", rowCount: rows.length, errorCount: errors })
        .where(eq(schema.paymentImports.id, record.id))
        .returning();
      return updated;
    });
  }
}

function parseRows(content: string) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const header = (lines.shift() ?? "").split(/[;,]/).map((v) => v.trim().toLowerCase());
  return lines.map((line, index) => {
    const values = line.split(/[;,]/).map((v) => v.trim());
    const get = (...names: string[]) =>
      values[header.findIndex((key) => names.includes(key))] ?? "";
    const amount = get("amount", "сумма");
    const operationDate = get("date", "operation_date", "дата");
    const parsedDate = operationDate ? new Date(operationDate) : null;
    const parseError =
      amount &&
      /^\d+\.\d{2}$/.test(amount) &&
      (!operationDate || !Number.isNaN(parsedDate?.getTime()))
        ? null
        : "invalid_amount_or_date";
    return {
      sourceRowId: String(index + 1),
      operationDate: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
      amount: /^\d+\.\d{2}$/.test(amount) ? amount : null,
      currency: get("currency", "валюта") || "RUB",
      payerName: get("payer", "payer_name", "плательщик") || null,
      paymentPurpose: get("purpose", "payment_purpose", "назначение") || null,
      bankReference: get("reference", "bank_reference", "номер") || null,
      rawFields: Object.fromEntries(
        header.map((key, i) => [key || `column_${i + 1}`, values[i] ?? ""]),
      ),
      parseError,
    };
  });
}
