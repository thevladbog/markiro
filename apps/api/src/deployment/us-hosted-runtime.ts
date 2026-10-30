import {
  HttpException,
  ServiceUnavailableException,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { createDb } from "@markiro/db";
import { UsHostedRequestHttpRuntime } from "./us-hosted-request-http-runtime";
import type { UsAuth } from "../modules/traceability/auth/us-auth";
import { createUsHostedAuth } from "../modules/traceability/auth/us-hosted-auth";
import { UsCatalogStore } from "../modules/traceability/catalog/us-catalog-store";
import { UsLotStore } from "../modules/traceability/lots/us-lot-store";
import { UsProductProfileStore } from "../modules/traceability/products/us-product-profile-store";
import { UsProfileStore } from "../modules/traceability/profile/us-profile-store";
import { UsMasterDataStore } from "../modules/traceability/master-data/us-master-data-store";
import { UsReferenceDocumentStore } from "../modules/traceability/documents/us-reference-document-store";
import { UsReceivingStore } from "../modules/traceability/receiving/us-receiving-store";
import { UsReceivingCsvStore } from "../modules/traceability/receiving/us-receiving-csv-store";
import { UsCaseStore } from "../modules/traceability/cases/us-case-store";
import { UsTransformationStore } from "../modules/traceability/transformation/us-transformation-store";
import { UsShippingStore } from "../modules/traceability/shipping/us-shipping-store";
import { UsEventsStore } from "../modules/traceability/events/us-events-store";
import { UsTraceStore } from "../modules/traceability/trace/us-trace-store";
import { UsPlanReadStore } from "../modules/traceability/plans/us-plan-read";
import { UsPlanStore } from "../modules/traceability/plans/us-plan-store";
import { UsPlanInspectionStore } from "../modules/traceability/plans/us-plan-inspection";
import { UsPlanApprovalStore } from "../modules/traceability/plans/us-plan-approval";
import { UsPlanArtifactStore } from "../modules/traceability/plans/us-plan-artifacts";
import type { UsBusinessRuntimeView } from "./us-business-runtime-view";
import type { UsHttpRuntime } from "./us-http-runtime";
import {
  assertUsHostedRelease,
  usHostedReleaseIdentity,
  type VerifiedUsHostedRelease,
} from "./us-hosted-release-verifier";
import { assertUsHostedMaterial, type UsHostedMaterialOwner } from "./us-hosted-material-owner";

/** Owns the supplied hosted pool and clients; bootstrap retains material/release teardown ownership. */
export class UsHostedRuntime
  implements OnApplicationShutdown, UsBusinessRuntimeView, UsHttpRuntime
{
  readonly auth: UsAuth;
  readonly profiles: UsProfileStore;
  readonly masterData: UsMasterDataStore;
  readonly catalog: UsCatalogStore;
  readonly lots: UsLotStore;
  readonly productProfiles: UsProductProfileStore;
  readonly referenceDocuments: UsReferenceDocumentStore;
  readonly receiving: UsReceivingStore;
  readonly receivingCsv: UsReceivingCsvStore;
  readonly cases: UsCaseStore;
  readonly transformation: UsTransformationStore;
  readonly shipping: UsShippingStore;
  readonly events: UsEventsStore;
  readonly trace: UsTraceStore;
  readonly planRead: UsPlanReadStore;
  readonly planDrafts: UsPlanStore;
  readonly planInspection: UsPlanInspectionStore;
  readonly planApproval: UsPlanApprovalStore;
  readonly requestHttp: UsHostedRequestHttpRuntime;
  readonly env: UsHttpRuntime["env"];
  readonly connection: Readonly<Pick<ReturnType<typeof createDb>, "db">>;
  readonly #connection: ReturnType<typeof createDb>;
  readonly #release: VerifiedUsHostedRelease;
  readonly #material: UsHostedMaterialOwner;
  readonly #planArtifactStorage: UsPlanArtifactStore;
  #shutdown: Promise<void> | undefined;
  #stopping = false;

  constructor(release: unknown, material: unknown, connection: ReturnType<typeof createDb>) {
    let plan: UsPlanArtifactStore | undefined;
    let requests: UsHostedRequestHttpRuntime | undefined;
    try {
      assertUsHostedRelease(release);
      assertUsHostedMaterial(material, release, "api");
      const config = usHostedReleaseIdentity(release).config;
      if (config.service !== "api") throw new Error();
      this.#release = release;
      this.#material = material;
      this.#connection = connection;
      this.connection = Object.freeze({ db: connection.db });
      this.env = Object.freeze({
        BETTER_AUTH_URL: config.publicOrigin,
        ADMIN_ORIGIN: config.publicOrigin,
      });
      this.auth = createUsHostedAuth(release, material, connection.db);
      this.profiles = new UsProfileStore(connection.db);
      this.masterData = new UsMasterDataStore(connection.db);
      this.catalog = new UsCatalogStore(connection.db);
      this.lots = new UsLotStore(connection.db);
      this.productProfiles = new UsProductProfileStore(connection.db);
      this.referenceDocuments = new UsReferenceDocumentStore(connection.db);
      this.receiving = new UsReceivingStore(connection.db);
      this.receivingCsv = new UsReceivingCsvStore(connection.db);
      this.cases = new UsCaseStore(connection.db);
      this.transformation = new UsTransformationStore(connection.db);
      this.shipping = new UsShippingStore(connection.db);
      this.events = new UsEventsStore(connection.db);
      this.trace = new UsTraceStore(connection.db);
      plan = UsPlanArtifactStore.createHosted(release, material);
      this.#planArtifactStorage = plan;
      const availability = "available";
      this.planRead = new UsPlanReadStore(connection.db, availability);
      this.planDrafts = new UsPlanStore(connection.db);
      this.planInspection = new UsPlanInspectionStore(connection.db, availability);
      this.planApproval = new UsPlanApprovalStore(connection.db, this.#planArtifactStorage);
      requests = new UsHostedRequestHttpRuntime(connection.db, release, material);
      this.requestHttp = requests;
      // Idle-pool failures must not crash metadata/liveness or log SQL.
      connection.pool.on("error", () => {});
    } catch {
      try {
        requests?.dispose();
      } catch {
        /* Preserve the fixed startup refusal. */
      }
      try {
        plan?.onModuleDestroy();
      } catch {
        /* Continue caller-owned pool cleanup outside construction. */
      }
      throw new ServiceUnavailableException({ code: "us_hosted_runtime_invalid" });
    }
  }

  #assertOwners(): void {
    try {
      if (this.#stopping) throw new Error();
      assertUsHostedRelease(this.#release);
      assertUsHostedMaterial(this.#material, this.#release, "api");
    } catch {
      throw new ServiceUnavailableException({ code: "us_database_unavailable" });
    }
  }

  /** Package/schema presence cannot establish an unadmitted provisioning receipt. */
  assertDeploymentReady(): never {
    throw new ServiceUnavailableException({ code: "us_hosted_provisioning_required" });
  }

  onApplicationShutdown(): Promise<void> {
    // Nest must finish native listener/request settlement before this hook tears down clients.
    this.#stopping = true;
    this.#shutdown ??= (async () => {
      try {
        try {
          this.requestHttp.dispose();
        } finally {
          this.#planArtifactStorage?.onModuleDestroy();
        }
      } finally {
        await this.#connection.pool.end();
      }
    })();
    return this.#shutdown;
  }

  /** Read-only preflight. Startup never migrates, seeds or repairs a database. */
  async assertDatabaseReady(): Promise<void> {
    await this.databaseOperation(async () => {
      await this.#connection.pool.query(`
        SELECT request.revision, request.scope, request.last_validation,
               run.input_snapshot, run.lifecycle_version,
               artifact.kind, artifact.object_key, artifact.byte_size, artifact.sha256,
               attempt.attempt_number, attempt.cycle, attempt.report_rendered_at,
               checkpoint.model, checkpoint.model_digest,
               retry.command_digest, retry.lifecycle_version
        FROM trace_requests request, trace_export_runs run,
             trace_export_artifacts artifact, trace_export_attempts attempt,
             trace_export_render_checkpoints checkpoint, trace_export_retry_receipts retry
        LIMIT 0
      `);
      // LIMIT 0 validates the columns needed by the newest US migrations too.
      await this.#connection.pool.query(`
        SELECT u.two_factor_enabled, f.failed_verification_count, f.locked_until,
               a.verified_at, p.baseline_version, o.time_zone, t.request_id,
               shipping_root.lifecycle_version, shipping_detail.recipient_snapshot,
               shipping_item.tlc_snapshot, shipping_document.position,
               shipping_operation.input_digest, shipping_counter.sequence,
               plan.draft_revision, plan.approved_evidence, plan.pdf_object_key,
               plan.retention_floor, plan.hold_until, plan.indefinite_hold,
               plan_fence.object_key, plan_fence.tenant_id, plan_fence.version_id,
               plan_fence.version_number, plan_fence.actor_user_id, plan_fence.request_id,
               plan_fence.sha256, plan_fence.state
        FROM "user" u, us_two_factors f, us_session_assurances a,
             traceability_profiles p, org_profiles o, tenant_audit_events t,
             trace_lot_boxes case_links, traceability_synthetic_case_origins case_markers,
             trace_lot_box_operations case_operations,
             shipping_event_roots shipping_root,
             shipping_event_details shipping_detail,
             shipping_event_items shipping_item,
             shipping_event_documents shipping_document,
             shipping_operations shipping_operation,
             shipping_counters shipping_counter,
             traceability_plan_versions plan, traceability_plan_cleanup_fences plan_fence,
             session, account, verification, organization, member, invitation
        LIMIT 0
      `);
    });
  }

  async databaseOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      this.#assertOwners();
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({ code: "us_database_unavailable" });
    }
  }
}
