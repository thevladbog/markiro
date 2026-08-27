import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  payerAccountEvidenceSchema,
  type PayerAccountEvidence,
  BillingPaymentServiceSource,
  type ManualBillingPaymentServiceResultSource,
  type PaymentMatchResolveDto,
  type PaymentMatchServiceSource,
  PaymentImportServiceResultSource,
} from "@markiro/platform-contracts";
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

  async list(tenantId?: string): Promise<{ items: BillingPaymentServiceSource[] }> {
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

  async listMatches(tenantId?: string): Promise<{ items: PaymentMatchServiceSource[] }> {
    const rows = await this.db
      .select({
        id: schema.paymentMatches.id,
        importId: schema.paymentImportRows.importId,
        importRowId: schema.paymentMatches.importRowId,
        sourceRowId: schema.paymentImportRows.sourceRowId,
        operationDate: schema.paymentImportRows.operationDate,
        amount: schema.paymentImportRows.amount,
        currency: schema.paymentImportRows.currency,
        payerName: schema.paymentImportRows.payerName,
        paymentPurpose: schema.paymentImportRows.paymentPurpose,
        bankReference: schema.paymentImportRows.bankReference,
        tenantId: schema.paymentMatches.tenantId,
        invoiceId: schema.paymentMatches.invoiceId,
        invoiceNumber: schema.invoices.number,
        status: schema.paymentMatches.status,
        score: schema.paymentMatches.score,
        reason: schema.paymentMatches.reason,
        tenantBankAccountId: schema.paymentMatches.tenantBankAccountId,
        payerAccountEvidence: schema.paymentMatches.payerAccountEvidence,
        decidedByPlatformUserId: schema.paymentMatches.decidedByPlatformUserId,
        decidedAt: schema.paymentMatches.decidedAt,
        createdAt: schema.paymentMatches.createdAt,
      })
      .from(schema.paymentMatches)
      .innerJoin(
        schema.paymentImportRows,
        eq(schema.paymentImportRows.id, schema.paymentMatches.importRowId),
      )
      .leftJoin(schema.invoices, eq(schema.invoices.id, schema.paymentMatches.invoiceId))
      .where(tenantId ? eq(schema.paymentMatches.tenantId, tenantId) : undefined)
      .orderBy(desc(schema.paymentMatches.createdAt));
    return { items: rows.map(normalizeMatchEvidence) };
  }

  async recordManual(
    principal: PlatformPrincipal,
    invoiceId: string,
    input: ManualPaymentDto,
  ): Promise<ManualBillingPaymentServiceResultSource> {
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
          existing.source === "manual" &&
          existing.importRowId === null &&
          existing.currency === "RUB" &&
          existing.amount === input.amount &&
          existing.bankReference === input.bankReference &&
          existing.paidAt.getTime() === input.paidAt.getTime()
        ) {
          await tx.execute(sql`select id from invoices where id = ${invoiceId} for update`);
          const [invoice] = await tx
            .select()
            .from(schema.invoices)
            .where(eq(schema.invoices.id, invoiceId))
            .limit(1);
          if (!invoice) throw new NotFoundException({ code: "invoice_not_found" });
          const confirmedPayments = await tx
            .select()
            .from(schema.billingPayments)
            .where(
              and(
                eq(schema.billingPayments.tenantId, invoice.tenantId),
                eq(schema.billingPayments.invoiceId, invoiceId),
              ),
            );
          return paymentResult(existing, invoice.total, confirmedPayments);
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
      if (invoice.status !== "issued" && invoice.status !== "partially_paid")
        throw new ConflictException({
          code:
            invoice.status === "cancelled"
              ? "invoice_cancelled"
              : invoice.status === "paid"
                ? "invoice_already_paid"
                : "invoice_not_issued",
        });
      const confirmedPayments = await tx
        .select()
        .from(schema.billingPayments)
        .where(
          and(
            eq(schema.billingPayments.tenantId, invoice.tenantId),
            eq(schema.billingPayments.invoiceId, invoiceId),
          ),
        );
      const total = cents(invoice.total);
      const confirmedBefore = confirmedPayments.reduce(
        (sum, payment) => sum + cents(payment.amount),
        0n,
      );
      const remainingBefore = total - confirmedBefore;
      const paymentAmount = cents(input.amount);
      if (paymentAmount > remainingBefore) {
        throw new ConflictException({ code: "payment_amount_exceeds_remaining" });
      }
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
      const confirmedAfter = confirmedBefore + paymentAmount;
      const invoiceStatus = confirmedAfter === total ? "paid" : "partially_paid";
      await tx
        .update(schema.invoices)
        .set({
          status: invoiceStatus,
          paidAt: invoiceStatus === "paid" ? input.paidAt : null,
        })
        .where(eq(schema.invoices.id, invoiceId));
      let lines: Array<typeof schema.invoiceLines.$inferSelect> = [];
      if (invoiceStatus === "paid") {
        lines = await tx
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
          invoiceStatus,
          confirmedAmount: money(confirmedAfter),
          remainingAmount: money(total - confirmedAfter),
          applicationMode: invoice.applicationMode,
          lineCount: lines.length,
        },
        requestId: null,
      });
      return {
        ...payment,
        source: "manual",
        importRowId: null,
        currency: "RUB",
        invoiceStatus,
        confirmedAmount: money(confirmedAfter),
        remainingAmount: money(total - confirmedAfter),
      };
    });
  }

  async importFile(
    principal: PlatformPrincipal,
    input: ImportBankFileDto,
  ): Promise<PaymentImportServiceResultSource> {
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
        if (created) {
          const number = row.paymentPurpose?.match(/INV-\d{6}/)?.[0];
          const [invoice] = number
            ? await tx
                .select()
                .from(schema.invoices)
                .where(eq(schema.invoices.number, number))
                .limit(1)
            : [];
          const [account] =
            invoice && row.payerAccount
              ? await tx
                  .select()
                  .from(schema.tenantBankAccounts)
                  .where(
                    and(
                      eq(schema.tenantBankAccounts.tenantId, invoice.tenantId),
                      eq(schema.tenantBankAccounts.settlementAccount, row.payerAccount),
                    ),
                  )
                  .limit(1)
              : [];
          const evidence = payerEvidence(row.payerAccount, account);
          const classification = classifyImportedMatch(invoice !== undefined, account, evidence);
          await tx.insert(schema.paymentMatches).values({
            importRowId: created.id,
            tenantId: invoice?.tenantId ?? null,
            invoiceId: invoice?.id ?? null,
            tenantBankAccountId: account?.id ?? null,
            payerAccountEvidence: evidence,
            ...classification,
          });
        }
      }
      const [updated] = await tx
        .update(schema.paymentImports)
        .set({ status: "ready", rowCount: rows.length, errorCount: errors })
        .where(eq(schema.paymentImports.id, record.id))
        .returning();
      if (!updated) throw new BadRequestException({ code: "payment_import_failed" });
      return updated;
    });
  }

  async resolveMatch(
    principal: PlatformPrincipal,
    matchId: string,
    input: PaymentMatchResolveDto,
  ): Promise<PaymentMatchServiceSource> {
    return this.db.transaction(async (tx) => {
      const [match] = await tx
        .select()
        .from(schema.paymentMatches)
        .where(eq(schema.paymentMatches.id, matchId))
        .for("update")
        .limit(1);
      if (!match) throw new NotFoundException({ code: "payment_match_not_found" });
      const [row] = await tx
        .select()
        .from(schema.paymentImportRows)
        .where(eq(schema.paymentImportRows.id, match.importRowId))
        .limit(1);
      if (!row) throw new NotFoundException({ code: "payment_import_row_not_found" });

      if (match.status === "matched" || match.status === "rejected") {
        const isExactRetry =
          match.status === input.decision &&
          match.reason === input.reason &&
          (input.decision === "rejected" ||
            (match.tenantId === input.tenantId &&
              match.invoiceId === input.invoiceId &&
              match.tenantBankAccountId === input.tenantBankAccountId));
        if (!isExactRetry) {
          throw new ConflictException({ code: "payment_match_already_decided" });
        }
        const invoiceNumber = await invoiceNumberFor(tx, match.invoiceId);
        return matchSource(match, row, invoiceNumber);
      }

      if (input.decision === "rejected") {
        const [updated] = await tx
          .update(schema.paymentMatches)
          .set({
            status: "rejected",
            reason: input.reason,
            decidedByPlatformUserId: principal.userId,
            decidedAt: new Date(),
          })
          .where(eq(schema.paymentMatches.id, matchId))
          .returning();
        if (!updated) throw new ConflictException({ code: "payment_match_update_failed" });
        await this.audit.record(tx, {
          actorPlatformUserId: principal.userId,
          actorRole: principal.role,
          action: "billing.payment_match.resolved",
          outcome: "success",
          tenantId: updated.tenantId,
          targetType: "payment_match",
          targetId: matchId,
          reason: input.reason,
          before: { status: match.status },
          after: {
            status: "rejected",
            tenantBankAccountId: updated.tenantBankAccountId,
          },
          requestId: null,
        });
        const invoiceNumber = await invoiceNumberFor(tx, updated.invoiceId);
        return matchSource(updated, row, invoiceNumber);
      }

      const [invoice] = await tx
        .select()
        .from(schema.invoices)
        .where(
          and(
            eq(schema.invoices.id, input.invoiceId),
            eq(schema.invoices.tenantId, input.tenantId),
          ),
        )
        .for("update")
        .limit(1);
      if (!invoice) throw new NotFoundException({ code: "invoice_not_found" });
      if (
        invoice.status !== "issued" &&
        invoice.status !== "partially_paid" &&
        invoice.status !== "paid"
      ) {
        throw new ConflictException({ code: "invoice_not_issued" });
      }
      if (!row.amount || row.currency !== "RUB" || !row.operationDate || !row.bankReference) {
        throw new ConflictException({ code: "payment_match_evidence_incomplete" });
      }

      const [selectedAccount] = input.tenantBankAccountId
        ? await tx
            .select()
            .from(schema.tenantBankAccounts)
            .where(
              and(
                eq(schema.tenantBankAccounts.tenantId, input.tenantId),
                eq(schema.tenantBankAccounts.id, input.tenantBankAccountId),
              ),
            )
            .for("update")
            .limit(1)
        : [];
      if (input.tenantBankAccountId && !selectedAccount) {
        throw new NotFoundException({ code: "billing_account_not_found" });
      }
      const evidence = selectedAccount
        ? payerEvidence(selectedAccount.settlementAccount, selectedAccount)
        : evidenceFromUnknown(match.payerAccountEvidence);

      const [existingPayment] = await tx
        .select()
        .from(schema.billingPayments)
        .where(eq(schema.billingPayments.importRowId, row.id))
        .limit(1);
      if (!existingPayment) {
        const confirmedPayments = await tx
          .select()
          .from(schema.billingPayments)
          .where(
            and(
              eq(schema.billingPayments.tenantId, input.tenantId),
              eq(schema.billingPayments.invoiceId, input.invoiceId),
            ),
          );
        const total = cents(invoice.total);
        const confirmedBefore = confirmedPayments.reduce(
          (sum, payment) => sum + cents(payment.amount),
          0n,
        );
        const paymentAmount = cents(row.amount);
        if (paymentAmount > total - confirmedBefore) {
          throw new ConflictException({ code: "payment_amount_exceeds_remaining" });
        }
        const [payment] = await tx
          .insert(schema.billingPayments)
          .values({
            tenantId: input.tenantId,
            invoiceId: input.invoiceId,
            source: "bank_import",
            paidAt: row.operationDate,
            amount: row.amount,
            bankReference: row.bankReference,
            importRowId: row.id,
            platformUserId: principal.userId,
            idempotencyKey: `bank-import:${row.id}`,
          })
          .returning();
        if (!payment) throw new ConflictException({ code: "payment_recording_failed" });
        const confirmedAfter = confirmedBefore + paymentAmount;
        const invoiceStatus = confirmedAfter === total ? "paid" : "partially_paid";
        await tx
          .update(schema.invoices)
          .set({
            status: invoiceStatus,
            paidAt: invoiceStatus === "paid" ? row.operationDate : null,
          })
          .where(eq(schema.invoices.id, input.invoiceId));
        if (invoiceStatus === "paid") {
          const lines = await tx
            .select()
            .from(schema.invoiceLines)
            .where(eq(schema.invoiceLines.invoiceId, input.invoiceId));
          if (lines.length > 0) {
            await tx.insert(schema.invoiceApplicationEvents).values(
              lines.map((line) => ({
                tenantId: input.tenantId,
                invoiceId: input.invoiceId,
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
          if (invoice.applicationMode === "automatic") {
            await this.application.applyAutomaticInTransaction(
              tx,
              principal,
              { ...invoice, status: "paid", paidAt: row.operationDate },
              payment,
              lines,
            );
          }
        }
      } else if (
        existingPayment.invoiceId !== input.invoiceId ||
        existingPayment.tenantId !== input.tenantId
      ) {
        throw new ConflictException({ code: "payment_import_row_already_used" });
      }

      const [updated] = await tx
        .update(schema.paymentMatches)
        .set({
          tenantId: input.tenantId,
          invoiceId: input.invoiceId,
          tenantBankAccountId: selectedAccount?.id ?? null,
          payerAccountEvidence: evidence,
          status: "matched",
          score: 100,
          reason: input.reason,
          decidedByPlatformUserId: principal.userId,
          decidedAt: new Date(),
        })
        .where(eq(schema.paymentMatches.id, matchId))
        .returning();
      if (!updated) throw new ConflictException({ code: "payment_match_update_failed" });
      await this.audit.record(tx, {
        actorPlatformUserId: principal.userId,
        actorRole: principal.role,
        action: "billing.payment_match.resolved",
        outcome: "success",
        tenantId: input.tenantId,
        targetType: "payment_match",
        targetId: matchId,
        reason: input.reason,
        before: { status: match.status },
        after: {
          status: "matched",
          invoiceId: input.invoiceId,
          tenantBankAccountId: selectedAccount?.id ?? null,
          payerAccountLast4: evidence.last4,
          knownAccount: evidence.kind === "known",
        },
        requestId: null,
      });
      return matchSource(updated, row, invoice.number);
    });
  }
}

function parseRows(content: string) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const header = (lines.shift() ?? "")
    .split(/[;,]/)
    .slice(0, 100)
    .map((value) => value.trim().toLowerCase().slice(0, 100));
  return lines.map((line, index) => {
    const values = line
      .split(/[;,]/)
      .slice(0, 100)
      .map((value) => value.trim().slice(0, 5_000));
    const get = (...names: string[]) =>
      values[header.findIndex((key) => names.includes(key))] ?? "";
    const amount = get("amount", "сумма").slice(0, 100);
    const operationDate = get("date", "operation_date", "дата").slice(0, 100);
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
      currency: get("currency", "валюта").slice(0, 10) || "RUB",
      payerName: get("payer", "payer_name", "плательщик").slice(0, 1_000) || null,
      paymentPurpose: get("purpose", "payment_purpose", "назначение").slice(0, 5_000) || null,
      bankReference: get("reference", "bank_reference", "номер").slice(0, 1_000) || null,
      payerAccount:
        get("payer_account", "account", "счет_плательщика", "счёт_плательщика").slice(0, 100) ||
        null,
      rawFields: Object.fromEntries(
        header.map((key, i) => [key || `column_${i + 1}`, values[i] ?? ""]),
      ),
      parseError,
    };
  });
}

type TenantAccount = typeof schema.tenantBankAccounts.$inferSelect;
type PaymentMatchRow = typeof schema.paymentMatches.$inferSelect;
type PaymentImportRow = typeof schema.paymentImportRows.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

function cents(value: string): bigint {
  const [whole = "0", fraction = "00"] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function money(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

function paymentResult(
  payment: typeof schema.billingPayments.$inferSelect,
  invoiceTotal: string,
  confirmedPayments: Array<typeof schema.billingPayments.$inferSelect>,
): ManualBillingPaymentServiceResultSource {
  const total = cents(invoiceTotal);
  const confirmed = confirmedPayments.reduce((sum, row) => sum + cents(row.amount), 0n);
  const remaining = total - confirmed;
  return {
    ...payment,
    source: "manual",
    importRowId: null,
    currency: "RUB",
    invoiceStatus: remaining === 0n ? "paid" : confirmed === 0n ? "issued" : "partially_paid",
    confirmedAmount: money(confirmed),
    remainingAmount: money(remaining),
  };
}

function payerEvidence(payerAccount: string | null, account?: TenantAccount): PayerAccountEvidence {
  if (account) {
    return {
      kind: "known",
      last4: account.settlementAccount.slice(-4),
      accountStatus: account.status,
      label: account.label,
    };
  }
  return payerAccount && /^\d{20}$/.test(payerAccount)
    ? { kind: "unknown", last4: payerAccount.slice(-4) }
    : { kind: "unavailable", last4: null };
}

function evidenceFromUnknown(value: unknown): PayerAccountEvidence {
  const parsed = payerAccountEvidenceSchema.safeParse(value);
  if (parsed.success && parsed.data.kind !== "known") return parsed.data;
  throw new ConflictException({ code: "payment_match_unknown_account_evidence_required" });
}

function classifyImportedMatch(
  invoiceFound: boolean,
  account: TenantAccount | undefined,
  evidence: PayerAccountEvidence,
) {
  if (!invoiceFound) {
    return { status: "unmatched" as const, score: 0, reason: "invoice_not_found" };
  }
  if (account?.status === "active") {
    return {
      status: "suggested" as const,
      score: 100,
      reason: "invoice_and_active_payer_account",
    };
  }
  return {
    status: "needs_review" as const,
    score: account ? 90 : 80,
    reason:
      account?.status === "archived"
        ? "archived_payer_account"
        : evidence.kind === "unavailable"
          ? "payer_account_unavailable"
          : "unknown_payer_account",
  };
}

function normalizeMatchEvidence<T extends { payerAccountEvidence: unknown }>(row: T) {
  const parsed = payerAccountEvidenceSchema.safeParse(row.payerAccountEvidence);
  return { ...row, payerAccountEvidence: parsed.success ? parsed.data : null };
}

function matchSource(
  match: PaymentMatchRow,
  row: PaymentImportRow,
  invoiceNumber: string | null,
): PaymentMatchServiceSource {
  return normalizeMatchEvidence({
    ...match,
    importId: row.importId,
    importRowId: row.id,
    sourceRowId: row.sourceRowId,
    operationDate: row.operationDate,
    amount: row.amount,
    currency: row.currency,
    payerName: row.payerName,
    paymentPurpose: row.paymentPurpose,
    bankReference: row.bankReference,
    invoiceNumber,
  });
}

async function invoiceNumberFor(tx: DbTransaction, invoiceId: string | null) {
  if (!invoiceId) return null;
  const [invoice] = await tx
    .select({ number: schema.invoices.number })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId))
    .limit(1);
  return invoice?.number ?? null;
}
