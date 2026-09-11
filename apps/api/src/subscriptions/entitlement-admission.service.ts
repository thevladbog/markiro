import { createHash } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import {
  ENTITLEMENT_OPERATIONS,
  ENTITLEMENT_REGISTRY_VERSION,
  type EntitlementOperationId,
  type EntitlementSnapshotV1,
} from "@markiro/platform-contracts";
import { DB } from "../auth/auth.module";
import { EntitlementsService } from "./entitlements.service";
import { evaluateEntitlementOperation } from "./entitlement-projection";
import type { SubscriptionTransaction } from "./entitlements.types";

/** Internal verified identity from the action owner, never a request DTO. */
export type AdmissionActor = { domain: "cabinet" | "api_key" | "system"; id: string | null };
export interface AdmissionFacts {
  tenantId: string;
  snapshot: EntitlementSnapshotV1 | null;
  capturedAt: Date;
  versionIds: string[];
  proof: string | null;
  policyFingerprint: string | null;
}
export interface EntitlementAdmissionInput {
  facts?: AdmissionFacts | undefined;
  tenantId: string;
  actor: AdmissionActor;
  operationId: EntitlementOperationId;
  scopeDigest: string;
  requestId?: string | undefined;
  /** Current server-owned release/configuration fact, separately timed. */
  runtime?: { enabled: boolean | null; observedAt: Date } | undefined;
  /** Owner already holds its business locks/fence. Does not change owner isolation. */
  transaction?: SubscriptionTransaction | undefined;
  attempt?: { number: number; identity: string } | undefined;
}
export interface EntitlementAdmissionObservation {
  mode: "shadow";
  decision: "allow" | "deny" | "unknown";
  reasons: string[];
  observationId: string | null;
}
export function admissionScopeDigest(value: unknown): string {
  const canonical = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canonical)
      : input !== null && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, canonical(child)]),
          )
        : input;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/** Technical maximum age for an observation, never a commercial/offline grace interval. */
const MAX_OBSERVATION_AGE_MS = 5_000;

