import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";
import { canonicalExportDigest } from "./us-demo-canonical.js";
import { readRequestSelection, checkRequestSelection } from "./us-dataset-request-selection.js";
import {
  equalRequest,
  requestError,
  requestUnitSchema,
  parseRequestValue,
  type UsDatasetRequestServices,
  type UsDatasetRequestUnitKey,
  type UsDatasetRequestResult,
} from "./us-dataset-request-contract.js";
import {
  readOwnedRequest,
  readOwnedRun,
  readOwnedPublication,
  verifyRequestBytes,
  requestReceipt,
  resultReceipt,
  runPin,
} from "./us-dataset-request-verify.js";
import { UsRequestStore } from "../requests/us-request-store.js";
import { UsRequestValidationStore } from "../requests/us-request-validation.js";
import { UsRequestPrepareStore } from "../requests/us-request-prepare.js";
import { captureUsRequestScope } from "../requests/us-request-snapshot.js";
import { captureUsRequestTenantOrigin } from "../requests/us-request-tenant-origin.js";
import { UsRequestWorker } from "../requests/us-request-worker.js";
import { UsRequestWorkerLifecycle } from "../requests/us-request-worker-lifecycle.js";
import { UsRequestWorkerCheckpoints } from "../requests/us-request-worker-checkpoint.js";
import { UsRequestWorkerPublication } from "../requests/us-request-worker-publication.js";
import { UsRequestWorkerCleanup } from "../requests/us-request-worker-cleanup.js";
import { UsRequestPlanReader } from "../requests/us-request-plan-reader.js";
import { assertUsRequestWorkerExecutionIdentity } from "../requests/us-request-worker-execution.js";

export type {
  UsDatasetRequestServices,
  UsDatasetRequestUnitKey,
  UsDatasetRequestResult,
} from "./us-dataset-request-contract.js";

