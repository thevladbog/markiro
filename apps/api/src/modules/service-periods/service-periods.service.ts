import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, or, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import type {
  ServiceExcessApprovalPostInput,
  ServiceExcessApprovalWithdrawalInput,
  ServicePeriodListQuery,
  ServicePeriodMutationResult,
  ServiceUsageCorrectionInput,
  ServiceUsagePostInput,
} from "./dto";
import { lockServiceNamespace } from "./service-period-locks";
import {
  listServicePeriods,
  readServiceBalance,
  readServicePeriodDetail,
} from "./service-period-read-model";
import { readServiceRequestReplay, serviceRequestHash } from "./service-period-request-replay";
import { ServicePeriodObservability } from "./service-period-observability";
import type { ServiceLedgerEvent } from "./service-period-observability";
import { postgresUniqueConstraint } from "../billing-workflow-locks";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Period = typeof schema.servicePeriods.$inferSelect;

@Injectable()
export class ServicePeriodsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
    private readonly observability: ServicePeriodObservability = new ServicePeriodObservability(),
  ) {}

  list(_principal: PlatformPrincipal, query: ServicePeriodListQuery) {
    return listServicePeriods(this.db, query);
  }

  detail(_principal: PlatformPrincipal, id: string) {
    return readServicePeriodDetail(this.db, id);
  }

  async postUsage(
    principal: PlatformPrincipal,
    periodId: string,
    input: ServiceUsagePostInput,
  ): Promise<ServicePeriodMutationResult> {
    let remainingMinutes = 0;
    try {
      return await this.observeMutation(
        this.mutate(
          principal,
          periodId,
          "usage",
          input,
          async (tx, period, requestHash) => {
            const performedAt = new Date(input.performedAt);
            assertPerformedInsidePeriod(performedAt, period);
            const balance = await readServiceBalance(tx, period);
            remainingMinutes = balance.remaining;
            if (input.allowanceMinutes > balance.remaining) {
              throw new ConflictException({ code: "SERVICE_ALLOWANCE_EXCEEDED" });
            }
            const response = mutationResult(period, balance, {
              consumed: input.allowanceMinutes,
            });
            const [entry] = await tx
              .insert(schema.serviceUsageEntries)
              .values({
                tenantId: period.tenantId,
                servicePeriodId: period.id,
                kind: "usage",
                classification: input.classification,
                originalEntryId: null,
                workReference: input.workReference,
                description: input.description,
                internalNote: input.internalNote,
                actualMinutesDelta: input.actualMinutes,
                allowanceMinutesDelta: input.allowanceMinutes,
                performedAt,
                actorPlatformUserId: principal.userId,
                requestId: input.requestId,
                requestHash,
                response,
              })
              .returning({ id: schema.serviceUsageEntries.id });
            if (!entry) throw new Error("service usage insert failed");
            await this.advanceRevision(tx, period);
            await this.recordAudit(
              tx,
              principal,
              period,
              "service_period.usage_posted",
              entry.id,
              input.requestId,
              response,
              {
                balanceBefore: balance,
                actualMinutesDelta: input.actualMinutes,
                allowanceMinutesDelta: input.allowanceMinutes,
              },
            );
            return response;
          },
          undefined,
          async (tx, period) => {
            const balance = await readServiceBalance(tx, period);
            remainingMinutes = balance.remaining;
            if (input.allowanceMinutes > balance.remaining) {
              throw new ConflictException({ code: "SERVICE_ALLOWANCE_EXCEEDED" });
            }
          },
        ),
        {
          event: input.classification === "product_defect" ? "defect_work_posted" : "usage_posted",
          count: 1,
          periodId,
          actualMinutes: input.actualMinutes,
          allowanceMinutes: input.allowanceMinutes,
        },
      );
    } catch (error) {
      if (isConflictCode(error, "SERVICE_ALLOWANCE_EXCEEDED")) {
        this.observability.record({
          event: "allowance_blocked",
          count: 1,
          periodId,
          requestedMinutes: input.allowanceMinutes,
          remainingMinutes,
        });
      }
      throw error;
    }
  }

  correctUsage(
    principal: PlatformPrincipal,
    periodId: string,
    entryId: string,
    input: ServiceUsageCorrectionInput,
  ): Promise<ServicePeriodMutationResult> {
    return this.observeMutation(
      this.mutate(
        principal,
        periodId,
        "usage_correction",
        input,
        async (tx, period, requestHash) => {
          const rows = await tx
            .select()
            .from(schema.serviceUsageEntries)
            .where(
              and(
                eq(schema.serviceUsageEntries.tenantId, period.tenantId),
                eq(schema.serviceUsageEntries.servicePeriodId, period.id),
                or(
                  eq(schema.serviceUsageEntries.id, entryId),
                  eq(schema.serviceUsageEntries.originalEntryId, entryId),
                ),
              ),
            )
            .for("update");
          const original = rows.find((row) => row.id === entryId && row.kind === "usage");
          if (!original) throw new NotFoundException({ code: "SERVICE_USAGE_NOT_FOUND" });
          const originalActual = rows.reduce((sum, row) => sum + row.actualMinutesDelta, 0);
          const originalAllowance = rows.reduce((sum, row) => sum + row.allowanceMinutesDelta, 0);
          if (
            originalActual + input.actualMinutesDelta < 0 ||
            originalAllowance + input.allowanceMinutesDelta < 0
          ) {
            throw new ConflictException({ code: "SERVICE_CORRECTION_EXCEEDS_USAGE" });
          }
          if (
            input.classification === "product_defect" &&
            originalAllowance + input.allowanceMinutesDelta !== 0
          ) {
            throw new ConflictException({ code: "SERVICE_DEFECT_ALLOWANCE_INVALID" });
          }
          const balance = await readServiceBalance(tx, period);
          const nextConsumed = balance.consumed + input.allowanceMinutesDelta;
          if (nextConsumed < 0) {
            throw new ConflictException({ code: "SERVICE_CORRECTION_EXCEEDS_USAGE" });
          }
          if (nextConsumed > balance.included + balance.externallyApproved) {
            throw new ConflictException({ code: "SERVICE_ALLOWANCE_EXCEEDED" });
          }
          const response = mutationResult(period, balance, {
            consumed: input.allowanceMinutesDelta,
          });
          const [entry] = await tx
            .insert(schema.serviceUsageEntries)
            .values({
              tenantId: period.tenantId,
              servicePeriodId: period.id,
              kind: "correction",
              classification: input.classification,
              originalEntryId: original.id,
              workReference: original.workReference,
              description: input.description,
              internalNote: input.internalNote,
              actualMinutesDelta: input.actualMinutesDelta,
              allowanceMinutesDelta: input.allowanceMinutesDelta,
              performedAt: original.performedAt,
              actorPlatformUserId: principal.userId,
              requestId: input.requestId,
              requestHash,
              response,
            })
            .returning({ id: schema.serviceUsageEntries.id });
          if (!entry) throw new Error("service usage correction insert failed");
          await this.advanceRevision(tx, period);
          await this.recordAudit(
            tx,
            principal,
            period,
            "service_period.usage_corrected",
            entry.id,
            input.requestId,
            response,
            {
              balanceBefore: balance,
              originalEntryId: original.id,
              actualMinutesDelta: input.actualMinutesDelta,
              allowanceMinutesDelta: input.allowanceMinutesDelta,
            },
          );
          return response;
        },
        entryId,
      ),
      {
        event: "correction_posted",
        count: 1,
        periodId,
        actualMinutesDelta: input.actualMinutesDelta,
        allowanceMinutesDelta: input.allowanceMinutesDelta,
      },
    );
  }

  addApproval(
    principal: PlatformPrincipal,
    periodId: string,
    input: ServiceExcessApprovalPostInput,
  ): Promise<ServicePeriodMutationResult> {
    return this.observeMutation(
      this.mutate(principal, periodId, "approval", input, async (tx, period, requestHash) => {
        const balance = await readServiceBalance(tx, period);
        const response = mutationResult(period, balance, { approved: input.approvedMinutes });
        const [approval] = await tx
          .insert(schema.serviceExcessApprovals)
          .values({
            tenantId: period.tenantId,
            servicePeriodId: period.id,
            kind: "approval",
            originalApprovalId: null,
            minuteDelta: input.approvedMinutes,
            externalReference: input.externalReference,
            externalUrl: input.externalUrl,
            approvedAt: new Date(input.approvedAt),
            reason: input.reason,
            actorPlatformUserId: principal.userId,
            requestId: input.requestId,
            requestHash,
            response,
          })
          .returning({ id: schema.serviceExcessApprovals.id });
        if (!approval) throw new Error("service approval insert failed");
        await this.advanceRevision(tx, period);
        await this.recordAudit(
          tx,
          principal,
          period,
          "service_period.excess_approved",
          approval.id,
          input.requestId,
          response,
          { balanceBefore: balance, minuteDelta: input.approvedMinutes },
        );
        return response;
      }),
      { event: "excess_approved", count: 1, periodId, minuteDelta: input.approvedMinutes },
    );
  }

  withdrawApproval(
    principal: PlatformPrincipal,
    periodId: string,
    approvalId: string,
    input: ServiceExcessApprovalWithdrawalInput,
  ): Promise<ServicePeriodMutationResult> {
    return this.observeMutation(
      this.mutate(
        principal,
        periodId,
        "approval_withdrawal",
        input,
        async (tx, period, requestHash) => {
          const rows = await tx
            .select()
            .from(schema.serviceExcessApprovals)
            .where(
              and(
                eq(schema.serviceExcessApprovals.tenantId, period.tenantId),
                eq(schema.serviceExcessApprovals.servicePeriodId, period.id),
                or(
                  eq(schema.serviceExcessApprovals.id, approvalId),
                  eq(schema.serviceExcessApprovals.originalApprovalId, approvalId),
                ),
              ),
            )
            .for("update");
          const original = rows.find((row) => row.id === approvalId && row.kind === "approval");
          if (!original) throw new NotFoundException({ code: "SERVICE_APPROVAL_NOT_FOUND" });
          const available = rows.reduce((sum, row) => sum + row.minuteDelta, 0);
          if (input.withdrawnMinutes > available) {
            throw new ConflictException({ code: "SERVICE_WITHDRAWAL_EXCEEDS_APPROVAL" });
          }
          const balance = await readServiceBalance(tx, period);
          if (input.withdrawnMinutes > balance.remaining) {
            throw new ConflictException({ code: "SERVICE_ALLOWANCE_EXCEEDED" });
          }
          const response = mutationResult(period, balance, { approved: -input.withdrawnMinutes });
          const [withdrawal] = await tx
            .insert(schema.serviceExcessApprovals)
            .values({
              tenantId: period.tenantId,
              servicePeriodId: period.id,
              kind: "withdrawal",
              originalApprovalId: original.id,
              minuteDelta: -input.withdrawnMinutes,
              externalReference: input.externalReference,
              externalUrl: input.externalUrl,
              approvedAt: new Date(input.approvedAt),
              reason: input.reason,
              actorPlatformUserId: principal.userId,
              requestId: input.requestId,
              requestHash,
              response,
            })
            .returning({ id: schema.serviceExcessApprovals.id });
          if (!withdrawal) throw new Error("service approval withdrawal insert failed");
          await this.advanceRevision(tx, period);
          await this.recordAudit(
            tx,
            principal,
            period,
            "service_period.excess_withdrawn",
            withdrawal.id,
            input.requestId,
            response,
            {
              balanceBefore: balance,
              originalApprovalId: original.id,
              minuteDelta: -input.withdrawnMinutes,
            },
          );
          return response;
        },
        approvalId,
      ),
      { event: "approval_withdrawn", count: 1, periodId, minuteDelta: -input.withdrawnMinutes },
    );
  }

  private async mutate<T extends { requestId: string; expectedRevision: number }>(
    principal: PlatformPrincipal,
    periodId: string,
    operation: string,
    input: T,
    apply: (
      tx: Transaction,
      period: Period,
      requestHash: string,
    ) => Promise<ServicePeriodMutationResult>,
    targetId?: string,
    beforeRevision?: (tx: Transaction, period: Period) => Promise<void>,
  ): Promise<{ result: ServicePeriodMutationResult; created: boolean }> {
    try {
      return await this.db.transaction(async (tx) => {
        const [identity] = await tx
          .select({ tenantId: schema.servicePeriods.tenantId })
          .from(schema.servicePeriods)
          .where(eq(schema.servicePeriods.id, periodId))
          .limit(1);
        if (!identity) throw new NotFoundException({ code: "SERVICE_PERIOD_NOT_FOUND" });
        await lockServiceNamespace(tx, identity.tenantId);
        const [period] = await tx
          .select()
          .from(schema.servicePeriods)
          .where(
            and(
              eq(schema.servicePeriods.tenantId, identity.tenantId),
              eq(schema.servicePeriods.id, periodId),
            ),
          )
          .for("update")
          .limit(1);
        if (!period) throw new NotFoundException({ code: "SERVICE_PERIOD_NOT_FOUND" });
        const requestHash = serviceRequestHash({
          operation,
          periodId,
          targetId: targetId ?? null,
          input: JSON.parse(JSON.stringify(input)) as unknown,
        });
        const replay = await readServiceRequestReplay(
          tx,
          period.tenantId,
          input.requestId,
          requestHash,
        );
        if (replay) return { result: replay, created: false };
        await beforeRevision?.(tx, period);
        if (period.revision !== input.expectedRevision) {
          throw new ConflictException({
            code: "SERVICE_PERIOD_REVISION_CONFLICT",
            currentRevision: period.revision,
          });
        }
        return { result: await apply(tx, period, requestHash), created: true };
      });
    } catch (error) {
      const constraint = postgresUniqueConstraint(error);
      if (
        constraint === "service_usage_entries_tenant_request_id_uq" ||
        constraint === "service_excess_approvals_tenant_request_id_uq"
      ) {
        throw new ConflictException({ code: "SERVICE_REQUEST_CONFLICT" });
      }
      throw error;
    }
  }

  private async advanceRevision(tx: Transaction, period: Period): Promise<void> {
    const [updated] = await tx
      .update(schema.servicePeriods)
      .set({ revision: sql`${schema.servicePeriods.revision} + 1` })
      .where(
        and(
          eq(schema.servicePeriods.tenantId, period.tenantId),
          eq(schema.servicePeriods.id, period.id),
          eq(schema.servicePeriods.revision, period.revision),
        ),
      )
      .returning({ revision: schema.servicePeriods.revision });
    if (!updated || updated.revision !== period.revision + 1) {
      throw new ConflictException({ code: "SERVICE_PERIOD_REVISION_CONFLICT" });
    }
  }

  private async observeMutation(
    operation: Promise<{ result: ServicePeriodMutationResult; created: boolean }>,
    event: ServiceLedgerEvent,
  ): Promise<ServicePeriodMutationResult> {
    const outcome = await operation;
    if (outcome.created) this.observability.record(event);
    return outcome.result;
  }

  private recordAudit(
    tx: Transaction,
    principal: PlatformPrincipal,
    period: Period,
    action: string,
    targetId: string,
    requestId: string,
    response: ServicePeriodMutationResult,
    details: Record<string, unknown> & {
      balanceBefore: Awaited<ReturnType<typeof readServiceBalance>>;
    },
  ): Promise<void> {
    return this.audit.record(tx, {
      actorPlatformUserId: principal.userId,
      actorRole: principal.role,
      action,
      outcome: "success",
      tenantId: period.tenantId,
      targetType: action.includes("usage") ? "service_usage_entry" : "service_excess_approval",
      targetId,
      reason: null,
      before: {
        servicePeriodId: period.id,
        revision: period.revision,
        balance: details.balanceBefore,
      },
      after: {
        servicePeriodId: period.id,
        revision: response.revision,
        balance: response.balance,
        ...Object.fromEntries(Object.entries(details).filter(([key]) => key !== "balanceBefore")),
      },
      requestId,
    });
  }
}

function assertPerformedInsidePeriod(performedAt: Date, period: Period): void {
  if (performedAt < period.startsAt || performedAt >= period.endsAt) {
    throw new ConflictException({ code: "SERVICE_USAGE_OUTSIDE_PERIOD" });
  }
}

function isConflictCode(error: unknown, expected: string): boolean {
  if (!(error instanceof ConflictException)) return false;
  const response = error.getResponse();
  return (
    typeof response === "object" &&
    response !== null &&
    "code" in response &&
    response.code === expected
  );
}

function mutationResult(
  period: Period,
  balance: Awaited<ReturnType<typeof readServiceBalance>>,
  delta: { consumed?: number; approved?: number },
): ServicePeriodMutationResult {
  const consumed = balance.consumed + (delta.consumed ?? 0);
  const externallyApproved = balance.externallyApproved + (delta.approved ?? 0);
  return {
    revision: period.revision + 1,
    balance: {
      included: balance.included,
      externallyApproved,
      consumed,
      remaining: balance.included + externallyApproved - consumed,
    },
  };
}
