import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type { InvoiceApplicationResultSource as InvoiceApplicationResult } from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { SubscriptionLifecycleService } from "../../subscriptions/subscription-lifecycle.service";
import type { ApplyInvoiceDto } from "./dto";

type BillingTransaction = Parameters<Db["transaction"]>[0] extends (arg: infer T) => unknown
  ? T
  : never;
type Invoice = typeof schema.invoices.$inferSelect;
type InvoiceLine = typeof schema.invoiceLines.$inferSelect;
type BillingPayment = typeof schema.billingPayments.$inferSelect;
type ActivationPolicy = "immediate" | "after_current";
type ApplySelection = { lineId: string; activationPolicy?: ActivationPolicy };

@Injectable()
export class BillingApplicationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly lifecycle: SubscriptionLifecycleService,
    private readonly audit: PlatformAuditService,
  ) {}

  async apply(
    principal: PlatformPrincipal,
    invoiceId: string,
    input: ApplyInvoiceDto,
  ): Promise<InvoiceApplicationResult> {
    return this.db.transaction(async (tx) => {
      const invoice = await this.requirePaidInvoice(tx, invoiceId);
      const [payment] = await tx
        .select()
        .from(schema.billingPayments)
        .where(
          and(
            eq(schema.billingPayments.tenantId, invoice.tenantId),
            eq(schema.billingPayments.invoiceId, invoice.id),
          ),
        )
        .limit(1);
      if (!payment) throw new ConflictException({ code: "invoice_payment_missing" });

      const selectedIds = input.lines.map((line) => line.lineId);
      const lines = await tx
        .select()
        .from(schema.invoiceLines)
        .where(
          and(
            eq(schema.invoiceLines.invoiceId, invoiceId),
            inArray(schema.invoiceLines.id, selectedIds),
          ),
        );
      if (lines.length !== new Set(selectedIds).size) {
        throw new BadRequestException({ code: "invoice_application_line_invalid" });
      }
      const selections = new Map<string, ApplySelection>(
        input.lines.map((line) => [
          line.lineId,
          {
            lineId: line.lineId,
            ...(line.activationPolicy ? { activationPolicy: line.activationPolicy } : {}),
          },
        ]),
      );
      return this.applyLinesInTransaction(
        tx,
        principal,
        invoice,
        payment,
        orderForApplication(lines),
        selections,
        "manual",
        input.reason,
      );
    });
  }

  async applyAutomaticInTransaction(
    tx: BillingTransaction,
    principal: PlatformPrincipal,
    invoice: Invoice,
    payment: BillingPayment,
    lines: InvoiceLine[],
  ): Promise<InvoiceApplicationResult> {
    const automaticLines = lines.filter(
      (line) =>
        line.kind === "service" || line.kind === "custom" || line.activationPolicy !== "manual",
    );
    const selections = new Map<string, ApplySelection>(
      automaticLines.map((line) => [
        line.id,
        {
          lineId: line.id,
          ...(line.activationPolicy === "immediate" || line.activationPolicy === "after_current"
            ? { activationPolicy: line.activationPolicy }
            : {}),
        },
      ]),
    );
    return this.applyLinesInTransaction(
      tx,
      principal,
      invoice,
      payment,
      orderForApplication(automaticLines),
      selections,
      "payment",
      `invoice:${invoice.number}`,
    );
  }

  private async requirePaidInvoice(tx: BillingTransaction, invoiceId: string): Promise<Invoice> {
    await tx.execute(sql`select id from invoices where id = ${invoiceId} for update`);
    const [invoice] = await tx
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, invoiceId))
      .limit(1);
    if (!invoice) throw new NotFoundException({ code: "invoice_not_found" });
    if (invoice.status !== "paid") throw new ConflictException({ code: "invoice_not_paid" });
    return invoice;
  }

  private async applyLinesInTransaction(
    tx: BillingTransaction,
    principal: PlatformPrincipal,
    invoice: Invoice,
    payment: BillingPayment,
    lines: InvoiceLine[],
    selections: Map<string, ApplySelection>,
    source: "manual" | "payment",
    reason: string,
  ): Promise<InvoiceApplicationResult> {
    const results: InvoiceApplicationResult["results"] = [];
    for (const line of lines) {
      const selection = selections.get(line.id);
      if (!selection) continue;
      const [previous] = await tx
        .select()
        .from(schema.invoiceApplicationEvents)
        .where(
          and(
            eq(schema.invoiceApplicationEvents.tenantId, invoice.tenantId),
            eq(schema.invoiceApplicationEvents.invoiceLineId, line.id),
          ),
        )
        .orderBy(desc(schema.invoiceApplicationEvents.attempt))
        .limit(1);
      if (previous?.status === "applied") {
        results.push({
          lineId: line.id,
          attempt: previous.attempt,
          status: "skipped",
          kind: line.kind,
          result: previous.afterSnapshot,
          errorCode: null,
        });
        continue;
      }
      const attempt = previous ? previous.attempt + (previous.status === "failed" ? 1 : 0) : 1;
      const activationPolicy = resolveActivationPolicy(line, selection);
      try {
        const result = await this.applyLine(
          tx,
          principal,
          invoice,
          payment,
          line,
          activationPolicy,
          reason,
        );
        await this.writeApplicationEvent(tx, {
          previous,
          invoice,
          line,
          principal,
          attempt,
          status: "applied",
          source,
          result,
          errorCode: null,
        });
        await this.audit.record(tx, {
          actorPlatformUserId: principal.userId,
          actorRole: principal.role,
          action: "billing.invoice.line_applied",
          outcome: "success",
          tenantId: invoice.tenantId,
          targetType: "invoice_line",
          targetId: line.id,
          reason,
          before: { applicationStatus: previous?.status ?? null },
          after: { applicationStatus: "applied", kind: line.kind, result },
          requestId: null,
        });
        results.push({
          lineId: line.id,
          attempt,
          status: "applied",
          kind: line.kind,
          result,
          errorCode: null,
        });
      } catch (error) {
        if (!isExpectedApplicationError(error)) throw error;
        const response = error.getResponse();
        const errorCode =
          typeof response === "object" && response !== null && "code" in response
            ? String(response.code)
            : "application_conflict";
        await this.writeApplicationEvent(tx, {
          previous,
          invoice,
          line,
          principal,
          attempt,
          status: "failed",
          source,
          result: null,
          errorCode,
        });
        await this.audit.record(tx, {
          actorPlatformUserId: principal.userId,
          actorRole: principal.role,
          action: "billing.invoice.line_applied",
          outcome: "failed",
          tenantId: invoice.tenantId,
          targetType: "invoice_line",
          targetId: line.id,
          reason,
          before: { applicationStatus: previous?.status ?? null },
          after: { applicationStatus: "failed", kind: line.kind, errorCode },
          requestId: null,
        });
        results.push({
          lineId: line.id,
          attempt,
          status: "failed",
          kind: line.kind,
          result: null,
          errorCode,
        });
      }
    }
    const status = await this.applicationStatus(tx, invoice);
    await this.audit.record(tx, {
      actorPlatformUserId: principal.userId,
      actorRole: principal.role,
      action: "billing.invoice.application_processed",
      outcome: status === "partial_failure" ? "failed" : "success",
      tenantId: invoice.tenantId,
      targetType: "invoice",
      targetId: invoice.id,
      reason,
      before: { source, selectedLineIds: lines.map((line) => line.id) },
      after: {
        applicationStatus: status,
        results: results.map((result) => ({
          lineId: result.lineId,
          attempt: result.attempt,
          status: result.status,
          kind: result.kind,
          resultId: resultIdentifier(result.result),
          errorCode: result.errorCode,
        })),
      },
      requestId: null,
    });
    return {
      invoiceId: invoice.id,
      status,
      results,
    };
  }

  private async applicationStatus(
    tx: BillingTransaction,
    invoice: Invoice,
  ): Promise<InvoiceApplicationResult["status"]> {
    const lines = await tx
      .select({ id: schema.invoiceLines.id })
      .from(schema.invoiceLines)
      .where(eq(schema.invoiceLines.invoiceId, invoice.id));
    const events = await tx
      .select()
      .from(schema.invoiceApplicationEvents)
      .where(
        and(
          eq(schema.invoiceApplicationEvents.tenantId, invoice.tenantId),
          eq(schema.invoiceApplicationEvents.invoiceId, invoice.id),
        ),
      )
      .orderBy(desc(schema.invoiceApplicationEvents.attempt));
    const latest = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      if (!latest.has(event.invoiceLineId)) latest.set(event.invoiceLineId, event);
    }
    const current = lines.flatMap((line) => {
      const event = latest.get(line.id);
      return event ? [event] : [];
    });
    if (current.some((event) => event.status === "failed")) return "partial_failure";
    if (current.length < lines.length || current.some((event) => event.status === "pending")) {
      return "pending";
    }
    return "applied";
  }

  private async applyLine(
    tx: BillingTransaction,
    principal: PlatformPrincipal,
    invoice: Invoice,
    payment: BillingPayment,
    line: InvoiceLine,
    activationPolicy: ActivationPolicy | undefined,
    reason: string,
  ): Promise<unknown> {
    if (line.kind === "plan") {
      if (!line.catalogVersionId) throw new ConflictException({ code: "catalog_version_missing" });
      if (!activationPolicy) throw new ConflictException({ code: "activation_policy_required" });
      return this.lifecycle.assignPaidInvoicePlan(tx, principal, invoice.tenantId, {
        catalogVersionId: line.catalogVersionId,
        activationPolicy,
        reason,
        sourceInvoiceLineId: line.id,
      });
    }
    if (line.kind === "addon") {
      if (!line.catalogVersionId) throw new ConflictException({ code: "catalog_version_missing" });
      if (!activationPolicy) throw new ConflictException({ code: "activation_policy_required" });
      const targetStatuses =
        activationPolicy === "after_current"
          ? (["scheduled"] as const)
          : (["active", "trial", "pending_activation"] as const);
      const [target] = await tx
        .select({ id: schema.tenantSubscriptions.id })
        .from(schema.tenantSubscriptions)
        .where(
          and(
            eq(schema.tenantSubscriptions.tenantId, invoice.tenantId),
            inArray(schema.tenantSubscriptions.status, targetStatuses),
          ),
        )
        .orderBy(desc(schema.tenantSubscriptions.updatedAt))
        .limit(1);
      if (!target) throw new ConflictException({ code: "subscription_target_missing" });
      return this.lifecycle.assignPaidInvoiceAddon(tx, principal, invoice.tenantId, {
        catalogVersionId: line.catalogVersionId,
        expectedSubscriptionId: target.id,
        quantity: line.quantity,
        activationPolicy,
        reason,
        sourceInvoiceLineId: line.id,
      });
    }
    if (line.kind === "service") {
      const [ordered] = await tx
        .insert(schema.orderedServices)
        .values({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          invoiceLineId: line.id,
          billingPaymentId: payment.id,
          catalogVersionId: line.catalogVersionId,
          nameRu: line.nameRu,
          nameEn: line.nameEn,
          descriptionRu: line.descriptionRu,
          descriptionEn: line.descriptionEn,
          quantity: line.quantity,
          unit: line.unit,
          orderedAt: payment.paidAt,
        })
        .returning();
      if (!ordered) throw new ConflictException({ code: "ordered_service_creation_failed" });
      return ordered;
    }
    return { kind: "custom", entitlementApplied: false };
  }

  private async writeApplicationEvent(
    tx: BillingTransaction,
    input: {
      previous: typeof schema.invoiceApplicationEvents.$inferSelect | undefined;
      invoice: Invoice;
      line: InvoiceLine;
      principal: PlatformPrincipal;
      attempt: number;
      status: "applied" | "failed";
      source: "manual" | "payment";
      result: unknown;
      errorCode: string | null;
    },
  ): Promise<void> {
    const values = {
      status: input.status,
      source: input.source,
      afterSnapshot: input.result,
      errorCode: input.errorCode,
      actorPlatformUserId: input.principal.userId,
    } as const;
    if (input.previous?.status === "pending") {
      await tx
        .update(schema.invoiceApplicationEvents)
        .set(values)
        .where(eq(schema.invoiceApplicationEvents.id, input.previous.id));
      return;
    }
    await tx.insert(schema.invoiceApplicationEvents).values({
      tenantId: input.invoice.tenantId,
      invoiceId: input.invoice.id,
      invoiceLineId: input.line.id,
      attempt: input.attempt,
      status: input.status,
      kind: input.line.kind,
      source: input.source,
      beforeSnapshot: null,
      afterSnapshot: input.result,
      errorCode: input.errorCode,
      actorPlatformUserId: input.principal.userId,
    });
  }
}

