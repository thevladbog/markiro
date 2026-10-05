import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";
import {
  renderUsRequestPayloads,
  type UsRequestPayloadResult,
} from "../../src/modules/traceability/requests/us-request-payloads";
import {
  UsRequestPlanReader,
  type UsRequestPinnedPlanResult,
} from "../../src/modules/traceability/requests/us-request-plan-reader";
import type { UsRequestReportContext } from "../../src/modules/traceability/requests/us-request-package-types";
import type { UsTraceExportRunRow } from "../../src/modules/traceability/requests/us-request-run-evidence";
import { UsRequestPrepareStore } from "../../src/modules/traceability/requests/us-request-prepare";
import { UsRequestStore } from "../../src/modules/traceability/requests/us-request-store";
import { UsRequestValidationStore } from "../../src/modules/traceability/requests/us-request-validation";
import { seedCompleteReceiving } from "./us-receiving-fixture";
import { finalizeUsRequestPayloadReceiving } from "./us-request-payload-fixture";
import { createUsRequestPlanFixture } from "./us-request-plan-fixture";

export async function createUsRequestPackageFixture(
  db: Db,
  options: { mode: UsRequestPayloadResult["mode"]; empty?: boolean; withPlan?: boolean },
): Promise<{
  tenantId: string;
  actorId: string;
  request: Awaited<ReturnType<UsRequestStore["create"]>>;
  run: UsTraceExportRunRow;
  payloads: UsRequestPayloadResult;
  plan: UsRequestPinnedPlanResult;
  context: UsRequestReportContext;
  planFixture: ReturnType<typeof createUsRequestPlanFixture>;
  destroy(): void;
}> {
  const c = await seedCompleteReceiving(db);
  const planFixture = createUsRequestPlanFixture(db, c);
  try {
    if (!options.empty) await finalizeUsRequestPayloadReceiving(db, c);
    if (options.withPlan !== false) await planFixture.approve("Synthetic package Plan");
    const build = { apiVersion: "test-us09-package", gitSha: "a".repeat(40), dirty: false };
    const request = await new UsRequestStore(db).create(c.tenant, c.actor, {
      requestNumber: randomUUID(),
      requesterName: "Synthetic package requester",
      requesterOrganization: "Synthetic organization",
      requesterContact: "private@example.test",
      receivedAt: "2026-10-04T00:00:00Z",
      scope: options.empty ? { tlcs: ["NO-MATCH-PACKAGE-FIXTURE"] } : { lotId: c.lot },
    });
    await new UsRequestValidationStore(db).validate(c.tenant, c.actor, request.id, build);
    const run = await new UsRequestPrepareStore(db).prepare(
      c.tenant,
      c.actor,
      request.id,
      {
        mode: options.mode,
        idempotencyKey: randomUUID(),
      },
      build,
    );
    const payloads = await renderUsRequestPayloads(run, c.tenant);
    const plan = await new UsRequestPlanReader(db, planFixture.artifacts).read(run, c.tenant);
    return {
      tenantId: c.tenant,
      actorId: c.actor,
      request,
      run,
      payloads,
      plan,
      // Synthetic offsets exercise chronology; they are not measured operation time.
      context: {
        schemaVersion: 1,
        workerStartedAt: new Date(run.startedAt.getTime() + 1000).toISOString(),
        reportDataPreparedAt: new Date(run.startedAt.getTime() + 2000).toISOString(),
      },
      planFixture,
      destroy() {
        planFixture.destroy();
      },
    };
  } catch (error) {
    planFixture.destroy();
    throw error;
  }
}
