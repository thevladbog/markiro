import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, desc, eq } from "drizzle-orm";
import {
  STANDALONE_FEATURE_KEYS,
  STANDALONE_LICENSE_TYP,
  STANDALONE_QUOTA_KEYS,
  standaloneLicensePayloadV1Schema,
} from "@markiro/domain";
import {
  STANDALONE_ASSIGNMENT_REFS_MAX,
  STANDALONE_DEMO_PLAN_VERSION_ID,
  standaloneDemoTermsSchema,
  standaloneIssuanceListSchema,
  standaloneIssuancePreviewSchema,
  type EntitlementSnapshotV1,
  type PlatformPrincipal,
  type StandaloneAssignmentRef,
  type StandaloneDemoTerms,
  type StandaloneIssuanceConfirm,
  type StandaloneIssuanceList,
  type StandaloneIssuanceSource,
  type StandaloneIssuancePreview,
  type StandaloneIssuancePreviewRequest,
  type StandaloneIssuanceWarning,
  type StandaloneLicenseFile,
  type StandaloneLicenseRights,
  type StandaloneOfflineTerms,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { signCompactJws } from "../../signing/compact-jws";
import { sourceActiveAt } from "../../subscriptions/entitlement-projection";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import {
  findSite,
  issuanceSourceFor,
  readTenantInns,
  requireStandaloneLicenseActor,
  STANDALONE_LICENSE_CLOCK,
  type StandaloneLicenseClock,
} from "./standalone-license-authority";
import {
  STANDALONE_LICENSE_SIGNING,
  type StandaloneLicenseSigningConfiguration,
} from "./standalone-license-keyset";
import {
  exportStandaloneRights,
  licenseValidity,
  type LicenseValidity,
} from "./standalone-license-rights";
import { postgresFailure, standaloneTransaction } from "./standalone-license-transaction";
import {
  issuanceSummary,
  licenseFile,
  siteUsage,
  type StandaloneIssuanceRow,
  type StandaloneSiteRow,
} from "./standalone-license-views";
import { resolveCustomerInn, usageWarnings } from "./standalone-inn-check";

/** Spec §6.2: 14 grace days by default for a subscription, 0 for a demo (plan Д6). */
export const DEFAULT_SUBSCRIPTION_GRACE_DAYS = 14;
const DAY_MS = 86_400_000;
const stale = () => new ConflictException({ code: "standalone_license_preview_stale" });

/**
 * The characters the payload's `plainText(300)` refuses (`isPlainText` in
 * `@markiro/domain`, `is_plain_text` in `markiro_proto::trust`): C0 and C1
 * controls with DEL, the line and paragraph separators, the bidirectional
 * embeddings, overrides and isolates — plus a lone surrogate, which no JSON
 * reader on the host accepts.
 */
function unprintable(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    // Defensive: Postgres text cannot hold a lone surrogate, so the database never yields one.
    (code >= 0xd800 && code <= 0xdfff)
  );
}

/**
 * The signed customer name (plan Д4): refused characters become spaces; at most
 * 300 UTF-16 units, as the license schema (`utf16BoundedString`) and the
 * host's `utf16_len` count them, never splitting a surrogate pair.
 */
function plainName(value: string): string {
  const printable = [...value]
    .map((character) => (unprintable(character.codePointAt(0) ?? 0) ? " " : character))
    .join("")
    .trim();
  let cut = "";
  for (const character of printable) {
    if (cut.length + character.length > 300) break;
    cut += character;
  }
  return cut.trim() || "—";
}

/**
 * What the operator saw in the preview, apart from the instants (they are the
 * confirmation's own): confirmation refuses a file whose terms moved (plan Д7).
 */
