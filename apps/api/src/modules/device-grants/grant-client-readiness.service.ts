import {
  ConflictException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type { GrantOwner } from "@markiro/domain";
import type {
  GrantClientReadinessRequest,
  GrantClientReadinessResponse,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { entitlementDigest } from "../../subscriptions/entitlement-snapshot-reader";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { lockCurrentGrantOwner, type GrantCredentialIdentity } from "./credential-epoch";
import { GRANT_CLOCK } from "./grant-issuer.service";
import { GRANT_SIGNING_CONFIGURATION, type GrantSigningConfiguration } from "./grant-keyset";

type ReadinessReport = typeof schema.deviceGrantClientReadinessReports.$inferSelect;

const ownerPredicate = (owner: GrantOwner) =>
  owner.kind === "kiosk"
    ? eq(schema.deviceGrantClientReadinessReports.kioskId, owner.deviceId)
    : eq(schema.deviceGrantClientReadinessReports.stationDeviceId, owner.deviceId);

const ownerValues = (owner: GrantOwner) => ({
  tenantId: owner.tenantId,
  ownerKind: owner.kind,
  stationDeviceId: owner.kind === "kiosk" ? null : owner.deviceId,
  kioskId: owner.kind === "kiosk" ? owner.deviceId : null,
  credentialEpoch: owner.credentialEpoch,
});

const response = (report: ReadinessReport): GrantClientReadinessResponse => ({
  protocol: "offline-grants-v1",
  requestId: report.requestId,
  receivedAt: report.receivedAt.toISOString(),
  accepted: true,
  matchesCurrentConfiguration: report.matchesCurrentConfiguration,
  verifiedGrantMatched: report.verifiedGrantMatched,
});

@Injectable()
export class GrantClientReadinessService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(GRANT_SIGNING_CONFIGURATION)
    private readonly signing: GrantSigningConfiguration | null,
    @Optional() @Inject(GRANT_CLOCK) private readonly clock: () => number = Date.now,
  ) {}

  report(
    identity: GrantCredentialIdentity,
    input: GrantClientReadinessRequest,
  ): Promise<GrantClientReadinessResponse> {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid grant readiness clock");
    const receivedAt = new Date(now);
    const payloadDigest = entitlementDigest(input);
    return this.db.transaction(async (tx) => {
      const owner = await lockCurrentGrantOwner(tx, identity, now);
      if (!owner) throw new UnauthorizedException();
      const existing = await this.findRequest(tx, owner, input.requestId);
      if (existing) {
        if (existing.payloadDigest !== payloadDigest) throw this.requestConflict();
        return response(existing);
      }

      const [configuration] = await tx
        .select()
        .from(schema.deviceGrantConfigurations)
        .where(
          and(
            eq(schema.deviceGrantConfigurations.tenantId, owner.tenantId),
            eq(schema.deviceGrantConfigurations.ownerKind, owner.kind),
            owner.kind === "kiosk"
              ? eq(schema.deviceGrantConfigurations.kioskId, owner.deviceId)
              : eq(schema.deviceGrantConfigurations.stationDeviceId, owner.deviceId),
          ),
        )
        .orderBy(desc(schema.deviceGrantConfigurations.sequence))
        .limit(1);

      const reportedGrantId = input.installed.verifiedGrantId;
      const [issuance] = reportedGrantId
        ? await tx
            .select()
            .from(schema.deviceGrantIssuances)
            .where(
              and(
                eq(schema.deviceGrantIssuances.tenantId, owner.tenantId),
                eq(schema.deviceGrantIssuances.ownerKind, owner.kind),
                owner.kind === "kiosk"
                  ? eq(schema.deviceGrantIssuances.kioskId, owner.deviceId)
                  : eq(schema.deviceGrantIssuances.stationDeviceId, owner.deviceId),
                eq(schema.deviceGrantIssuances.credentialEpoch, owner.credentialEpoch),
                eq(schema.deviceGrantIssuances.grantId, reportedGrantId),
                eq(schema.deviceGrantIssuances.kindOfGrant, "device"),
              ),
            )
            .limit(1)
        : [];

      const matchesCurrentConfiguration = Boolean(
        configuration &&
        configuration.credentialEpoch === owner.credentialEpoch &&
        configuration.mode === input.installed.mode &&
        configuration.policyRevision === input.installed.policyRevision &&
        this.signing?.keyset.revision === input.installed.keysetRevision,
      );
      const activeIssuanceKey = Boolean(
        issuance &&
        this.signing?.keyset.keys.some((key) => key.kid === issuance.headerKid) &&
        !this.signing.keyset.retiredKids.includes(issuance.headerKid),
      );
      const verifiedGrantMatched = Boolean(
        matchesCurrentConfiguration &&
        issuance &&
        issuance.policyRevision === input.installed.policyRevision &&
        activeIssuanceKey &&
        issuance.startNotAfter &&
        issuance.startNotAfter.getTime() > now,
      );

      const [created] = await tx
        .insert(schema.deviceGrantClientReadinessReports)
        .values({
          ...ownerValues(owner),
          requestId: input.requestId,
          payloadDigest,
          clientBuild: input.clientBuild,
          storageRevision: input.storageRevision,
          reportedMode: input.installed.mode,
          reportedPolicyRevision: input.installed.policyRevision,
          reportedKeysetRevision: input.installed.keysetRevision,
          reportedGrantId,
          configurationId: configuration?.id ?? null,
          verifiedGrantId: verifiedGrantMatched && issuance ? issuance.grantId : null,
          matchesCurrentConfiguration,
          verifiedGrantMatched,
          receivedAt,
        })
        .returning();
      if (!created) throw new Error("Grant readiness report insert returned no row");

      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: owner.tenantId,
        actorUserId: null,
        action: "offline_grant.readiness.reported",
        outcome: "success",
        targetType: "offline_grant_readiness_report",
        targetId: created.id,
        requestId: input.requestId,
        after: {
          actorDomain: owner.kind === "kiosk" ? "kiosk_device" : "station_device",
          actorId: owner.deviceId,
          deviceKind: owner.kind,
          credentialEpoch: owner.credentialEpoch,
          configurationId: created.configurationId,
          verifiedGrantId: created.verifiedGrantId,
          matchesCurrentConfiguration,
          verifiedGrantMatched,
        },
      });
      return response(created);
    });
  }

  private async findRequest(
    tx: SubscriptionTransaction,
    owner: GrantOwner,
    requestId: string,
  ): Promise<ReadinessReport | undefined> {
    const [report] = await tx
      .select()
      .from(schema.deviceGrantClientReadinessReports)
      .where(
        and(
          eq(schema.deviceGrantClientReadinessReports.tenantId, owner.tenantId),
          eq(schema.deviceGrantClientReadinessReports.ownerKind, owner.kind),
          ownerPredicate(owner),
          eq(schema.deviceGrantClientReadinessReports.credentialEpoch, owner.credentialEpoch),
          eq(schema.deviceGrantClientReadinessReports.requestId, requestId),
        ),
      )
      .limit(1);
    return report;
  }

  private requestConflict() {
    return new ConflictException({ code: "GRANT_READINESS_REQUEST_CONFLICT" });
  }
}
