import {
  HttpException,
  ServiceUnavailableException,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { createDb } from "@markiro/db";
import type { Env } from "../env";
import { createUsAuth, type UsAuth } from "../modules/traceability/auth/us-auth";
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

/** Owns only the explicitly supplied US pool; never imports RU application providers. */
export class UsRuntime implements OnApplicationShutdown {
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

  constructor(
    readonly env: Env,
    readonly connection: ReturnType<typeof createDb>,
  ) {
    this.auth = createUsAuth(connection.db, {
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
      trustedOrigins: [env.ADMIN_ORIGIN],
    });
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
    // Idle-pool failures must not crash the metadata/liveness process or log SQL.
    connection.pool.on("error", () => {});
  }

  async onApplicationShutdown(): Promise<void> {
    await this.connection.pool.end();
  }

  /** Read-only preflight. Startup never migrates, seeds or repairs a database. */
  async assertDatabaseReady(): Promise<void> {
    await this.databaseOperation(async () => {
      // LIMIT 0 validates the columns needed by the newest US migrations too.
      await this.connection.pool.query(`
        SELECT u.two_factor_enabled, f.failed_verification_count, f.locked_until,
               a.verified_at, p.baseline_version, o.time_zone, t.request_id,
               shipping_root.lifecycle_version, shipping_detail.recipient_snapshot,
               shipping_item.tlc_snapshot, shipping_document.position,
               shipping_operation.input_digest, shipping_counter.sequence
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
             session, account, verification, organization, member, invitation
        LIMIT 0
      `);
    });
  }

  async databaseOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({ code: "us_database_unavailable" });
    }
  }
}
