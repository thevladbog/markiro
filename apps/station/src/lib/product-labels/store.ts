import {
  applyProductLabelEvent,
  DomainError,
  productLabelEventSchema,
  productLabelValueDigest,
  type ProductLabelProjection,
  type ProductLabelEvent,
  type ProductLabelEventBase,
} from "@markiro/domain";
import { z } from "zod";
import type { SqlExecutor } from "../mirror.js";
import type {
  ProductLabelJobView,
  ProductLabelActor,
  StoredProductLabelAttempt,
  StoredProductLabelJob,
} from "./types.js";
import { parseProductLabelAcceptance } from "./validation.js";

function invalidStoredJob(): never {
  throw new DomainError(
    "PRODUCT_LABEL_STORAGE_INVALID",
    "Saved product label context is inconsistent",
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return invalidStoredJob();
  }
}

export async function readProductLabelJob(
  exec: SqlExecutor,
  credentialOwnership: string,
  jobId: string,
): Promise<StoredProductLabelJob | null> {
  // One read snapshot: a concurrent append cannot mix the previous projection with later events.
  const [row] = await exec.all<{
    acceptance_json: string;
    command_digest: string;
    projection_json: string;
    status: string;
    ownership_conflict: number;
    updated_at: string;
    events_json: string;
    attempts_json: string;
  }>(
    `SELECT command.acceptance_json, command.command_digest,
        job.projection_json, job.status, job.ownership_conflict, job.updated_at,
        (SELECT json_group_array(json(event_json)) FROM (
          SELECT event_json FROM product_label_events
          WHERE credential_ownership = job.credential_ownership AND job_id = job.job_id
          ORDER BY sequence
        )) AS events_json,
        (SELECT json_group_array(json_object('prepared', json(prepared_json), 'state', state,
          'verifiedAt', verified_at, 'verifiedBy', verified_by)) FROM (
          SELECT prepared_json, state, verified_at, verified_by FROM product_label_attempts
          WHERE credential_ownership = job.credential_ownership AND job_id = job.job_id
          ORDER BY attempt_no
        )) AS attempts_json
      FROM product_label_jobs job
      JOIN product_label_accept_commands command
        ON command.credential_ownership = job.credential_ownership AND command.job_id = job.job_id
      WHERE job.credential_ownership = ? AND job.job_id = ?`,
    [credentialOwnership, jobId],
  );
  if (!row) return null;
  const input = parseProductLabelAcceptance(parseJson(row.acceptance_json));
  if (
    input.credentialOwnership !== credentialOwnership ||
    input.jobId !== jobId ||
    productLabelValueDigest(input) !== row.command_digest
  )
    invalidStoredJob();
  const parsedEvents = z
    .array(productLabelEventSchema)
    .nonempty()
    .safeParse(parseJson(row.events_json));
  if (!parsedEvents.success) invalidStoredJob();
  let projection: ProductLabelProjection | null = null;
  const attempts: StoredProductLabelAttempt[] = [];
  for (const event of parsedEvents.data) {
    if (
      projection === null &&
      productLabelValueDigest(event) !== productLabelValueDigest(input.preparedEvent)
    )
      invalidStoredJob();
    projection = applyProductLabelEvent(projection, event, input.policy.verification);
    if (event.kind === "prepared") {
      attempts.push({ prepared: event, state: "prepared", verifiedAt: null, verifiedBy: null });
    } else {
      const attempt = attempts.at(-1);
      if (!attempt) invalidStoredJob();
      attempt.state = projection.attemptState;
      if (event.kind === "verified") {
        attempt.verifiedAt = event.occurredAt;
        attempt.verifiedBy = event.operatorId;
      }
    }
  }
  if (
    projection === null ||
    row.status !== projection.status ||
    productLabelValueDigest(projection) !==
      productLabelValueDigest(parseJson(row.projection_json)) ||
    productLabelValueDigest(attempts) !== productLabelValueDigest(parseJson(row.attempts_json)) ||
    ![0, 1].includes(row.ownership_conflict) ||
    !z.iso.datetime().safeParse(row.updated_at).success
  )
    invalidStoredJob();
  return {
    ...input,
    projection,
    attempts,
    ownershipConflict: row.ownership_conflict === 1,
    updatedAt: row.updated_at,
  };
}

export async function hasUnresolvedProductLabelJob(
  exec: SqlExecutor,
  credentialOwnership: string,
  shiftId?: string,
): Promise<boolean> {
  const [row] = await exec.all<{ job_id: string }>(
    `SELECT job_id FROM product_label_jobs WHERE credential_ownership = ? AND status <> 'completed'
       ${shiftId === undefined ? "" : "AND shift_id = ?"} LIMIT 1`,
    shiftId === undefined ? [credentialOwnership] : [credentialOwnership, shiftId],
  );
  return row !== undefined;
}

