import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  platformCommercialContracts,
  tenantBillingActObjectKey,
  type BillingAct,
  type BillingActCancelDto,
  type BillingActCreateDto,
  type BillingActIssueInput,
  type PrintDocumentVariant,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import {
  acquireBillingWorkflowLocks,
  canonicalBillingResourceId,
  canonicalBillingUuid,
  postgresUniqueConstraint,
  type BillingWorkflowResource,
} from "../billing-workflow-locks";
import {
  beginPlatformBillingMutation,
  commitPlatformBillingMutation,
  platformBillingPayloadHash,
  type PlatformBillingMutationSpec,
} from "../platform-billing-idempotency";
import { ObjectStorageService } from "../storage/object-storage.service";
import type { BillingActListQueryDto } from "./dto";
import { TenantBillingNotificationsService } from "../tenant-billing/tenant-billing-notifications.service";
import { toBillingActPrintModel } from "../billing/print-document-model";
import { renderPrintPdf } from "../billing/print-document-pdf";
import { storedPrintVariant } from "../billing/print-document-layout";

const MAX_ACT_PDF_BYTES = 5 * 1024 * 1024;
const BUSINESS_TIME_ZONE = "Europe/Moscow";

type ActReadExecutor = Pick<Db, "select">;

export interface BillingActPdfUpload {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

interface PreparedActIssue {
  kind: "prepared";
  tenantId: string;
  actId: string;
  documentId: string;
  objectKey: string;
  byteSize: number;
  sha256: string;
  printVariant: PrintDocumentVariant;
  needsReconciliation: boolean;
}

interface CommittedActIssue {
  kind: "committed";
  result: BillingAct;
}

@Injectable()
export class BillingActsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
    private readonly audit: PlatformAuditService,
    private readonly notifications: TenantBillingNotificationsService,
  ) {}

  async list(_actor: PlatformPrincipal, query: BillingActListQueryDto = {}) {
    const conditions = [];
    if (query.tenantId) conditions.push(eq(schema.billingActs.tenantId, query.tenantId));
    if (query.status) conditions.push(eq(schema.billingActs.status, query.status));
    const acts = await this.db
      .select()
      .from(schema.billingActs)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(schema.billingActs.createdAt), desc(schema.billingActs.id));
    const items: BillingAct[] = [];
    for (const act of acts) items.push(await this.actWithDocument(this.db, act));
    return { items };
  }

  async detail(_actor: PlatformPrincipal, actId: string): Promise<BillingAct> {
    return this.detailWith(this.db, actId);
  }

  async create(actor: PlatformPrincipal, input: BillingActCreateDto): Promise<BillingAct> {
    return this.db.transaction(async (tx) => {
      const payload = {
        tenantId: input.tenantId,
        requestId: input.requestId ? canonicalBillingUuid(input.requestId) : null,
        invoiceId: input.invoiceId ? canonicalBillingUuid(input.invoiceId) : null,
        orderedServiceId: input.orderedServiceId
          ? canonicalBillingUuid(input.orderedServiceId)
          : null,
        number: input.number.trim(),
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      };
      const mutation = await beginPlatformBillingMutation(tx, {
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
        operation: "billing.act.create",
        targetId: `create:${payload.number}`,
        payload,
        actorPlatformUserId: actor.userId,
      });
      if (mutation.kind === "committed") return parseActReplay(mutation.result);
      if (mutation.kind === "pending") mutationInProgress();
      const resources: BillingWorkflowResource[] = [{ kind: "act_number", id: payload.number }];
      if (payload.requestId) resources.push({ kind: "request", id: payload.requestId });
      if (payload.invoiceId) resources.push({ kind: "invoice", id: payload.invoiceId });
      if (payload.orderedServiceId) {
        resources.push({ kind: "ordered_service", id: payload.orderedServiceId });
      }
      await acquireBillingWorkflowLocks(tx, input.tenantId, resources);
      const [tenant] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, input.tenantId))
        .for("share")
        .limit(1);
      if (!tenant) throw new NotFoundException({ code: "tenant_not_found" });
      const [numberCollision] = await tx
        .select({ id: schema.billingActs.id })
        .from(schema.billingActs)
        .where(eq(schema.billingActs.number, payload.number))
        .limit(1);
      if (numberCollision) throw new ConflictException({ code: "billing_act_number_exists" });
      await validateActSources(tx, input.tenantId, payload);
      let act: typeof schema.billingActs.$inferSelect | undefined;
      try {
        [act] = await tx
          .insert(schema.billingActs)
          .values({
            tenantId: input.tenantId,
            requestId: payload.requestId,
            invoiceId: payload.invoiceId,
            orderedServiceId: payload.orderedServiceId,
            number: payload.number,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            createdByPlatformUserId: actor.userId,
          })
          .returning();
      } catch (error) {
        if (postgresUniqueConstraint(error) === "billing_acts_number_uq") {
          throw new ConflictException({ code: "billing_act_number_exists" });
        }
        throw error;
      }
      if (!act) throw new Error("billing act insert failed");
      if (act.requestId) {
        const [request] = await tx
          .select({
            id: schema.tenantBillingRequests.id,
            status: schema.tenantBillingRequests.status,
          })
          .from(schema.tenantBillingRequests)
          .where(
            and(
              eq(schema.tenantBillingRequests.tenantId, act.tenantId),
              eq(schema.tenantBillingRequests.id, act.requestId),
            ),
          )
          .for("update")
          .limit(1);
        if (!request) throw new ConflictException({ code: "billing_act_request_invalid" });
        const [link] = await tx
          .insert(schema.tenantBillingRequestLinks)
          .values({ tenantId: act.tenantId, requestId: request.id, actId: act.id })
          .returning();
        if (!link) throw new Error("billing act request link insert failed");
        const [event] = await tx
          .insert(schema.tenantBillingRequestEvents)
          .values({
            tenantId: act.tenantId,
            requestId: request.id,
            kind: "act_linked",
            actorKind: "platform_user",
            actorPlatformUserId: actor.userId,
            metadata: { actId: act.id, linkId: link.id },
            idempotencyKey: input.idempotencyKey,
          })
          .returning({ id: schema.tenantBillingRequestEvents.id });
        if (!event) throw new Error("billing act request event insert failed");
        await this.audit.record(tx, {
          actorPlatformUserId: actor.userId,
          actorRole: actor.role,
          action: "billing.request.act_linked",
          outcome: "success",
          tenantId: act.tenantId,
          targetType: "tenant_billing_request",
          targetId: request.id,
          reason: null,
          before: { status: request.status },
          after: { status: request.status, actId: act.id, linkId: link.id, eventId: event.id },
          requestId: null,
        });
      }
      const result = await this.actWithDocument(tx, act);
      await this.audit.record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action: "billing.act.created",
        outcome: "success",
        tenantId: act.tenantId,
        targetType: "billing_act",
        targetId: act.id,
        reason: null,
        before: null,
        after: {
          status: act.status,
          number: act.number,
          requestId: act.requestId,
          invoiceId: act.invoiceId,
          orderedServiceId: act.orderedServiceId,
          periodStart: act.periodStart,
          periodEnd: act.periodEnd,
        },
        requestId: null,
      });
      await commitPlatformBillingMutation(tx, mutation.row.id, act.id, result);
      return result;
    });
  }

  async issue(
    actor: PlatformPrincipal,
    actId: string,
    input: BillingActIssueInput,
    file: BillingActPdfUpload,
  ): Promise<BillingAct> {
    validateBillingActPdf(file);
    const canonicalActId = canonicalBillingUuid(actId);
    const [located] = await this.db
      .select({ tenantId: schema.billingActs.tenantId })
      .from(schema.billingActs)
      .where(eq(schema.billingActs.id, canonicalActId))
      .limit(1);
    if (!located) actNotFound();
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    const printVariant = input.printVariant ?? "clean";
    const spec: PlatformBillingMutationSpec = {
      tenantId: located.tenantId,
      idempotencyKey: input.idempotencyKey,
      operation: "billing.act.issue",
      targetId: canonicalActId,
      payload: {
        contentType: "application/pdf",
        byteSize: file.buffer.byteLength,
        sha256,
        printVariant,
      },
      actorPlatformUserId: actor.userId,
    };
    const prepared = await this.prepareIssue(
      actor,
      canonicalActId,
      spec,
      file.buffer.byteLength,
      sha256,
      printVariant,
    );
    if (prepared.kind === "committed") return prepared.result;

    let shouldUpload = true;
    if (prepared.needsReconciliation) {
      let verification: "verified" | "missing" | "mismatch";
      try {
        verification = await this.storage.verifyObject(
          prepared.objectKey,
          prepared.byteSize,
          prepared.sha256,
        );
        if (verification === "mismatch") {
          await this.storage.deleteConfirmed(prepared.objectKey);
        }
      } catch {
        throw new ConflictException({ code: "act_issue_in_progress" });
      }
      await this.markDocumentPending(prepared);
      shouldUpload = verification !== "verified";
    }

    try {
      if (shouldUpload) {
        await this.storage.putVerified(
          prepared.objectKey,
          file.buffer,
          "application/pdf",
          prepared.sha256,
        );
      }
    } catch (error) {
      let recovered = false;
      try {
        const verification = await this.storage.verifyObject(
          prepared.objectKey,
          prepared.byteSize,
          prepared.sha256,
        );
        if (verification === "verified") {
          recovered = true;
        } else if (verification === "missing") {
          await this.markDocumentState(prepared, "failed");
        } else {
          let state: "failed" | "cleanup_required" = "failed";
          try {
            await this.storage.deleteConfirmed(prepared.objectKey);
          } catch {
            state = "cleanup_required";
          }
          await this.markDocumentState(prepared, state);
        }
      } catch {
        // The pending intent and canonical key are the durable reconciliation record.
      }
      if (!recovered) throw error;
    }

    try {
      return await this.finalizeIssue(actor, prepared, spec);
    } catch (error) {
      // A lost COMMIT acknowledgement must never trigger object deletion. Retry
      // the idempotent finalization once, then prefer a committed ledger result.
      try {
        return await this.finalizeIssue(actor, prepared, spec);
      } catch {
        const committed = await this.readCommittedMutation(spec);
        if (committed) return committed;
      }
      throw error;
    }
  }

  async issueGenerated(
    actor: PlatformPrincipal,
    actId: string,
    input: BillingActIssueInput,
  ): Promise<BillingAct> {
    const canonicalActId = canonicalBillingUuid(actId);
    const [act] = await this.db
      .select()
      .from(schema.billingActs)
      .where(eq(schema.billingActs.id, canonicalActId))
      .limit(1);
    if (!act) actNotFound();
    if (!act.invoiceId) {
      throw new BadRequestException({ code: "billing_act_invoice_required" });
    }
    const [invoice] = await this.db
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.id, act.invoiceId), eq(schema.invoices.tenantId, act.tenantId)))
      .limit(1);
    if (
      !invoice ||
      invoice.status === "draft" ||
      invoice.status === "cancelled" ||
      invoice.issueDate === null ||
      invoice.sellerSnapshot === null ||
      invoice.buyerSnapshot === null
    ) {
      throw new ConflictException({ code: "billing_act_invoice_not_issued" });
    }
    const lines = await this.db
      .select()
      .from(schema.invoiceLines)
      .where(
        and(
          eq(schema.invoiceLines.invoiceId, invoice.id),
          eq(schema.invoiceLines.tenantId, invoice.tenantId),
        ),
      )
      .orderBy(schema.invoiceLines.position);
    const buffer = await renderPrintPdf(toBillingActPrintModel(act, { ...invoice, lines }), {
      printVariant: input.printVariant ?? "clean",
    });
    return this.issue(actor, canonicalActId, input, {
      originalname: `${act.number}.pdf`,
      mimetype: "application/pdf",
      size: buffer.byteLength,
      buffer,
    });
  }

  async cancel(
    actor: PlatformPrincipal,
    actId: string,
    input: BillingActCancelDto,
  ): Promise<BillingAct> {
    const canonicalActId = canonicalBillingUuid(actId);
    const [located] = await this.db
      .select({ tenantId: schema.billingActs.tenantId })
      .from(schema.billingActs)
      .where(eq(schema.billingActs.id, canonicalActId))
      .limit(1);
    if (!located) actNotFound();
    return this.db.transaction(async (tx) => {
      const mutation = await beginPlatformBillingMutation(tx, {
        tenantId: located.tenantId,
        idempotencyKey: input.idempotencyKey,
        operation: "billing.act.cancel",
        targetId: canonicalActId,
        payload: { actId: canonicalActId },
        actorPlatformUserId: actor.userId,
      });
      if (mutation.kind === "committed") return parseActReplay(mutation.result);
      if (mutation.kind === "pending") mutationInProgress();
      const discovered = await discoverActWorkflowResources(tx, located.tenantId, canonicalActId);
      await acquireBillingWorkflowLocks(tx, located.tenantId, discovered);
      const act = await lockAct(tx, located.tenantId, canonicalActId);
      const currentDocuments = await tx
        .select()
        .from(schema.billingActDocuments)
        .where(
          and(
            eq(schema.billingActDocuments.tenantId, act.tenantId),
            eq(schema.billingActDocuments.actId, act.id),
            eq(schema.billingActDocuments.isCurrent, true),
          ),
        )
        .for("update");
      if (currentDocuments.length > 1) throw new Error("billing act current document ambiguity");
      if (
        currentDocuments[0]?.state === "pending" ||
        currentDocuments[0]?.state === "cleanup_required"
      ) {
        throw new ConflictException({ code: "act_issue_in_progress" });
      }
      if (act.status === "cancelled") {
        throw new ConflictException({ code: "billing_act_already_cancelled" });
      }
      const now = this.now();
      const [cancelled] = await tx
        .update(schema.billingActs)
        .set({
          status: "cancelled",
          cancelledByPlatformUserId: actor.userId,
          cancelledAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.billingActs.tenantId, act.tenantId),
            eq(schema.billingActs.id, act.id),
            eq(schema.billingActs.status, act.status),
          ),
        )
        .returning();
      if (!cancelled) throw new ConflictException({ code: "billing_act_cancel_conflict" });
      const result = await this.actWithDocument(tx, cancelled);
      await this.audit.record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action: "billing.act.cancelled",
        outcome: "success",
        tenantId: act.tenantId,
        targetType: "billing_act",
        targetId: act.id,
        reason: null,
        before: { status: act.status },
        after: { status: "cancelled", number: act.number },
        requestId: null,
      });
      await commitPlatformBillingMutation(tx, mutation.row.id, act.id, result);
      return result;
    });
  }

  protected now(): Date {
    return new Date();
  }

  private async prepareIssue(
    actor: PlatformPrincipal,
    actId: string,
    spec: PlatformBillingMutationSpec,
    byteSize: number,
    sha256: string,
    printVariant: PrintDocumentVariant,
  ): Promise<PreparedActIssue | CommittedActIssue> {
    return this.db.transaction(async (tx) => {
      const mutation = await beginPlatformBillingMutation(tx, spec);
      if (mutation.kind === "committed") {
        return { kind: "committed", result: parseActReplay(mutation.result) };
      }
      const discovered = await discoverActWorkflowResources(tx, spec.tenantId, actId);
      await acquireBillingWorkflowLocks(tx, spec.tenantId, discovered);
      const act = await lockAct(tx, spec.tenantId, actId);
      await assertCanonicalActRequestLink(tx, act);
      const [currentDocument] = await tx
        .select()
        .from(schema.billingActDocuments)
        .where(
          and(
            eq(schema.billingActDocuments.tenantId, act.tenantId),
            eq(schema.billingActDocuments.actId, act.id),
            eq(schema.billingActDocuments.isCurrent, true),
          ),
        )
        .for("update")
        .limit(1);
      if (act.status === "issued") {
        if (mutation.kind === "pending" && currentDocument?.state === "ready") {
          const result = await this.actWithDocument(tx, act);
          await commitPlatformBillingMutation(tx, mutation.row.id, act.id, result);
          return { kind: "committed", result };
        }
        throw new ConflictException({ code: "billing_act_already_issued" });
      }
      if (act.status === "cancelled") {
        throw new ConflictException({ code: "billing_act_cancelled" });
      }
      await this.assertIssueReady(tx, act);
      if (mutation.kind === "pending") {
        if (!currentDocument)
          throw new ConflictException({ code: "billing_act_issue_in_progress" });
        if (
          currentDocument.sha256 !== sha256 ||
          currentDocument.byteSize !== byteSize ||
          currentDocument.contentType !== "application/pdf" ||
          currentDocument.printVariant !== printVariant
        ) {
          throw new ConflictException({ code: "idempotency_key_reused" });
        }
        if (currentDocument.state === "ready") {
          throw new ConflictException({ code: "billing_act_issue_in_progress" });
        }
        if (currentDocument.state === "failed") {
          await tx
            .update(schema.billingActDocuments)
            .set({ state: "pending", updatedAt: this.now() })
            .where(eq(schema.billingActDocuments.id, currentDocument.id));
        }
        return {
          kind: "prepared",
          tenantId: act.tenantId,
          actId: act.id,
          documentId: currentDocument.id,
          objectKey: currentDocument.objectKey,
          byteSize,
          sha256,
          printVariant,
          needsReconciliation: currentDocument.state === "cleanup_required",
        };
      }
      if (currentDocument) {
        throw new ConflictException({ code: "billing_act_issue_in_progress" });
      }
      const documentId = randomUUID();
      const objectKey = tenantBillingActObjectKey(act.tenantId, act.id, documentId);
      const [document] = await tx
        .insert(schema.billingActDocuments)
        .values({
          id: documentId,
          tenantId: act.tenantId,
          actId: act.id,
          revision: 1,
          objectKey,
          contentType: "application/pdf",
          printVariant,
          sha256,
          byteSize,
          state: "pending",
          uploadedByPlatformUserId: actor.userId,
        })
        .returning({ id: schema.billingActDocuments.id });
      if (!document) throw new Error("billing act document intent insert failed");
      return {
        kind: "prepared",
        tenantId: act.tenantId,
        actId: act.id,
        documentId,
        objectKey,
        byteSize,
        sha256,
        printVariant,
        needsReconciliation: false,
      };
    });
  }

  private async finalizeIssue(
    actor: PlatformPrincipal,
    prepared: PreparedActIssue,
    spec: PlatformBillingMutationSpec,
  ): Promise<BillingAct> {
    return this.db.transaction(async (tx) => {
      const mutation = await beginPlatformBillingMutation(tx, spec);
      if (mutation.kind === "committed") return parseActReplay(mutation.result);
      const discovered = await discoverActWorkflowResources(tx, prepared.tenantId, prepared.actId);
      await acquireBillingWorkflowLocks(tx, prepared.tenantId, discovered);
      const act = await lockAct(tx, prepared.tenantId, prepared.actId);
      await assertCanonicalActRequestLink(tx, act);
      const [document] = await tx
        .select()
        .from(schema.billingActDocuments)
        .where(
          and(
            eq(schema.billingActDocuments.tenantId, prepared.tenantId),
            eq(schema.billingActDocuments.actId, prepared.actId),
            eq(schema.billingActDocuments.id, prepared.documentId),
          ),
        )
        .for("update")
        .limit(1);
      if (!document) throw new NotFoundException({ code: "billing_act_document_not_found" });
      if (act.status === "issued" && document.state === "ready") {
        const result = await this.actWithDocument(tx, act);
        await commitPlatformBillingMutation(tx, mutation.row.id, act.id, result);
        return result;
      }
      if (act.status !== "draft") {
        throw new ConflictException({ code: "billing_act_not_draft" });
      }
      if (document.state !== "pending") {
        throw new ConflictException({ code: "billing_act_document_not_pending" });
      }
      await this.assertIssueReady(tx, act);
      const now = this.now();
      const [readyDocument] = await tx
        .update(schema.billingActDocuments)
        .set({ state: "ready", readyAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.billingActDocuments.id, document.id),
            eq(schema.billingActDocuments.state, "pending"),
          ),
        )
        .returning();
      if (!readyDocument) throw new ConflictException({ code: "billing_act_issue_conflict" });
      const [issued] = await tx
        .update(schema.billingActs)
        .set({
          status: "issued",
          issuedByPlatformUserId: actor.userId,
          issuedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.billingActs.tenantId, act.tenantId),
            eq(schema.billingActs.id, act.id),
            eq(schema.billingActs.status, "draft"),
          ),
        )
        .returning();
      if (!issued) throw new ConflictException({ code: "billing_act_issue_conflict" });
      if (issued.requestId) {
        const [request] = await tx
          .select()
          .from(schema.tenantBillingRequests)
          .where(
            and(
              eq(schema.tenantBillingRequests.tenantId, issued.tenantId),
              eq(schema.tenantBillingRequests.id, issued.requestId),
            ),
          )
          .for("update")
          .limit(1);
        if (!request) throw new ConflictException({ code: "billing_act_request_invalid" });
        const existingLinks = await tx
          .select()
          .from(schema.tenantBillingRequestLinks)
          .where(
            and(
              eq(schema.tenantBillingRequestLinks.tenantId, issued.tenantId),
              eq(schema.tenantBillingRequestLinks.actId, issued.id),
            ),
          )
          .for("update");
        if (existingLinks.length > 1) throw new Error("billing act request link ambiguity");
        const existingLink = existingLinks[0];
        if (existingLink && existingLink.requestId !== request.id) {
          throw new ConflictException({ code: "billing_target_already_linked" });
        }
        const link =
          existingLink ??
          (
            await tx
              .insert(schema.tenantBillingRequestLinks)
              .values({ tenantId: issued.tenantId, requestId: request.id, actId: issued.id })
              .returning()
          )[0];
        if (!link) throw new Error("billing act request link insert failed");
        if (!existingLink) {
          const [event] = await tx
            .insert(schema.tenantBillingRequestEvents)
            .values({
              tenantId: issued.tenantId,
              requestId: request.id,
              kind: "act_linked",
              actorKind: "platform_user",
              actorPlatformUserId: actor.userId,
              metadata: { actId: issued.id, documentId: readyDocument.id },
              idempotencyKey: randomUUID(),
            })
            .returning({ id: schema.tenantBillingRequestEvents.id });
          if (!event) throw new Error("billing act request event insert failed");
          await this.audit.record(tx, {
            actorPlatformUserId: actor.userId,
            actorRole: actor.role,
            action: "billing.request.act_linked",
            outcome: "success",
            tenantId: issued.tenantId,
            targetType: "tenant_billing_request",
            targetId: request.id,
            reason: null,
            before: { status: request.status },
            after: { status: request.status, actId: issued.id, linkId: link.id, eventId: event.id },
            requestId: null,
          });
        }
      }
      await this.audit.record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action: "billing.act.issued",
        outcome: "success",
        tenantId: issued.tenantId,
        targetType: "billing_act",
        targetId: issued.id,
        reason: null,
        before: { status: "draft" },
        after: {
          status: "issued",
          number: issued.number,
          documentId: readyDocument.id,
          printVariant: readyDocument.printVariant,
          sha256: readyDocument.sha256,
          byteSize: readyDocument.byteSize,
        },
        requestId: null,
      });
      await this.notifications.enqueueInTransaction(tx, {
        tenantId: issued.tenantId,
        eventKind: "act_ready",
        entityId: issued.id,
        revision: readyDocument.revision,
        subjectName: issued.number,
      });
      const result = await this.actWithDocument(tx, issued, readyDocument);
      await commitPlatformBillingMutation(tx, mutation.row.id, issued.id, result);
      return result;
    });
  }

  private async assertIssueReady(tx: ActReadExecutor, act: typeof schema.billingActs.$inferSelect) {
    if (act.orderedServiceId) {
      const [service] = await tx
        .select({ status: schema.orderedServices.status })
        .from(schema.orderedServices)
        .where(
          and(
            eq(schema.orderedServices.tenantId, act.tenantId),
            eq(schema.orderedServices.id, act.orderedServiceId),
          ),
        )
        .for("update")
        .limit(1);
      if (!service) throw new ConflictException({ code: "billing_act_service_invalid" });
      if (service.status !== "completed") {
        throw new ConflictException({ code: "billing_act_service_not_completed" });
      }
      return;
    }
    if (act.periodEnd >= businessDate(this.now())) {
      throw new ConflictException({ code: "billing_act_period_not_closed" });
    }
  }

  private async markDocumentState(
    prepared: PreparedActIssue,
    state: "failed" | "cleanup_required",
  ) {
    await this.db
      .update(schema.billingActDocuments)
      .set({ state, readyAt: null, updatedAt: this.now() })
      .where(
        and(
          eq(schema.billingActDocuments.tenantId, prepared.tenantId),
          eq(schema.billingActDocuments.actId, prepared.actId),
          eq(schema.billingActDocuments.id, prepared.documentId),
          eq(schema.billingActDocuments.state, "pending"),
        ),
      );
  }

  private async markDocumentPending(prepared: PreparedActIssue) {
    const [pending] = await this.db
      .update(schema.billingActDocuments)
      .set({ state: "pending", readyAt: null, updatedAt: this.now() })
      .where(
        and(
          eq(schema.billingActDocuments.tenantId, prepared.tenantId),
          eq(schema.billingActDocuments.actId, prepared.actId),
          eq(schema.billingActDocuments.id, prepared.documentId),
          eq(schema.billingActDocuments.state, "cleanup_required"),
        ),
      )
      .returning({ id: schema.billingActDocuments.id });
    if (!pending) throw new ConflictException({ code: "act_issue_in_progress" });
  }

  private async readCommittedMutation(spec: PlatformBillingMutationSpec) {
    const [row] = await this.db
      .select({
        state: schema.platformBillingMutationIdempotency.state,
        operation: schema.platformBillingMutationIdempotency.operation,
        targetId: schema.platformBillingMutationIdempotency.targetId,
        payloadHash: schema.platformBillingMutationIdempotency.payloadHash,
        result: schema.platformBillingMutationIdempotency.result,
      })
      .from(schema.platformBillingMutationIdempotency)
      .where(
        and(
          eq(schema.platformBillingMutationIdempotency.tenantId, spec.tenantId),
          eq(
            schema.platformBillingMutationIdempotency.idempotencyKey,
            canonicalBillingUuid(spec.idempotencyKey),
          ),
        ),
      )
      .limit(1);
    return row?.state === "committed" &&
      row.operation === spec.operation &&
      row.targetId === canonicalBillingResourceId(spec.targetId) &&
      row.payloadHash === platformBillingPayloadHash(spec.payload)
      ? parseActReplay(row.result)
      : null;
  }

  private async detailWith(db: ActReadExecutor, actId: string): Promise<BillingAct> {
    const [act] = await db
      .select()
      .from(schema.billingActs)
      .where(eq(schema.billingActs.id, actId))
      .limit(1);
    if (!act) actNotFound();
    return this.actWithDocument(db, act);
  }

  private async actWithDocument(
    db: ActReadExecutor,
    act: typeof schema.billingActs.$inferSelect,
    knownDocument?: typeof schema.billingActDocuments.$inferSelect,
  ): Promise<BillingAct> {
    const document =
      knownDocument ??
      (
        await db
          .select()
          .from(schema.billingActDocuments)
          .where(
            and(
              eq(schema.billingActDocuments.tenantId, act.tenantId),
              eq(schema.billingActDocuments.actId, act.id),
              eq(schema.billingActDocuments.isCurrent, true),
            ),
          )
          .orderBy(desc(schema.billingActDocuments.revision))
          .limit(1)
      )[0];
    return {
      id: act.id,
      tenantId: act.tenantId,
      requestId: act.requestId,
      invoiceId: act.invoiceId,
      orderedServiceId: act.orderedServiceId,
      number: act.number,
      status: act.status,
      periodStart: act.periodStart,
      periodEnd: act.periodEnd,
      createdByPlatformUserId: act.createdByPlatformUserId,
      issuedByPlatformUserId: act.issuedByPlatformUserId,
      issuedAt: act.issuedAt?.toISOString() ?? null,
      cancelledByPlatformUserId: act.cancelledByPlatformUserId,
      cancelledAt: act.cancelledAt?.toISOString() ?? null,
      createdAt: act.createdAt.toISOString(),
      updatedAt: act.updatedAt.toISOString(),
      document: document ? actDocumentSource(document) : null,
    };
  }
}

