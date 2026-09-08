import { ConflictException } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  applyProductLabelEvent,
  DomainError,
  duplicatePayloadDigest,
  productLabelEventSchema,
  PRODUCT_LABEL_PROTOCOL,
  productLabelReceiptSchema,
  productLabelValueDigest,
  type ProductLabelEvent,
  type ProductLabelProjection,
  type ProductLabelReceipt,
  type ProductLabelRejectionCode,
} from "@markiro/domain";
import { validationPrintFromStorage } from "../shifts/validation-print-policy";

export type StationScanTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Context = {
  tenantId: string;
  authenticatedTerminalId: string;
  deniedEventIds?: ReadonlySet<string>;
};

/** Caller holds the tenant registry, sorted shift and code locks. No printer/raw payload is returned. */
export async function applyStationProductLabelEvents(
  tx: StationScanTransaction,
  context: Context,
  events: ProductLabelEvent[],
): Promise<ProductLabelReceipt> {
  const { tenantId, authenticatedTerminalId: deviceId } = context;
  if (events.length === 0)
    return { protocol: PRODUCT_LABEL_PROTOCOL, acceptedEventIds: [], quarantined: [] };
  const jobs = await tx
    .select()
    .from(schema.productLabelJobs)
    .where(
      and(
        eq(schema.productLabelJobs.tenantId, tenantId),
        eq(schema.productLabelJobs.deviceId, deviceId),
        inArray(schema.productLabelJobs.jobId, [...new Set(events.map((event) => event.jobId))]),
      ),
    )
    .orderBy(schema.productLabelJobs.jobId)
    .for("update");
  const jobsById = new Map(jobs.map((job) => [job.jobId, job]));
  const currentById = new Map<string, ProductLabelProjection>();
  const attemptIdsByJob = new Map<string, Set<string>>();
  const newlyTouchedShiftIds = new Set<string>();
  const operatorRows = await tx
    .select({ id: schema.employees.id })
    .from(schema.employees)
    .where(
      and(
        eq(schema.employees.tenantId, tenantId),
        inArray(schema.employees.id, [...new Set(events.map((event) => event.operatorId))]),
      ),
    );
  const operators = new Set(operatorRows.map((operator) => operator.id));
  const verdicts = new Map<string, ProductLabelRejectionCode | null>();

  for (const event of [...events].sort(
    (a, b) => a.jobId.localeCompare(b.jobId) || a.sequence - b.sequence,
  )) {
    const digest = productLabelValueDigest(event);
    const [previous] = await tx
      .select()
      .from(schema.productLabelEventReceipts)
      .where(
        and(
          eq(schema.productLabelEventReceipts.tenantId, tenantId),
          eq(schema.productLabelEventReceipts.deviceId, deviceId),
          eq(schema.productLabelEventReceipts.eventId, event.eventId),
        ),
      );
    if (previous) {
      if (previous.payloadDigest !== digest)
        throw new ConflictException({ code: "product_label_event_mismatch" });
      // Parse persisted verdicts rather than silently treating an unknown stored code as success.
      const parsed = productLabelReceiptSchema.parse({
        protocol: PRODUCT_LABEL_PROTOCOL,
        acceptedEventIds: previous.outcome === "accepted" ? [event.eventId] : [],
        quarantined:
          previous.outcome === "quarantined"
            ? [{ eventId: event.eventId, code: previous.rejectionCode }]
            : [],
      });
      verdicts.set(event.eventId, parsed.quarantined[0]?.code ?? null);
      continue;
    }

    const rejected = await applyOne(event);
    verdicts.set(event.eventId, rejected);
    await tx.insert(schema.productLabelEventReceipts).values({
      tenantId,
      deviceId,
      eventId: event.eventId,
      payloadDigest: digest,
      outcome: rejected === null ? "accepted" : "quarantined",
      rejectionCode: rejected,
    });
  }
  if (newlyTouchedShiftIds.size > 0) {
    await tx
      .update(schema.shifts)
      .set({ lateDataAt: sql`now()` })
      .where(
        and(
          eq(schema.shifts.tenantId, tenantId),
          inArray(schema.shifts.id, [...newlyTouchedShiftIds]),
          eq(schema.shifts.status, "closed"),
          isNull(schema.shifts.lateDataAt),
        ),
      );
  }
  return productLabelReceiptSchema.parse({
    protocol: PRODUCT_LABEL_PROTOCOL,
    acceptedEventIds: events
      .filter((event) => verdicts.get(event.eventId) === null)
      .map((event) => event.eventId),
    quarantined: events.flatMap((event) => {
      const code = verdicts.get(event.eventId);
      return code ? [{ eventId: event.eventId, code }] : [];
    }),
  });

  async function applyOne(event: ProductLabelEvent): Promise<ProductLabelRejectionCode | null> {
    if (context.deniedEventIds?.has(event.eventId)) return "subscription_read_only";
    const [shift] = await tx
      .select()
      .from(schema.shifts)
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, event.shiftId)));
    if (!shift) return "parent_missing";
    if (!operators.has(event.operatorId)) return "invalid_transition";
    const acceptedAt = new Date(event.acceptedAt);
    const [code] = await tx
      .select({ raw: schema.codes.canonicalRaw })
      .from(schema.codes)
      .where(
        and(
          eq(schema.codes.tenantId, tenantId),
          eq(schema.codes.shiftId, event.shiftId),
          eq(schema.codes.codeHash, event.codeHash),
          eq(schema.codes.scannedAt, acceptedAt),
        ),
      );
    if (!code) return "parent_missing";
    const scans = await tx
      .select({ raw: schema.scanEvents.raw, operatorId: schema.scanEvents.operatorId })
      .from(schema.scanEvents)
      .where(
        and(
          eq(schema.scanEvents.tenantId, tenantId),
          eq(schema.scanEvents.shiftId, event.shiftId),
          eq(schema.scanEvents.terminalId, deviceId),
          eq(schema.scanEvents.scannedAt, acceptedAt),
          eq(schema.scanEvents.verdict, "ok"),
        ),
      );
    if (scans.length === 0) return "parent_missing";
    const policy = validationPrintFromStorage(shift);
    if (
      shift.mode !== "validation" ||
      shift.status === "planned" ||
      policy.mode !== "duplicate_dm" ||
      event.policyRevision !== policy.policyRevision ||
      event.templateDigest !== policy.snapshot.digest ||
      (event.kind === "prepared" && event.dpi !== policy.snapshot.spec.dpi)
    )
      return "policy_mismatch";
    // codes is shared by hash/time; the exact authenticated scan also needs the same full payload.
    try {
      if (duplicatePayloadDigest(code.raw) !== event.payloadDigest) return "policy_mismatch";
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return "policy_mismatch";
    }
    const matchingScan = scans.find((scan) => {
      try {
        return duplicatePayloadDigest(scan.raw) === event.payloadDigest;
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        return false;
      }
    });
    if (!matchingScan) return "policy_mismatch";
    const [owner] = await tx
      .select()
      .from(schema.codeRegistry)
      .where(
        and(
          eq(schema.codeRegistry.tenantId, tenantId),
          eq(schema.codeRegistry.codeHash, event.codeHash),
        ),
      );
    if (
      !owner ||
      owner.terminalId !== deviceId ||
      owner.shiftId !== event.shiftId ||
      owner.scannedAt.getTime() !== acceptedAt.getTime()
    )
      return "ownership_conflict";

    let current = currentById.get(event.jobId) ?? null;
    const job = jobsById.get(event.jobId);
    if (
      job &&
      (job.shiftId !== event.shiftId ||
        job.codeHash !== event.codeHash ||
        job.acceptedAt.getTime() !== acceptedAt.getTime() ||
        job.policyRevision !== event.policyRevision ||
        job.templateDigest !== event.templateDigest ||
        job.payloadDigest !== event.payloadDigest)
    )
      return "invalid_transition";
    const attemptIds = attemptIdsByJob.get(event.jobId) ?? new Set<string>();
    if (job && current === null) {
      const history = await tx
        .select({ event: schema.productLabelEvents.event })
        .from(schema.productLabelEvents)
        .where(
          and(
            eq(schema.productLabelEvents.tenantId, tenantId),
            eq(schema.productLabelEvents.deviceId, deviceId),
            eq(schema.productLabelEvents.jobId, event.jobId),
            eq(schema.productLabelEvents.receiveStatus, "accepted"),
          ),
        )
        .orderBy(schema.productLabelEvents.sequence);
      for (const fact of history) {
        const saved = productLabelEventSchema.parse(fact.event);
        current = applyProductLabelEvent(current, saved, policy.verification);
        if (saved.kind === "prepared") attemptIds.add(saved.attemptId);
      }
      if (
        !current ||
        current.latestSequence !== job.latestSequence ||
        productLabelValueDigest(current) !== productLabelValueDigest(job.projection)
      )
        throw new Error("PRODUCT_LABEL_STORED_HISTORY_INVALID");
    }
    if (event.sequence !== (current?.latestSequence ?? 0) + 1) return "sequence_gap";
    if (event.kind === "prepared" && attemptIds.has(event.attemptId)) return "invalid_transition";
    if (current === null && event.operatorId !== matchingScan.operatorId)
      return "invalid_transition";
    let projection: ProductLabelProjection;
    try {
      projection = applyProductLabelEvent(current, event, policy.verification);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return "invalid_transition";
    }
    if (current === null) {
      // The tenant registry lock also serializes the first job for an accepted physical unit.
      const [sameAcceptance] = await tx
        .select({ jobId: schema.productLabelJobs.jobId })
        .from(schema.productLabelJobs)
        .where(
          and(
            eq(schema.productLabelJobs.tenantId, tenantId),
            eq(schema.productLabelJobs.deviceId, deviceId),
            eq(schema.productLabelJobs.shiftId, event.shiftId),
            eq(schema.productLabelJobs.codeHash, event.codeHash),
            eq(schema.productLabelJobs.acceptedAt, acceptedAt),
          ),
        )
        .limit(1);
      if (sameAcceptance) return "invalid_transition";
      await tx.insert(schema.productLabelJobs).values({
        tenantId,
        deviceId,
        jobId: event.jobId,
        shiftId: event.shiftId,
        codeHash: event.codeHash,
        acceptedAt,
        policyRevision: event.policyRevision,
        templateDigest: event.templateDigest,
        payloadDigest: event.payloadDigest,
        latestSequence: event.sequence,
        projection: { ...projection },
      });
    } else {
      await tx
        .update(schema.productLabelJobs)
        .set({
          latestSequence: event.sequence,
          projection: { ...projection },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.productLabelJobs.tenantId, tenantId),
            eq(schema.productLabelJobs.deviceId, deviceId),
            eq(schema.productLabelJobs.jobId, event.jobId),
          ),
        );
    }
    await tx.insert(schema.productLabelEvents).values({
      tenantId,
      deviceId,
      eventId: event.eventId,
      jobId: event.jobId,
      sequence: event.sequence,
      operatorId: event.operatorId,
      event: { ...event },
      payloadDigest: productLabelValueDigest(event),
      receiveStatus: "accepted",
      reasonCode: null,
    });
    currentById.set(event.jobId, projection);
    newlyTouchedShiftIds.add(event.shiftId);
    if (event.kind === "prepared") attemptIds.add(event.attemptId);
    attemptIdsByJob.set(event.jobId, attemptIds);
    return null;
  }
}
