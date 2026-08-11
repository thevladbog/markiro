import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { SubscriptionLifecycleService } from "../../subscriptions/subscription-lifecycle.service";

@Injectable()
export class BillingApplicationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly lifecycle: SubscriptionLifecycleService,
  ) {}

  async apply(principal: PlatformPrincipal, invoiceId: string) {
    const [invoice] = await this.db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).limit(1);
    if (!invoice) throw new NotFoundException({ code: "invoice_not_found" });
    if (invoice.status !== "paid") throw new ConflictException({ code: "invoice_not_paid" });
    const lines = await this.db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId)).orderBy(schema.invoiceLines.position);
    const results: Array<{ lineId: string; status: string; result?: unknown }> = [];
    for (const line of lines) {
      const [previous] = await this.db.select().from(schema.invoiceApplicationEvents).where(and(eq(schema.invoiceApplicationEvents.invoiceLineId, line.id), eq(schema.invoiceApplicationEvents.status, "applied"))).limit(1);
      if (previous) {
        results.push({ lineId: line.id, status: "skipped" });
        continue;
      }
      try {
        let result: unknown = null;
        if (line.kind === "plan" && line.catalogVersionId) {
          result = await this.lifecycle.assignPlan(principal, invoice.tenantId, {
            catalogVersionId: line.catalogVersionId,
            activationPolicy: line.activationPolicy === "after_current" ? "after_current" : "immediate",
            reason: `invoice:${invoice.number}`,
          });
        } else if (line.kind === "addon" && line.catalogVersionId) {
          const statuses = line.activationPolicy === "after_current" ? ["scheduled"] : ["active", "trial", "pending_activation"];
          const [target] = await this.db.select({ id: schema.tenantSubscriptions.id }).from(schema.tenantSubscriptions).where(and(eq(schema.tenantSubscriptions.tenantId, invoice.tenantId), inArray(schema.tenantSubscriptions.status, statuses as never[]))).orderBy(desc(schema.tenantSubscriptions.updatedAt)).limit(1);
          if (!target) throw new ConflictException({ code: "subscription_target_missing" });
          result = await this.lifecycle.assignAddon(principal, invoice.tenantId, {
            catalogVersionId: line.catalogVersionId,
            expectedSubscriptionId: target.id,
            quantity: line.quantity,
            activationPolicy: line.activationPolicy === "after_current" ? "after_current" : "immediate",
            reason: `invoice:${invoice.number}`,
          });
        }
        await this.db.insert(schema.invoiceApplicationEvents).values({ tenantId: invoice.tenantId, invoiceId, invoiceLineId: line.id, attempt: 1, status: "applied", kind: line.kind, source: "manual", beforeSnapshot: null, afterSnapshot: result, errorCode: null, actorPlatformUserId: principal.userId });
        results.push({ lineId: line.id, status: "applied", result });
      } catch (error) {
        const code = error instanceof ConflictException ? ((error.getResponse() as { code?: string }).code ?? "application_conflict") : "application_failed";
        await this.db.insert(schema.invoiceApplicationEvents).values({ tenantId: invoice.tenantId, invoiceId, invoiceLineId: line.id, attempt: 1, status: "failed", kind: line.kind, source: "manual", beforeSnapshot: null, afterSnapshot: null, errorCode: code, actorPlatformUserId: principal.userId });
        results.push({ lineId: line.id, status: "failed" });
      }
    }
    return { invoiceId, results };
  }
}