export function validateBillingActPdf(file: BillingActPdfUpload): void {
  if (
    !Number.isInteger(file.size) ||
    file.size <= 0 ||
    file.size > MAX_ACT_PDF_BYTES ||
    file.size !== file.buffer.byteLength
  ) {
    throw new BadRequestException({ code: "billing_act_pdf_size_invalid" });
  }
  if (
    file.mimetype !== "application/pdf" ||
    !file.buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))
  ) {
    throw new BadRequestException({ code: "billing_act_pdf_invalid" });
  }
}

async function validateActSources(
  tx: ActReadExecutor,
  tenantId: string,
  input: { requestId: string | null; invoiceId: string | null; orderedServiceId: string | null },
) {
  if (input.requestId) {
    const [request] = await tx
      .select({ tenantId: schema.tenantBillingRequests.tenantId })
      .from(schema.tenantBillingRequests)
      .where(eq(schema.tenantBillingRequests.id, input.requestId))
      .for("share")
      .limit(1);
    assertActSource(request?.tenantId, tenantId, "billing_request_not_found");
  }
  if (input.invoiceId) {
    const [invoice] = await tx
      .select({ tenantId: schema.invoices.tenantId })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, input.invoiceId))
      .for("share")
      .limit(1);
    assertActSource(invoice?.tenantId, tenantId, "invoice_not_found");
  }
  if (input.orderedServiceId) {
    const [service] = await tx
      .select({ tenantId: schema.orderedServices.tenantId })
      .from(schema.orderedServices)
      .where(eq(schema.orderedServices.id, input.orderedServiceId))
      .for("share")
      .limit(1);
    assertActSource(service?.tenantId, tenantId, "ordered_service_not_found");
  }
}