/** Closed adapter: only native ownership, commands, scoped worker and private storage. */
export class UsDatasetRequestSeedStore {
  private readonly journal: UsDatasetJournalStore;
  constructor(
    private readonly db: Db,
    private readonly services: UsDatasetRequestServices,
  ) {
    this.journal = new UsDatasetJournalStore(db, usSixMonthDefinition);
  }
  initialize(
    context: UsDatasetContext,
    unitKey: UsDatasetRequestUnitKey,
  ): Promise<UsDatasetRequestResult> {
    return this.execute(context, unitKey, true);
  }
  verify(
    context: UsDatasetContext,
    unitKey: UsDatasetRequestUnitKey,
  ): Promise<UsDatasetRequestResult> {
    return this.execute(context, unitKey, false);
  }
  private async execute(
    context: UsDatasetContext,
    rawUnit: UsDatasetRequestUnitKey,
    initialize: boolean,
  ) {
    const header = await this.journal.read(context);
    const unitKey = parseRequestValue(requestUnitSchema, rawUnit);
    if (!header) throw requestError("incomplete");
    assertUsRequestWorkerExecutionIdentity(this.services.execution);
    const selected = await readRequestSelection(this.db, context, unitKey, this.services);
    const identity = {
      datasetId: header.id,
      version: header.version,
      definitionDigest: header.definitionDigest,
      unitKey,
    };
    const readRequest = async () =>
      this.db.transaction(
        async (tx) => {
          const stage = await this.journal.readStageInTransaction(
            tx,
            context,
            header.id,
            unitKey,
            "request",
          );
          if (!stage) throw requestError("incomplete");
          const request = await readOwnedRequest(
            tx,
            this.db,
            this.journal,
            context,
            stage,
            selected,
            this.services,
          );
          return { stage, request };
        },
        { isolationLevel: "repeatable read" },
      );
    let requestStage = await this.journal.readStage(context, header.id, unitKey, "request");
    if (!requestStage && initialize) {
      const operationKey = randomUUID();
      requestStage = await this.journal.prepareStageIntent(
        context,
        header.id,
        { unitKey, stage: "request", operationKey },
        async (tx, checked) => {
          const receivedAt = new Date().toISOString();
          const command = {
            requestNumber: selected.recipe.reference,
            requesterName: "Synthetic demonstration requester",
            requesterOrganization: "Synthetic demonstration only",
            requesterContact: "requester@example.test",
            receivedAt,
            dueAt: new Date(Date.parse(receivedAt) + 86_400_000).toISOString(),
            alternateDeadlineReason: null,
            scope: selected.scope,
          };
          const row = await new UsRequestStore(this.db).createCommandInTransaction(
            tx,
            checked.tenantId,
            checked.actorUserId,
            command,
            operationKey,
          );
          const capture = await captureUsRequestScope(
            tx,
            checked.tenantId,
            checked.actorUserId,
            row,
            this.services.execution.build,
            await captureUsRequestTenantOrigin(this.db, tx, checked.tenantId),
          );
          checkRequestSelection(capture.snapshot, selected);
          const input = {
            ...identity,
            command,
            request: {
              id: row.id,
              revision: row.revision,
              receivedAt: row.receivedAt.toISOString(),
              dueAt: row.dueAt.toISOString(),
            },
            sourceDigest: capture.digest,
            projectionDigest: selected.projectionDigest,
            planDigest: canonicalExportDigest(selected.plan),
          };
          return {
            unitKey,
            stage: "request",
            operationKey,
            input,
            inputDigest: canonicalExportDigest(input),
          };
        },
      );
    }
    if (!requestStage || (!initialize && !requestStage.receipt)) throw requestError("incomplete");
    let current = await readRequest();
    if (!current.stage.receipt) {
      const verify = async (
        tx: Parameters<typeof readOwnedRequest>[0],
        checked: UsDatasetContext,
      ) =>
        requestReceipt(
          (
            await readOwnedRequest(
              tx,
              this.db,
              this.journal,
              checked,
              current.stage,
              selected,
              this.services,
            )
          ).input,
        );
      await this.journal.runAtomicStage(
        context,
        header.id,
        current.stage.revision,
        current.stage.intent,
        {
          apply: verify,
          verify: async (tx, checked, _intent, saved) =>
            equalRequest(saved, await verify(tx, checked)),
        },
      );
      current = await readRequest();
    }
    let packageStage = await this.journal.readStage(context, header.id, unitKey, "package");
    if (!packageStage && initialize) {
      const validation = await new UsRequestValidationStore(this.db).validateHttp(
        context.tenantId,
        context.actorUserId,
        current.request.row.id,
        { expectedRevision: current.request.row.revision },
        this.services.execution.build,
        current.stage.intent.operationKey,
      );
      equalRequest(validation.digest, current.request.input.sourceDigest);
      if (validation.findings.some((finding) => finding.severity !== "info"))
        throw requestError("conflict");
      const operationKey = randomUUID();
      packageStage = await this.journal.prepareStageIntent(
        context,
        header.id,
        { unitKey, stage: "package", operationKey },
        async (tx, checked) => {
          const owned = await readOwnedRequest(
            tx,
            this.db,
            this.journal,
            checked,
            current.stage,
            selected,
            this.services,
          );
          const run = await new UsRequestPrepareStore(this.db).prepareCommandInTransaction(
            tx,
            checked.tenantId,
            checked.actorUserId,
            owned.row.id,
            {
              expectedRevision: owned.row.revision,
              validationDigest: owned.input.sourceDigest,
              idempotencyKey: operationKey,
              mode: "export_ready",
            },
            this.services.execution.build,
            operationKey,
          );
          const input = {
            ...identity,
            requestDigest: canonicalExportDigest(owned.input),
            run: runPin(run),
          };
          return {
            unitKey,
            stage: "package",
            operationKey,
            input,
            inputDigest: canonicalExportDigest(input),
          };
        },
      );
    }
    if (!packageStage || (!initialize && !packageStage.receipt)) throw requestError("incomplete");
    const boundStage = packageStage;
    const probe = () =>
      this.db.transaction(
        async (tx) => {
          const stage = await this.journal.readStageInTransaction(
            tx,
            context,
            header.id,
            unitKey,
            "package",
          );
          if (!stage) throw requestError("incomplete");
          equalRequest(stage.intent, boundStage.intent);
          const request = await readOwnedRequest(
            tx,
            this.db,
            this.journal,
            context,
            current.stage,
            selected,
            this.services,
          );
          const owned = await readOwnedRun(tx, context, stage, request);
          const published =
            owned.run.status === "ready"
              ? await readOwnedPublication(tx, context, request, owned, selected, this.services)
              : null;
          if (stage.receipt) {
            if (!published) throw requestError("conflict");
            equalRequest(stage.receipt, resultReceipt(published.result));
          }
          return { stage, owned, published };
        },
        { isolationLevel: "repeatable read" },
      );
    let live = await probe();
    if (!live.published && !live.stage.receipt) {
      const lifecycle = new UsRequestWorkerLifecycle(this.db);
      const worker = new UsRequestWorker(this.db, {
        lifecycle,
        checkpoints: new UsRequestWorkerCheckpoints(this.db, lifecycle),
        publication: new UsRequestWorkerPublication(this.db, lifecycle),
        cleanup: new UsRequestWorkerCleanup(this.db, this.services.packageArtifacts),
        storage: this.services.packageArtifacts,
        planReader: new UsRequestPlanReader(this.db, this.services.planArtifacts),
        execution: this.services.execution,
      });
      await worker.runScoped({ tenantId: context.tenantId, runId: live.owned.run.id });
      live = await probe();
    }
    const verified = live.published;
    if (!verified) throw requestError("incomplete");
    await verifyRequestBytes(this.db, this.services, verified);
    if (live.stage.receipt) {
      const final = await probe();
      if (!final.published || !final.stage.receipt) throw requestError("conflict");
      equalRequest(final.published.result, verified.result);
      equalRequest(final.published.checkpoint, verified.checkpoint);
      return verified.result;
    }
    const receipt = resultReceipt(verified.result);
    const final = async (tx: Parameters<typeof readOwnedRequest>[0], checked: UsDatasetContext) => {
      const request = await readOwnedRequest(
        tx,
        this.db,
        this.journal,
        checked,
        current.stage,
        selected,
        this.services,
      );
      const owned = await readOwnedRun(tx, checked, live.stage, request);
      const publication = await readOwnedPublication(
        tx,
        checked,
        request,
        owned,
        selected,
        this.services,
      );
      equalRequest(publication.result, verified.result);
      equalRequest(publication.checkpoint, verified.checkpoint);
      return receipt;
    };
    await this.journal.runAtomicStage(context, header.id, live.stage.revision, live.stage.intent, {
      apply: final,
      verify: async (tx, checked, _intent, saved) => equalRequest(saved, await final(tx, checked)),
    });
    return verified.result;
  }
}