/** Commercial observations only. Existing security, subscriptions and quotas own admission. */
@Injectable()
export class EntitlementAdmissionService {
  private readonly logger = new Logger(EntitlementAdmissionService.name);
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
  ) {}

  async capture(tenantId: string): Promise<AdmissionFacts> {
    try {
      return await this.db.transaction(
        async (tx) => {
          const facts = await this.entitlements.resolveSnapshotInTransaction(tenantId, tx);
          return {
            tenantId,
            snapshot: facts.snapshot,
            capturedAt: new Date(),
            versionIds: facts.versionIds,
            proof: await this.currentProof(tx, tenantId, facts.versionIds),
            policyFingerprint: facts.policyFingerprint,
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    } catch {
      this.logger.error("entitlement_shadow_calculation_failed");
      return {
        tenantId,
        snapshot: null,
        capturedAt: new Date(),
        versionIds: [],
        proof: null,
        policyFingerprint: null,
      };
    }
  }
  async observe(input: EntitlementAdmissionInput): Promise<EntitlementAdmissionObservation> {
    let snapshot: EntitlementSnapshotV1 | null = null;
    let policyFingerprint: string | null = null;
    let decision: EntitlementAdmissionObservation["decision"] = "unknown";
    let reasons = ["shadow_calculation_failed"];
    try {
      if (!/^[0-9a-f]{64}$/.test(input.scopeDigest)) throw new Error("invalid_scope_digest");
      // Never acquire a second pool connection while an owner transaction is open.
      // Capture immediately before the owner transaction; facts describe committed data at asOf.
      const facts = input.facts ?? (input.transaction ? null : await this.capture(input.tenantId));
      if (!facts || facts.tenantId !== input.tenantId || !facts.snapshot)
        throw new Error("snapshot_missing");
      snapshot = facts.snapshot;
      policyFingerprint = facts.policyFingerprint;
      if (
        input.transaction &&
        (await input.transaction.transaction((tx) =>
          this.currentProof(tx, input.tenantId, facts.versionIds),
        )) !== facts.proof
      ) {
        reasons = ["shadow_snapshot_stale"];
        throw new Error("snapshot_stale");
      }
      if (
        Date.now() - Date.parse(snapshot.asOf) > MAX_OBSERVATION_AGE_MS ||
        (snapshot.nextChangeAt && Date.parse(snapshot.nextChangeAt) <= Date.now())
      ) {
        reasons = ["shadow_snapshot_stale"];
        throw new Error("snapshot_stale");
      }
      const operations = [
        input.operationId,
        ...(input.actor.domain === "api_key" ? ["publicApi.request.v1" as const] : []),
      ];
      const currentSnapshot = facts.snapshot;
      const evaluated = operations.map((operation) =>
        evaluateEntitlementOperation(currentSnapshot, operation),
      );
      reasons = [...new Set(evaluated.flatMap((result) => result.reasonCodes))];
      decision = evaluated.some((result) => result.outcome === "deny")
        ? "deny"
        : evaluated.some((result) => result.outcome === "unknown")
          ? "unknown"
          : "allow";
      if (input.runtime?.enabled === false) {
        decision = "deny";
        reasons.push("runtime_disabled");
      } else if (input.runtime?.enabled !== true) {
        if (decision === "allow") decision = "unknown";
        reasons.push("runtime_readiness_unknown");
      }
    } catch {
      // Never log provider data, exception messages, tokens, scopes or actor credentials.
      if (!reasons.includes("shadow_snapshot_stale"))
        this.logger.error(`entitlement_shadow_calculation_failed operation=${input.operationId}`);
    }
    const observation: EntitlementAdmissionObservation = {
      mode: "shadow",
      decision,
      reasons,
      observationId: null,
    };
    try {
      const persist = async (tx: SubscriptionTransaction) => {
        const [row] = await tx
          .insert(schema.entitlementShadowObservations)
          .values({
            tenantId: input.tenantId,
            operationId: input.operationId,
            registryVersion: ENTITLEMENT_REGISTRY_VERSION,
            revision: snapshot ? BigInt(snapshot.revision) : null,
            usageRevision: snapshot ? BigInt(snapshot.usageRevision) : null,
            observedAt: new Date(),
            outcome: decision,
            reasonCodes: reasons.slice(0, 64),
            actorType: input.actor.domain,
            actorId: input.actor.id,
            requestId: input.requestId ?? null,
            fencedAttempt: input.attempt?.number ?? null,
            lifecyclePolicyFingerprint: policyFingerprint,
            resourceScope: {
              digest: input.scopeDigest,
              operationVersion: ENTITLEMENT_OPERATIONS[input.operationId].version,
              asOf: snapshot?.asOf ?? null,
              runtime: {
                enabled: input.runtime?.enabled ?? null,
                observedAt: input.runtime?.observedAt.toISOString() ?? null,
              },
              attemptIdentity: input.attempt ? admissionScopeDigest(input.attempt.identity) : null,
            },
          })
          .returning({ id: schema.entitlementShadowObservations.id });
        if (!row) throw new Error("observation_insert_missing");
        return row.id;
      };
      // Nested transaction is a savepoint: a failed shadow insert cannot poison owner writes.
      observation.observationId = input.transaction
        ? await input.transaction.transaction(persist)
        : await this.db.transaction(persist);
    } catch {
      this.logger.error(`entitlement_shadow_persistence_failed operation=${input.operationId}`);
      return {
        mode: "shadow",
        decision: "unknown",
        reasons: ["shadow_persistence_failed"],
        observationId: null,
      };
    }
    return observation;
  }
  private async currentProof(
    tx: SubscriptionTransaction,
    tenantId: string,
    versionIds: string[],
  ): Promise<string> {
    // One statement sees revisions and referenced policy/version identities coherently under RC.
    const result = await tx.execute(sql`select jsonb_build_object(
      'revision', coalesce((select revision::text from entitlement_revisions where tenant_id=${tenantId}), '0'),
      'usageRevision', coalesce((select usage_revision::text from entitlement_revisions where tenant_id=${tenantId}), '0'),
      'policies', coalesce((select jsonb_agg(jsonb_build_array(to_jsonb(catalog_item_versions), to_jsonb(entitlement_lifecycle_policies)) order by catalog_item_versions.id)
        from catalog_item_versions left join entitlement_lifecycle_policies on entitlement_lifecycle_policies.id=catalog_item_versions.lifecycle_policy_id
        where ${versionIds.length ? inArray(schema.catalogItemVersions.id, versionIds) : sql`false`}), '[]'::jsonb)) as proof`);
    return admissionScopeDigest(result.rows[0]?.proof);
  }
  async withAdmission<T>(input: EntitlementAdmissionInput, action: () => Promise<T>): Promise<T> {
    await this.observe(input);
    return action();
  }
}