function assertActSource(
  sourceTenantId: string | undefined,
  tenantId: string,
  notFoundCode: string,
) {
  if (sourceTenantId === undefined) throw new NotFoundException({ code: notFoundCode });
  if (sourceTenantId !== tenantId) {
    throw new ConflictException({ code: "billing_source_tenant_mismatch" });
  }
}

async function lockAct(tx: ActReadExecutor, tenantId: string, actId: string) {
  const [act] = await tx
    .select()
    .from(schema.billingActs)
    .where(and(eq(schema.billingActs.tenantId, tenantId), eq(schema.billingActs.id, actId)))
    .for("update")
    .limit(1);
  if (!act) actNotFound();
  return act;
}

async function discoverActWorkflowResources(
  tx: ActReadExecutor,
  tenantId: string,
  actId: string,
): Promise<BillingWorkflowResource[]> {
  const [act] = await tx
    .select({
      requestId: schema.billingActs.requestId,
      invoiceId: schema.billingActs.invoiceId,
      orderedServiceId: schema.billingActs.orderedServiceId,
    })
    .from(schema.billingActs)
    .where(and(eq(schema.billingActs.tenantId, tenantId), eq(schema.billingActs.id, actId)))
    .limit(1);
  if (!act) actNotFound();
  const links = await tx
    .select({ requestId: schema.tenantBillingRequestLinks.requestId })
    .from(schema.tenantBillingRequestLinks)
    .where(
      and(
        eq(schema.tenantBillingRequestLinks.tenantId, tenantId),
        eq(schema.tenantBillingRequestLinks.actId, actId),
      ),
    );
  const resources: BillingWorkflowResource[] = [{ kind: "act", id: actId }];
  if (act.requestId) resources.push({ kind: "request", id: act.requestId });
  for (const link of links) resources.push({ kind: "request", id: link.requestId });
  if (act.invoiceId) resources.push({ kind: "invoice", id: act.invoiceId });
  if (act.orderedServiceId) {
    resources.push({ kind: "ordered_service", id: act.orderedServiceId });
  }
  return resources;
}

