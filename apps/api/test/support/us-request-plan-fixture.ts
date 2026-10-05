import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  type GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { Db } from "@markiro/db";
import type { UsPlanSections } from "@markiro/domain";
import { loadUsPlanArtifactStorageConfig } from "../../src/modules/traceability/plans/us-plan-artifact-config";
import {
  UsPlanArtifactStore,
  type UsPlanArtifactS3Transport,
} from "../../src/modules/traceability/plans/us-plan-artifacts";
import { UsPlanApprovalStore } from "../../src/modules/traceability/plans/us-plan-approval";
import { UsPlanStore } from "../../src/modules/traceability/plans/us-plan-store";

type Command = PutObjectCommand | GetObjectCommand | HeadObjectCommand | DeleteObjectCommand;
const bucket = "synthetic-request-plan-test";

/** Fixture-owned provider boundary; approval and default PDF rendering stay real. */
class RequestPlanTransport implements UsPlanArtifactS3Transport {
  readonly calls: { command: string; key: string }[] = [];
  fault: "unavailable" | "type" | "length" | "body" | "oversize" | null = null;
  lastBody: Readable | null = null;
  constructor(readonly objects: Map<string, Buffer>) {}

  async send(command: Command, options: { abortSignal: AbortSignal }): Promise<unknown> {
    const key = command.input.Key;
    if (!key || command.input.Bucket !== bucket || options.abortSignal.aborted)
      throw new Error("Invalid synthetic scope");
    this.calls.push({ command: command.constructor.name, key });
    if (command instanceof PutObjectCommand) {
      if (
        this.objects.has(key) ||
        command.input.IfNoneMatch !== "*" ||
        command.input.ContentType !== "application/pdf" ||
        !(command.input.Body instanceof Uint8Array)
      )
        throw new Error("Invalid synthetic publication");
      this.objects.set(key, Buffer.from(command.input.Body));
      return {};
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(key);
      return {};
    }
    const bytes = this.objects.get(key);
    if (!bytes) throw Object.assign(new Error("Missing synthetic object"), { name: "NoSuchKey" });
    if (command instanceof HeadObjectCommand) return {};
    if (this.fault === "unavailable") throw new Error(`private@example.test ${key}`);
    this.lastBody =
      this.fault === "body"
        ? Readable.from(
            (async function* () {
              yield Buffer.from(bytes.subarray(0, 1));
              throw new Error(`private@example.test ${key}`);
            })(),
          )
        : Readable.from([this.fault === "oversize" ? Buffer.alloc(8_000_001) : Buffer.from(bytes)]);
    return {
      Body: this.lastBody,
      ContentType: this.fault === "type" ? "text/html" : "application/pdf",
      ContentLength: this.fault === "length" ? bytes.length + 1 : bytes.length,
    };
  }
  destroy() {
    this.lastBody?.destroy();
    this.objects.clear();
    this.calls.length = 0;
  }
}

export function createUsRequestPlanFixture(db: Db, c: { tenant: string; actor: string }) {
  const config = loadUsPlanArtifactStorageConfig({
    NODE_ENV: "test",
    MARKIRO_DEPLOYMENT_EDITION: "US",
    US_PLAN_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
    US_PLAN_ARTIFACT_S3_REGION: "us-east-1",
    US_PLAN_ARTIFACT_S3_BUCKET: bucket,
    US_PLAN_ARTIFACT_S3_ACCESS_KEY_ID: "synthetic",
    US_PLAN_ARTIFACT_S3_SECRET_ACCESS_KEY: "synthetic",
    US_PLAN_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
  });
  if (!config) throw new Error("Missing isolated fixture configuration");
  const objects = new Map<string, Buffer>();
  const transport = new RequestPlanTransport(objects);
  const artifacts = new UsPlanArtifactStore(config, transport);
  const drafts = new UsPlanStore(db);
  const approvals = new UsPlanApprovalStore(db, artifacts);
  const sections: UsPlanSections = {
    recordMaintenance: {
      systemOfRecord: "Synthetic register",
      formats: ["PDF"],
      recordLocations: ["Synthetic QA cabinet"],
      responsibleRoles: ["QA"],
      backupAndRecovery: "Synthetic operator backup and recovery procedure",
      narrative: [],
    },
    ftlIdentification: { procedure: "Review FTL", reviewCadence: "On change" },
    tlcAssignment: { procedure: "Assign at processing" },
    pointOfContact: {
      name: "Synthetic QA",
      title: "QA",
      phone: "+1 555 0100",
      email: "qa@example.test",
    },
    farmActivity: { status: "no", explanation: "No farming" },
    reviewAndUpdate: { procedure: "Update on change" },
  };
  return {
    artifacts,
    objects,
    transport,
    async approve(changeSummary: string) {
      const draft = await drafts.createDraft(
        c.tenant,
        c.actor,
        { sections, changeSummary },
        "plan-fixture-create",
      );
      return approvals.approve(
        c.tenant,
        c.actor,
        {
          versionId: draft.id,
          expectedRevision: draft.draftRevision,
          idempotencyKey: randomUUID(),
          confirmations: {
            procedures: true,
            backupAndRecovery: true,
            contact: true,
            nonFarmScope: true,
          },
        },
        "plan-fixture-approve",
      );
    },
    destroy() {
      artifacts.onModuleDestroy();
      transport.destroy();
    },
  };
}
