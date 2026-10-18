import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Alert } from "@markiro/ui";
import type { StandaloneAssignmentRef } from "@markiro/platform-contracts";

import { getTenant } from "./api.js";
import { useStandaloneDate } from "./standalone-format.js";

type TenantDetail = Awaited<ReturnType<typeof getTenant>>;

export const tenantAssignmentsKey = (tenantId: string) => ["platform", "tenants", tenantId];

/** The tenant card the summary reads; the dialog owns it to compare it with a preview. */
export function useTenantAssignments(tenantId: string, enabled: boolean) {
  return useQuery({
    queryKey: tenantAssignmentsKey(tenantId),
    queryFn: () => getTenant(tenantId),
    enabled,
  });
}

const refKey = (ref: StandaloneAssignmentRef) => `${ref.kind}:${ref.id}:${ref.catalogVersionId}`;

/**
 * The assignments the API counts at `at`: the current plan and the add-ons whose
 * term contains it (an add-on that has not started, or has ended but is not yet
 * settled by the status job, is not issued from, as on the server).
 */
export function currentAssignmentRefs(detail: TenantDetail, at: Date): StandaloneAssignmentRef[] {
  const inTerm = (term: { startsAt: string | null; endsAt: string | null }) =>
    (term.startsAt === null || new Date(term.startsAt) <= at) &&
    (term.endsAt === null || new Date(term.endsAt) > at);
  // A scheduled renewal whose start has arrived is already the effective subscription on the
  // server, though the card still lists it as scheduled until the status job promotes it.
  const effective = [detail.currentSubscription, detail.scheduledSubscription].filter(
    (subscription): subscription is NonNullable<TenantDetail["currentSubscription"]> =>
      subscription !== null &&
      (subscription.status !== "scheduled" || subscription.startsAt !== null) &&
      inTerm(subscription),
  );
  const ids = new Set(effective.map((subscription) => subscription.id));
  return [
    ...effective.map((subscription) => ({
      kind: "plan" as const,
      id: subscription.id,
      catalogVersionId: subscription.planVersionId,
    })),
    ...[...detail.activeAddons, ...detail.scheduledAddons]
      .filter((addon) => ids.has(addon.subscriptionId) && inTerm(addon))
      .map((addon) => ({
        kind: "addon" as const,
        id: addon.id,
        catalogVersionId: addon.addonVersionId,
      })),
  ];
}

/** True when the references the preview names are not the ones the tenant card shows. */
export function assignmentsDiffer(
  previewed: StandaloneAssignmentRef[],
  detail: TenantDetail,
  at: Date,
): boolean {
  const shown = new Set(currentAssignmentRefs(detail, at).map(refKey));
  const named = new Set(previewed.map(refKey));
  return shown.size !== named.size || [...named].some((key) => !shown.has(key));
}

/**
 * The rights of a tenant without a cabinet are its direct plan and add-on
 * assignments (spec 2026-10-16 §10). Before a preview the summary shows the
 * tenant card's assignments; after one it shows the references the API named,
 * the ones the file will be issued from, and says so when the card differs.
 */
export function StandaloneAssignmentsSummary({
  tenantId,
  detail,
  isError,
  previewed,
  changed,
}: {
  tenantId: string;
  detail: TenantDetail | undefined;
  isError: boolean;
  previewed: StandaloneAssignmentRef[] | null;
  changed: boolean;
}) {
  const { t, i18n } = useTranslation();
  const formatDate = useStandaloneDate();
  const english = i18n.resolvedLanguage?.startsWith("en") ?? false;
  const term = (endsAt: string | null) =>
    endsAt
      ? t("tenants.detail.standalone.assignments.until", { date: formatDate(endsAt) })
      : t("tenants.detail.standalone.assignments.open");
  const planRow = (subscription: NonNullable<TenantDetail["currentSubscription"]>) => ({
    key: subscription.id,
    text: t("tenants.detail.standalone.assignments.plan", {
      name: english ? subscription.planVersion.nameEn : subscription.planVersion.nameRu,
      version: subscription.planVersion.version,
      term: term(subscription.endsAt),
    }),
  });
  const addonRow = (addon: TenantDetail["activeAddons"][number]) => ({
    key: addon.id,
    text: t("tenants.detail.standalone.assignments.addon", {
      name: english ? addon.addonVersion.nameEn : addon.addonVersion.nameRu,
      version: addon.addonVersion.version,
      quantity: addon.quantity,
      term: term(addon.endsAt),
    }),
  });
  const cardRows = detail
    ? [
        ...(detail.currentSubscription ? [planRow(detail.currentSubscription)] : []),
        ...detail.activeAddons.map(addonRow),
      ]
    : [];
  // A reference the card does not know is named by its version id, never dropped.
  const previewedRows = previewed
    ? previewed.map((ref) => {
        const subscription = [detail?.currentSubscription, detail?.scheduledSubscription].find(
          (candidate) => candidate?.id === ref.id,
        );
        if (ref.kind === "plan" && subscription) return planRow(subscription);
        const addon = [...(detail?.activeAddons ?? []), ...(detail?.scheduledAddons ?? [])].find(
          (candidate) => candidate.id === ref.id,
        );
        if (ref.kind === "addon" && addon) return addonRow(addon);
        return {
          key: ref.id,
          text: t(
            ref.kind === "plan"
              ? "tenants.detail.standalone.assignments.unnamedPlan"
              : "tenants.detail.standalone.assignments.unnamedAddon",
            { id: ref.catalogVersionId.slice(0, 8) },
          ),
        };
      })
    : null;
  const rows = previewedRows ?? cardRows;
  const changeLink = (
    <Link to={`/tenants/${tenantId}#tenant-subscription`}>
      {t("tenants.detail.standalone.assignments.change")}
    </Link>
  );
  return (
    <section
      aria-label={t("tenants.detail.standalone.assignments.title")}
      className="standalone-assignments"
    >
      <h3>
        {previewedRows
          ? t("tenants.detail.standalone.assignments.issuedTitle")
          : t("tenants.detail.standalone.assignments.title")}
      </h3>
      {isError ? (
        <Alert tone="error" role="alert">
          {t("tenants.detail.standalone.assignments.loadError")}
        </Alert>
      ) : null}
      {changed ? (
        <Alert tone="warn" role="alert">
          {t("tenants.detail.standalone.assignments.changed")}
        </Alert>
      ) : null}
      {!previewedRows && detail && rows.length === 0 ? (
        <>
          <Alert tone="warn" role="alert">
            {t("tenants.detail.standalone.assignments.empty")}
          </Alert>
          {changeLink}
        </>
      ) : null}
      {rows.length > 0 ? (
        <>
          <ul>
            {rows.map((row) => (
              <li key={row.key}>{row.text}</li>
            ))}
          </ul>
          {changeLink}
        </>
      ) : null}
      {isError ? changeLink : null}
    </section>
  );
}