async function assertCanonicalActRequestLink(
  tx: ActReadExecutor,
  act: typeof schema.billingActs.$inferSelect,
): Promise<void> {
  const links = await tx
    .select({ requestId: schema.tenantBillingRequestLinks.requestId })
    .from(schema.tenantBillingRequestLinks)
    .where(
      and(
        eq(schema.tenantBillingRequestLinks.tenantId, act.tenantId),
        eq(schema.tenantBillingRequestLinks.actId, act.id),
      ),
    )
    .for("update");
  if (links.length > 1) throw new Error("billing act request link ambiguity");
  const linkedRequestId = links[0]?.requestId ?? null;
  if (linkedRequestId !== act.requestId) {
    throw new ConflictException({ code: "billing_act_request_mismatch" });
  }
}

function actDocumentSource(
  document: typeof schema.billingActDocuments.$inferSelect,
): BillingAct["document"] {
  const common = {
    id: document.id,
    revision: document.revision,
    printVariant: storedPrintVariant(document.printVariant),
    contentType: "application/pdf" as const,
    byteSize: document.byteSize,
    sha256: document.sha256,
    uploadedByPlatformUserId: document.uploadedByPlatformUserId,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
  if (document.state === "ready") {
    if (!document.readyAt) throw new Error("ready billing act document has no ready timestamp");
    return { ...common, state: "ready", readyAt: document.readyAt.toISOString() };
  }
  if (document.state === "pending") return { ...common, state: "pending", readyAt: null };
  return { ...common, state: document.state, readyAt: null };
}

function businessDate(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const value = new Map(parts.map((part) => [part.type, part.value]));
  return `${value.get("year")}-${value.get("month")}-${value.get("day")}`;
}

function parseActReplay(value: unknown): BillingAct {
  return platformCommercialContracts.billingActs.detail.response.parse(value);
}

function actNotFound(): never {
  throw new NotFoundException({ code: "billing_act_not_found" });
}

function mutationInProgress(): never {
  throw new ConflictException({ code: "billing_mutation_in_progress" });
}