export function presentProductLabelJob(job: StoredProductLabelJob): ProductLabelJobView {
  return {
    jobId: job.jobId,
    shiftId: job.shiftId,
    codeSuffix: Array.from(job.serial).slice(-6).join(""),
    attemptId: job.projection.attemptId,
    attemptNo: job.projection.attemptNo,
    language: job.projection.language,
    dpi: job.projection.dpi,
    status: job.projection.status,
    attemptState: job.projection.attemptState,
    verification: job.projection.verification,
    verificationOutcome: job.projection.verificationOutcome,
    ownershipConflict: job.ownershipConflict,
    acceptedAt: job.acceptedAt,
    updatedAt: job.updatedAt,
  };
}

export async function requireProductLabelJob(
  exec: SqlExecutor,
  credentialOwnership: string,
  jobId: string,
): Promise<StoredProductLabelJob> {
  const job = await readProductLabelJob(exec, credentialOwnership, jobId);
  if (!job)
    throw new DomainError(
      "PRODUCT_LABEL_JOB_MISSING",
      "Product label job is unavailable for this credential",
    );
  return job;
}

export function nextProductLabelEventBase(
  job: StoredProductLabelJob,
  actor: ProductLabelActor,
): ProductLabelEventBase {
  return {
    eventId: actor.newId(),
    jobId: job.jobId,
    attemptId: job.projection.attemptId,
    sequence: job.projection.latestSequence + 1,
    shiftId: job.shiftId,
    codeHash: job.codeHash,
    acceptedAt: job.acceptedAt,
    policyRevision: job.policy.policyRevision,
    templateDigest: job.policy.snapshot.digest,
    payloadDigest: job.projection.payloadDigest,
    operatorId: actor.operatorId,
    occurredAt: actor.now(),
  };
}

/** The random command token distinguishes our successful claim from a simultaneous replay. */
export async function appendProductLabelEvent(
  exec: SqlExecutor,
  credentialOwnership: string,
  input: ProductLabelEvent,
  options: { recovery?: boolean } = {},
): Promise<"applied" | "replayed" | "stale"> {
  const event = productLabelEventSchema.parse(input);
  const digest = productLabelValueDigest(event);
  const [existing] = await exec.all<{ event_json: string }>(
    "SELECT event_json FROM product_label_events WHERE credential_ownership=? AND event_id=?",
    [credentialOwnership, event.eventId],
  );
  if (existing) {
    if (productLabelValueDigest(parseJson(existing.event_json)) !== digest)
      throw new DomainError(
        "PRODUCT_LABEL_EVENT_ID_CONFLICT",
        "Product label event ID already contains different data",
      );
    return "replayed";
  }
  const job = await requireProductLabelJob(exec, credentialOwnership, event.jobId);
  if (event.sequence !== job.projection.latestSequence + 1) return "stale";
  const projection = applyProductLabelEvent(job.projection, event, job.policy.verification);
  const token = crypto.randomUUID();
  try {
    await exec.run(
      `INSERT INTO product_label_event_commands
      (credential_ownership,event_id,job_id,command_token,event_digest,expected_sequence,expected_attempt_id,event_json,projection_json,recovery)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(credential_ownership,event_id) DO NOTHING`,
      [
        credentialOwnership,
        event.eventId,
        event.jobId,
        token,
        digest,
        job.projection.latestSequence,
        job.projection.attemptId,
        JSON.stringify(event),
        JSON.stringify(projection),
        options.recovery ? 1 : 0,
      ],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("PRODUCT_LABEL_STALE")) return "stale";
    if (message.includes("PRODUCT_LABEL_OWNERSHIP_CONFLICT"))
      throw new DomainError(
        "PRODUCT_LABEL_OWNERSHIP_CONFLICT",
        "The accepted code is no longer available for printing on this station",
      );
    if (message.includes("PRODUCT_LABEL_BUSY"))
      throw new DomainError(
        "PRODUCT_LABEL_BUSY",
        "Finish the current product label before reprinting another unit",
      );
    throw error;
  }
  const [command] = await exec.all<{ command_token: string; event_digest: string }>(
    "SELECT command_token,event_digest FROM product_label_event_commands WHERE credential_ownership=? AND event_id=?",
    [credentialOwnership, event.eventId],
  );
  if (!command) invalidStoredJob();
  if (command.event_digest !== digest)
    throw new DomainError(
      "PRODUCT_LABEL_EVENT_ID_CONFLICT",
      "Product label event ID already contains different data",
    );
  return command.command_token === token ? "applied" : "replayed";
}

export async function listProductLabelJobViews(
  exec: SqlExecutor,
  owner: string,
  shiftId: string,
): Promise<ProductLabelJobView[]> {
  const rows = await exec.all<{ job_id: string }>(
    "SELECT job_id FROM product_label_jobs WHERE credential_ownership=? AND shift_id=? ORDER BY updated_at DESC,job_id DESC LIMIT 100",
    [owner, shiftId],
  );
  const result: ProductLabelJobView[] = [];
  for (const row of rows)
    result.push(presentProductLabelJob(await requireProductLabelJob(exec, owner, row.job_id)));
  return result;
}