function resolveActivationPolicy(
  line: InvoiceLine,
  selection: ApplySelection,
): ActivationPolicy | undefined {
  if (line.kind !== "plan" && line.kind !== "addon") {
    if (selection.activationPolicy) {
      throw new BadRequestException({ code: "invoice_application_policy_not_allowed" });
    }
    return undefined;
  }
  if (line.activationPolicy === "manual") {
    if (!selection.activationPolicy) {
      throw new BadRequestException({ code: "activation_policy_required" });
    }
    return selection.activationPolicy;
  }
  if (line.activationPolicy !== "immediate" && line.activationPolicy !== "after_current") {
    throw new ConflictException({ code: "activation_policy_missing" });
  }
  if (selection.activationPolicy && selection.activationPolicy !== line.activationPolicy) {
    throw new BadRequestException({ code: "invoice_activation_policy_frozen" });
  }
  return line.activationPolicy;
}

function resultIdentifier(result: unknown): string | null {
  if (typeof result !== "object" || result === null || !("id" in result)) return null;
  return typeof result.id === "string" ? result.id : null;
}

function orderForApplication(lines: InvoiceLine[]): InvoiceLine[] {
  const priority: Record<InvoiceLine["kind"], number> = {
    plan: 0,
    addon: 1,
    service: 2,
    custom: 3,
  };
  return [...lines].sort(
    (left, right) => priority[left.kind] - priority[right.kind] || left.position - right.position,
  );
}

function isExpectedApplicationError(
  error: unknown,
): error is BadRequestException | ConflictException | NotFoundException {
  return (
    error instanceof BadRequestException ||
    error instanceof ConflictException ||
    error instanceof NotFoundException
  );
}
