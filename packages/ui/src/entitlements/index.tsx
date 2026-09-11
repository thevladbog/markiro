import {
  ENTITLEMENT_FEATURE_KEYS,
  ENTITLEMENT_QUOTA_KEYS,
  type EntitlementSnapshotV1,
  type EntitlementSource,
} from "@markiro/platform-contracts";
import { Card, StatusChip } from "../components/index.js";

export type EntitlementTranslate = (
  key: string,
  options?: { value?: string | number; defaultValue?: string },
) => string;
export interface EntitlementSnapshotViewProps {
  snapshot: EntitlementSnapshotV1;
  translate: EntitlementTranslate;
  formatDate: (value: string | null) => string;
  classNames: { quotaGrid: string; quotaItem: string; facts: string; sources: string };
}
export function EntitlementSnapshotView({
  snapshot,
  translate: t,
  formatDate: date,
  classNames,
}: EntitlementSnapshotViewProps) {
  const flag = (value: boolean | null) =>
    t(`entitlements.${value === null ? "unknown" : value ? "enabled" : "disabled"}`);
  return (
    <>
      <Card title={t("entitlements.title")} titleAs="h2">
        <p>
          {t(
            snapshot.current.writeAllowed
              ? "entitlements.writeAllowed"
              : "entitlements.writeDenied",
          )}
        </p>
        <p>{t("entitlements.shadow")}</p>
        <div className={classNames.quotaGrid}>
          {ENTITLEMENT_QUOTA_KEYS.map((key) => (
            <article className={classNames.quotaItem} key={key}>
              <strong>{t(`entitlements.quotas.${key}`)}</strong>
              {(["current", "candidate"] as const).map((mode) => (
                <div key={mode}>
                  <span>{t(`entitlements.${mode}`)}: </span>
                  <strong>
                    {snapshot[mode].quotas[key].used} /{" "}
                    {snapshot[mode].quotas[key].limit ?? t("entitlements.unlimited")}
                  </strong>
                  <p>
                    {t("entitlements.remaining", {
                      value: snapshot[mode].quotas[key].remaining ?? t("entitlements.unlimited"),
                    })}
                  </p>
                </div>
              ))}
            </article>
          ))}
        </div>
        <dl className={classNames.facts}>
          {ENTITLEMENT_FEATURE_KEYS.map((key) => (
            <div key={key}>
              <dt>{t(`entitlements.features.${key}`)}</dt>
              <dd>
                <span>
                  {t("entitlements.current")}:{" "}
                  {key === "labelEditor" || key === "publicApi" || key === "pallets"
                    ? flag(snapshot.current.features[key])
                    : t("entitlements.notEvaluated")}
                </span>
                <br />
                <span>
                  {t("entitlements.candidate")}: {flag(snapshot.candidate.features[key])}
                </span>
              </dd>
            </div>
          ))}
        </dl>
        <p>{t("entitlements.calculatedAt", { value: date(snapshot.asOf) })}</p>
        <p>{t("entitlements.usageAt", { value: date(snapshot.countedAt) })}</p>
        {snapshot.nextChangeAt ? (
          <p>{t("entitlements.nextChange", { value: date(snapshot.nextChangeAt) })}</p>
        ) : null}
      </Card>
      <Card title={t("entitlements.sources")} titleAs="h2">
        <p>{t("entitlements.scopeHint")}</p>
        {snapshot.sources.length === 0 ? (
          <p>{t("entitlements.noSources")}</p>
        ) : (
          <ul className={classNames.sources}>
            {snapshot.sources.map((source) => (
              <li key={source.id}>
                <div>
                  <strong>{t(`entitlements.kinds.${source.kind}`)}</strong>
                  <StatusChip
                    status="info"
                    label={t(
                      source.prepared
                        ? "entitlements.prepared"
                        : source.startsAt && Date.parse(source.startsAt) > Date.parse(snapshot.asOf)
                          ? "entitlements.scheduled"
                          : source.endsAt && Date.parse(source.endsAt) <= Date.parse(snapshot.asOf)
                            ? "entitlements.ended"
                            : "entitlements.current",
                    )}
                  />
                </div>
                <p>
                  {date(source.startsAt)} — {date(source.endsAt)}
                  {source.endsAt ? ` (${t("entitlements.until")})` : ""}
                </p>
                {source.kind === "plan" ? (
                  <details>
                    <summary>{t("entitlements.planBaseline")}</summary>
                    <ul>
                      {ENTITLEMENT_QUOTA_KEYS.map((key) => (
                        <li key={key}>
                          {t(`entitlements.quotas.${key}`)}:{" "}
                          {source.plan.quotas[key] ?? t("entitlements.unlimited")}
                        </li>
                      ))}
                      {ENTITLEMENT_FEATURE_KEYS.map((key) => (
                        <li key={key}>
                          {t(`entitlements.features.${key}`)}: {flag(source.plan.features[key])}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : (
                  <SourceEffects source={source} translate={t} />
                )}
                <ul>
                  {source.operationIds.map((id) => (
                    <li key={id}>
                      <span>{t(`entitlements.operationsLabels.${id.replaceAll(".", "_")}`)}</span> ·{" "}
                      {id.split(".").at(-1)}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={t("entitlements.readiness")} titleAs="h2">
        <ul>
          {snapshot.readiness.reasons.map((reason) => (
            <li key={reason}>
              {t(`entitlements.reasons.${reason}`, {
                defaultValue: t("entitlements.reasons.other"),
              })}
            </li>
          ))}
        </ul>
        <p>
          {t("entitlements.chz")}: {t(`entitlements.connections.${snapshot.connectivity.chz}`)}
        </p>
        <p>
          {t("entitlements.nationalCatalog")}:{" "}
          {t(`entitlements.connections.${snapshot.connectivity.nationalCatalog}`)}
        </p>
        <p>{t("entitlements.observed", { value: date(snapshot.connectivity.observedAt) })}</p>
      </Card>
    </>
  );
}
export function SourceEffects({
  source,
  translate: t,
}: {
  source: Pick<EntitlementSource, "effects">;
  translate: EntitlementTranslate;
}) {
  return (
    <ul>
      {source.effects.map((effect) => (
        <li key={effect.key}>
          {"quotaIncrement" in effect
            ? `${t(`entitlements.quotas.${effect.key}`)}: +${effect.quotaIncrement}`
            : t(`entitlements.features.${effect.key}`)}
        </li>
      ))}
    </ul>
  );
}