function termsDigest(draft: IssuanceDraft, hostId: string): string {
  const canonical = JSON.stringify([
    draft.source,
    draft.plan,
    draft.planVersionId,
    draft.graceDays,
    hostId,
    draft.customer.name,
    draft.customer.inn,
    STANDALONE_QUOTA_KEYS.map((key) => draft.rights.quotas[key]),
    STANDALONE_FEATURE_KEYS.map((key) => draft.rights.features[key]),
    draft.sourceAssignments?.map((ref) => [ref.kind, ref.id, ref.catalogVersionId]) ?? null,
    draft.validity.reason,
    // A demo's term moves its end; appended only for a demo, so other digests stay as they were.
    ...(draft.demoTerm === null ? [] : [draft.demoTerm.termDays]),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The same request id must carry the same terms to replay its file. The removed
 * manual offline terms still replay a row issued from them (owner decision
 * 2026-10-16: the journal is history), but are refused for a new issuance. A
 * demo replays only a demo row of the same term.
 */
function sameTerms(
  row: StandaloneIssuanceRow,
  offline: StandaloneOfflineTerms | null,
  demo: StandaloneDemoTerms | null,
): boolean {
  if (demo !== null)
    return (
      offline === null &&
      row.source === "offline_demo" &&
      row.validUntil.getTime() - row.validFrom.getTime() === demo.termDays * DAY_MS
    );
  if (offline === null)
    return row.source === "subscription" || row.source === "offline_assignments";
  return (
    row.source === "offline" &&
    row.planVersionId === offline.planVersionId &&
    row.validUntil.getTime() - row.validFrom.getTime() === offline.termDays * DAY_MS
  );
}

interface IssuanceDraft {
  previous: StandaloneIssuanceRow | null;
  source: StandaloneIssuanceSource;
  plan: "demo" | "subscription";
  planVersionId: string;
  entitlementRevision: string;
  validity: LicenseValidity;
  graceDays: number;
  customer: { name: string; inn: string };
  rights: StandaloneLicenseRights;
  /**
   * The plan and add-on rows the rights were read from: set for `offline_assignments`,
   * and for an `offline_demo` that bridges an assigned tariff.
   */
  sourceAssignments: StandaloneAssignmentRef[] | null;
  /** The operator's term of an `offline_demo` file; `null` for every other source. */
  demoTerm: StandaloneDemoTerms | null;
  warnings: StandaloneIssuanceWarning[];
}

/**
 * Spec 2026-10-20 §4.2: a demo file without an assigned tariff carries the built-in
 * trial's rights — no quota and every feature (the host's `Features::ALL`).
 */
const TRIAL_RIGHTS: StandaloneLicenseRights = {
  quotas: { lines: null, stations: null, kiosks: null, cabinetUsers: null },
  features: {
    labelEditor: true,
    publicApi: true,
    pallets: true,
    chzIntegration: true,
    inventory: true,
    commerceMl: true,
    handheld: true,
    customLogo: true,
  },
};

/** A term of whole days within the contract's bound, or a precise refusal. */
function demoTermOf(demo: StandaloneDemoTerms | null | undefined): StandaloneDemoTerms | null {
  if (demo === undefined || demo === null) return null;
  const parsed = standaloneDemoTermsSchema.safeParse(demo);
  if (!parsed.success)
    throw new BadRequestException({ code: "standalone_license_demo_term_invalid" });
  return parsed.data;
}

@Injectable()
export class StandaloneLicenseIssuanceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
    private readonly audit: PlatformAuditService,
    @Inject(STANDALONE_LICENSE_SIGNING)
    private readonly signing: StandaloneLicenseSigningConfiguration | null,
    @Inject(STANDALONE_LICENSE_CLOCK) private readonly now: StandaloneLicenseClock,
  ) {}

  /** «было → станет» without writing (plan Д7). */
  async preview(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    siteId: string,
    body: StandaloneIssuancePreviewRequest,
  ): Promise<StandaloneIssuancePreview> {
    return standaloneTransaction(
      this.db,
      async (tx) => {
        const { tenant } = await requireStandaloneLicenseActor(tx, principal, tenantId, false);
        const site = await findSite(tx, tenantId, siteId);
        const now = this.now();
        const draft = await this.draft(tx, site, tenant, body, now);
        return standaloneIssuancePreviewSchema.parse({
          siteId: site.id,
          hostId: site.hostId,
          previous: draft.previous ? issuanceSummary(draft.previous) : null,
          next: {
            sequence: site.lastIssuedSequence + 1,
            source: draft.source,
            plan: draft.plan,
            planVersionId: draft.planVersionId,
            entitlementRevision: draft.entitlementRevision,
            validFrom: now.toISOString(),
            validUntil: draft.validity.validUntil.toISOString(),
            validUntilReason: draft.validity.reason,
            graceDays: draft.graceDays,
            sourceAssignments: draft.sourceAssignments,
            customer: draft.customer,
            rights: draft.rights,
          },
          warnings: draft.warnings,
          expected: {
            entitlementRevision: draft.entitlementRevision,
            previousSequence: site.lastIssuedSequence,
            boundaryAt: draft.validity.boundaryAt?.toISOString() ?? null,
            termsDigest: termsDigest(draft, site.hostId),
          },
        });
      },
      "read only",
    );
  }

  /** Spec §6.2 step 3: sequence = last + 1 in the transaction, signature, journal row, audit. */
  async confirm(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    siteId: string,
    body: StandaloneIssuanceConfirm,
  ): Promise<StandaloneLicenseFile> {
    try {
      return await standaloneTransaction(this.db, async (tx) => {
        const { user, tenant } = await requireStandaloneLicenseActor(tx, principal, tenantId, true);
        const site = await findSite(tx, tenantId, siteId);
        const [replay] = await tx
          .select()
          .from(schema.standaloneLicenseIssuances)
          .where(
            and(
              eq(schema.standaloneLicenseIssuances.tenantId, tenantId),
              eq(schema.standaloneLicenseIssuances.siteId, site.id),
              eq(schema.standaloneLicenseIssuances.requestId, body.requestId),
            ),
          );
        if (replay) {
          if (
            replay.issuedByPlatformUserId !== user.id ||
            (body.graceDays !== null && body.graceDays !== replay.graceDays) ||
            !sameTerms(replay, body.offline, demoTermOf(body.demo))
          )
            throw new ConflictException({ code: "standalone_license_request_conflict" });
          return licenseFile(replay);
        }
        const signing = this.signing;
        if (!signing)
          throw new ConflictException({ code: "standalone_license_signing_unavailable" });
        const now = this.now();
        const draft = await this.draft(tx, site, tenant, body, now);
        const boundaryAt = draft.validity.boundaryAt?.toISOString() ?? null;
        if (
          body.expected.entitlementRevision !== draft.entitlementRevision ||
          body.expected.previousSequence !== site.lastIssuedSequence ||
          body.expected.boundaryAt !== boundaryAt ||
          body.expected.termsDigest !== termsDigest(draft, site.hostId)
        )
          throw stale();
        const sequence = site.lastIssuedSequence + 1;
        const advanced = await tx
          .update(schema.standaloneSites)
          .set({ lastIssuedSequence: sequence, updatedAt: now })
          .where(
            and(
              eq(schema.standaloneSites.tenantId, tenantId),
              eq(schema.standaloneSites.id, site.id),
              eq(schema.standaloneSites.lastIssuedSequence, site.lastIssuedSequence),
            ),
          )
          .returning({ id: schema.standaloneSites.id });
        if (advanced.length !== 1) throw stale();
        const licenseId = randomUUID();
        const payload = standaloneLicensePayloadV1Schema.parse({
          version: 1,
          licenseId,
          sequence,
          issuer: signing.issuer,
          tenantId,
          siteId: site.id,
          hostId: site.hostId,
          customer: draft.customer,
          plan: draft.plan,
          planVersionId: draft.planVersionId,
          entitlementRevision: draft.entitlementRevision,
          issuedAt: now.getTime(),
          validFrom: now.getTime(),
          validUntil: draft.validity.validUntil.getTime(),
          graceDays: draft.graceDays,
          quotas: draft.rights.quotas,
          features: draft.rights.features,
          replaces: draft.previous?.id ?? null,
        });
        const compact = signCompactJws(signing, STANDALONE_LICENSE_TYP, payload);
        const sha256 = createHash("sha256").update(compact, "utf8").digest("hex");
        const [row] = await tx
          .insert(schema.standaloneLicenseIssuances)
          .values({
            id: licenseId,
            tenantId,
            siteId: site.id,
            sequence,
            requestId: body.requestId,
            hostId: site.hostId,
            source: draft.source,
            plan: draft.plan,
            planVersionId: draft.planVersionId,
            entitlementRevision: BigInt(draft.entitlementRevision),
            payload,
            compact,
            sha256,
            kid: signing.kid,
            graceDays: draft.graceDays,
            issuedAt: now,
            validFrom: now,
            validUntil: draft.validity.validUntil,
            validUntilReason: draft.validity.reason,
            sourceAssignments: draft.sourceAssignments,
            replacesId: draft.previous?.id ?? null,
            issuedByPlatformUserId: user.id,
          })
          .returning();
        if (!row) throw new Error("standalone license insert returned no row");
        await this.audit.record(tx, {
          actorPlatformUserId: user.id,
          actorRole: user.role,
          action: "standalone_license.issued",
          outcome: "success",
          tenantId,
          targetType: "standalone_license",
          targetId: licenseId,
          reason: null,
          requestId: body.requestId,
          before: draft.previous
            ? {
                licenseId: draft.previous.id,
                sequence: draft.previous.sequence,
                source: draft.previous.source,
                plan: draft.previous.plan,
                validUntil: draft.previous.validUntil.toISOString(),
              }
            : null,
          after: {
            siteId: site.id,
            hostId: site.hostId,
            licenseId,
            sequence,
            previousSequence: site.lastIssuedSequence,
            replaces: draft.previous?.id ?? null,
            source: draft.source,
            offlineTerms: null,
            demoTerm: draft.demoTerm,
            sourceAssignments: draft.sourceAssignments,
            plan: draft.plan,
            planVersionId: draft.planVersionId,
            entitlementRevision: draft.entitlementRevision,
            validFrom: now.toISOString(),
            validUntil: draft.validity.validUntil.toISOString(),
            validUntilReason: draft.validity.reason,
            graceDays: draft.graceDays,
            kid: signing.kid,
            sha256,
            customer: draft.customer,
            quotas: draft.rights.quotas,
            features: draft.rights.features,
            warnings: draft.warnings,
          },
        });
        return licenseFile(row);
      });
    } catch (error) {
      const failure = postgresFailure(error);
      // A lost sequence race, or a serialization failure that outlived the retries.
      if (
        (failure.code === "23505" &&
          failure.constraint === "standalone_license_issuances_site_sequence_uq") ||
        failure.code === "40001"
      )
        throw stale();
      throw error;
    }
  }

  async listIssuances(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    siteId: string,
  ): Promise<StandaloneIssuanceList> {
    return standaloneTransaction(
      this.db,
      async (tx) => {
        await requireStandaloneLicenseActor(tx, principal, tenantId, false);
        const site = await findSite(tx, tenantId, siteId);
        const rows = await tx
          .select()
          .from(schema.standaloneLicenseIssuances)
          .where(
            and(
              eq(schema.standaloneLicenseIssuances.tenantId, tenantId),
              eq(schema.standaloneLicenseIssuances.siteId, site.id),
            ),
          )
          .orderBy(desc(schema.standaloneLicenseIssuances.sequence))
          .limit(1_000);
        return standaloneIssuanceListSchema.parse({
          siteId: site.id,
          items: rows.map((row) => issuanceSummary(row)),
        });
      },
      "read only",
    );
  }

  /** Any issued file again (spec §6.2 step 4); a read, no audit row (plan Д16). */
  async download(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    siteId: string,
    licenseId: string,
  ): Promise<StandaloneLicenseFile> {
    return standaloneTransaction(
      this.db,
      async (tx) => {
        await requireStandaloneLicenseActor(tx, principal, tenantId, false);
        const site = await findSite(tx, tenantId, siteId);
        const [row] = await tx
          .select()
          .from(schema.standaloneLicenseIssuances)
          .where(
            and(
              eq(schema.standaloneLicenseIssuances.tenantId, tenantId),
              eq(schema.standaloneLicenseIssuances.siteId, site.id),
              eq(schema.standaloneLicenseIssuances.id, licenseId),
            ),
          );
        if (!row) throw new NotFoundException();
        return licenseFile(row);
      },
      "read only",
    );
  }

  private async draft(
    tx: SubscriptionTransaction,
    site: StandaloneSiteRow,
    tenant: { name: string; cabinetAccess: "enabled" | "none" },
    body: {
      graceDays: number | null;
      offline: StandaloneOfflineTerms | null;
      demo?: StandaloneDemoTerms | null | undefined;
    },
    now: Date,
  ): Promise<IssuanceDraft> {
    // The manual offline terms are removed: an old client's request is refused, not guessed at.
    if (body.offline !== null)
      throw new ConflictException({ code: "standalone_license_offline_terms_removed" });
    const demoTerm = demoTermOf(body.demo);
    if (demoTerm !== null) return this.demoDraft(tx, site, tenant, body.graceDays, demoTerm, now);
    const source = issuanceSourceFor(tenant.cabinetAccess);
    const terms = await this.assignmentTerms(
      tx,
      site.tenantId,
      now,
      source === "offline_assignments"
        ? "standalone_license_assignments_required"
        : "standalone_license_subscription_required",
    );
    const grace = body.graceDays ?? (terms.plan === "demo" ? 0 : DEFAULT_SUBSCRIPTION_GRACE_DAYS);
    if (terms.plan === "demo" && grace !== 0)
      throw new BadRequestException({ code: "standalone_license_grace_invalid" });
    const facts = await this.customerFacts(tx, site, tenant);
    return {
      previous: facts.previous,
      source,
      plan: terms.plan,
      planVersionId: terms.planVersionId,
      entitlementRevision: terms.entitlementRevision,
      validity: terms.validity,
      graceDays: grace,
      customer: facts.customer,
      rights: terms.rights,
      sourceAssignments: source === "offline_assignments" ? terms.sourceAssignments : null,
      demoTerm: null,
      warnings: [
        ...facts.warnings,
        ...usageWarnings(terms.rights, siteUsage(site)),
        ...terms.unmapped.map((feature): StandaloneIssuanceWarning => ({
          code: "feature_unmapped",
          feature,
        })),
      ],
    };
  }

  /**
   * Spec 2026-10-20 §4.2–4.3: a demo file for a tenant without a cabinet only,
   * `plan: "demo"`, no grace, valid for the operator's term from issuance. With a
   * tariff assigned it carries that tariff's rights (the bridge while an invoice is
   * paid); without one, the built-in trial's (the trial extension).
   */
  private async demoDraft(
    tx: SubscriptionTransaction,
    site: StandaloneSiteRow,
    tenant: { name: string; cabinetAccess: "enabled" | "none" },
    graceDays: number | null,
    demoTerm: StandaloneDemoTerms,
    now: Date,
  ): Promise<IssuanceDraft> {
    if (tenant.cabinetAccess !== "none")
      throw new ConflictException({ code: "standalone_license_demo_offline_only" });
    if (graceDays !== null && graceDays !== 0)
      throw new BadRequestException({ code: "standalone_license_grace_invalid" });
    const snapshotAt = await this.entitlements.loadSnapshotTimeline(site.tenantId, tx);
    const first = (await snapshotAt(now)).snapshot;
    const subscription = first.current.subscription;
    const assigned =
      first.current.access === "managed" && subscription !== null && subscription.status !== "trial"
        ? { planVersionId: subscription.planVersionId, ...exportStandaloneRights(first) }
        : null;
    const sourceAssignments = assigned ? activeAssignments(first) : null;
    if (sourceAssignments !== null && sourceAssignments.length > STANDALONE_ASSIGNMENT_REFS_MAX)
      throw new ConflictException({ code: "standalone_assignment_limit_reached" });
    const rights = assigned?.rights ?? TRIAL_RIGHTS;
    const facts = await this.customerFacts(tx, site, tenant);
    return {
      previous: facts.previous,
      source: "offline_demo",
      plan: "demo",
      planVersionId: assigned?.planVersionId ?? STANDALONE_DEMO_PLAN_VERSION_ID,
      entitlementRevision: first.revision,
      validity: {
        validUntil: new Date(now.getTime() + demoTerm.termDays * DAY_MS),
        reason: "demo_term",
        boundaryAt: null,
      },
      graceDays: 0,
      customer: facts.customer,
      rights,
      sourceAssignments,
      demoTerm,
      warnings: [
        ...facts.warnings,
        ...usageWarnings(rights, siteUsage(site)),
        ...(assigned?.unmapped ?? []).map((feature): StandaloneIssuanceWarning => ({
          code: "feature_unmapped",
          feature,
        })),
      ],
    };
  }

  /** The signed customer, its INN warnings and the site's latest file. */
  private async customerFacts(
    tx: SubscriptionTransaction,
    site: StandaloneSiteRow,
    tenant: { name: string },
  ) {
    const inns = await readTenantInns(tx, site.tenantId);
    const customerInn = resolveCustomerInn({
      orgInn: inns.orgInn,
      billingInn: inns.billingInn,
      siteInn: site.requestInn,
    });
    if (customerInn.inn === null)
      throw new ConflictException({ code: "standalone_license_inn_required" });
    const [previous] = await tx
      .select()
      .from(schema.standaloneLicenseIssuances)
      .where(
        and(
          eq(schema.standaloneLicenseIssuances.tenantId, site.tenantId),
          eq(schema.standaloneLicenseIssuances.siteId, site.id),
        ),
      )
      .orderBy(desc(schema.standaloneLicenseIssuances.sequence))
      .limit(1);
    return {
      previous: previous ?? null,
      customer: { name: plainName(inns.billingName ?? tenant.name), inn: customerInn.inn },
      warnings: customerInn.warnings,
    };
  }

  /**
   * The rights and term come from the tenant's current plan and add-on
   * assignments, read through the entitlement snapshot (spec §6.2); for a tenant
   * with a cabinet that is its subscription, for one without (spec 2026-10-16)
   * its direct assignments. A tenant without a cabinet never gets a demo file:
   * a trial is not an assignment it can have.
   */
  private async assignmentTerms(
    tx: SubscriptionTransaction,
    tenantId: string,
    now: Date,
    missingCode:
      "standalone_license_subscription_required" | "standalone_license_assignments_required",
  ) {
    const snapshotAt = await this.entitlements.loadSnapshotTimeline(tenantId, tx);
    const first = (await snapshotAt(now)).snapshot;
    const subscription = first.current.subscription;
    if (
      first.current.access !== "managed" ||
      !subscription ||
      (missingCode === "standalone_license_assignments_required" && subscription.status === "trial")
    )
      throw new ConflictException({ code: missingCode });
    const exported = exportStandaloneRights(first);
    const sourceAssignments = activeAssignments(first);
    // The journal holds a bounded list (only for the assignments path; a cloud file names none); assignment creation enforces the same bound, so this
    // is a defence for rows that predate it, and answers with a code rather than a 500.
    if (
      missingCode === "standalone_license_assignments_required" &&
      sourceAssignments.length > STANDALONE_ASSIGNMENT_REFS_MAX
    )
      throw new ConflictException({ code: "standalone_assignment_limit_reached" });
    return {
      plan: subscription.status === "trial" ? ("demo" as const) : ("subscription" as const),
      planVersionId: subscription.planVersionId,
      entitlementRevision: first.revision,
      validity: await licenseValidity({
        at: now,
        first,
        snapshotAt: async (at) => (await snapshotAt(at)).snapshot,
      }),
      rights: exported.rights,
      unmapped: exported.unmapped,
      sourceAssignments,
    };
  }
}

/**
 * Only what the entitlement projection counts at this instant: the same predicate
 * as the rights, so an add-on that has not started or has ended is not named.
 */
function activeAssignments(snapshot: EntitlementSnapshotV1): StandaloneAssignmentRef[] {
  const asOf = new Date(snapshot.asOf);
  return snapshot.sources.flatMap((source): StandaloneAssignmentRef[] =>
    (source.kind === "plan" || source.kind === "addon") && sourceActiveAt(source, asOf)
      ? [{ kind: source.kind, id: source.id, catalogVersionId: source.versionId }]
      : [],
  );
}
