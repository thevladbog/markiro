import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ENTITLEMENT_FEATURE_KEYS,
  ENTITLEMENT_OPERATIONS,
  ENTITLEMENT_QUOTA_KEYS,
  P1_FEATURE_KEYS,
  entitlementSourcePreviewRequestSchema,
  type EntitlementFeatureKey,
  type EntitlementOperationId,
  type EntitlementSourcePreview,
  type EntitlementEffect,
} from "@markiro/platform-contracts";
import { Alert, Button, Checkbox, Input, Select } from "@markiro/ui";
import { useNavigationGuard } from "../../layout/NavigationGuard.js";
import { ApiRequestError } from "../../api/client.js";
import { confirmTenantEntitlementSource, previewTenantEntitlementSource } from "./api.js";
import { EntitlementPreviewComparison } from "./EntitlementPreviewComparison.js";
import { SourceEffects } from "./EntitlementSnapshotView.js";

function localTime(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function EntitlementSourceForm({
  tenantId,
  intent,
  onRefresh,
  onClose,
  onLockChange,
}: {
  tenantId: string;
  intent: { intent: "prepare" } | { intent: "revoke"; sourceId: string };
  onRefresh: () => Promise<void>;
  onClose: () => void;
  onLockChange: (locked: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [kind, setKind] = useState<"temporary" | "compatibility">("compatibility");
  const [features, setFeatures] = useState<EntitlementFeatureKey[]>(["chzIntegration"]);
  const [quotas, setQuotas] = useState<Record<string, string>>({});
  const [operations, setOperations] = useState<EntitlementOperationId[]>([]);
  const [startsAt, setStartsAt] = useState(() => localTime(new Date()));
  const [endsAt, setEndsAt] = useState("");
  const [reason, setReason] = useState("");
  const [decisionReference, setDecision] = useState("");
  const [preview, setPreview] = useState<EntitlementSourcePreview | null>(null);
  const [effects, setEffects] = useState<EntitlementEffect[]>([]);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  useNavigationGuard(false, pending || uncertain);
  const [message, setMessage] = useState<string | null>(null);
  const invalidate = () => {
    setPreview(null);
    setMessage(null);
  };
  const calculate = async () => {
    setMessage(null);
    setPreview(null);
    const selectedEffects: EntitlementEffect[] = [
      ...features.map((key) => ({ key, featureEnabled: true as const })),
      ...(kind === "temporary"
        ? ENTITLEMENT_QUOTA_KEYS.filter((key) => quotas[key]).map((key) => ({
            key,
            quotaIncrement: Number(quotas[key]),
          }))
        : []),
    ];
    const start = new Date(startsAt);
    const end = endsAt ? new Date(endsAt) : null;
    const request = entitlementSourcePreviewRequestSchema.safeParse(
      intent.intent === "revoke"
        ? { ...intent, reason, decisionReference, requestId: crypto.randomUUID() }
        : {
            intent: "prepare",
            command: {
              kind,
              effects: selectedEffects,
              operationIds: operations,
              startsAt: Number.isFinite(start.getTime()) ? start.toISOString() : "",
              endsAt: end && Number.isFinite(end.getTime()) ? end.toISOString() : null,
              reason,
              decisionReference,
              requestId: crypto.randomUUID(),
            },
          },
    );
    if (!request.success) {
      setMessage("entitlements.invalid");
      return;
    }
    setPending(true);
    onLockChange(true);
    try {
      await onRefresh();
      setPreview(await previewTenantEntitlementSource(tenantId, request.data));
      setEffects(selectedEffects);
    } catch {
      setMessage("entitlements.error");
    } finally {
      setPending(false);
      onLockChange(false);
    }
  };
  const confirm = async () => {
    if (!preview) return;
    setPending(true);
    onLockChange(true);
    setMessage(null);
    try {
      await confirmTenantEntitlementSource(tenantId, {
        previewId: preview.previewId,
        requestId: preview.requestId,
      });
    } catch (error) {
      // Confirm rechecks access before replay. A rejected retry cannot establish
      // whether an earlier response was lost after commit. Only the service's
      // stale domain response is checked after immutable replay and proves non-commit.
      const stale =
        error instanceof ApiRequestError &&
        error.kind === "domain" &&
        error.status === 409 &&
        error.code === "entitlement_preview_stale";
      const unresolved =
        !stale &&
        (uncertain ||
          (error instanceof ApiRequestError &&
            (error.kind === "network" ||
              error.kind === "contract" ||
              (error.status !== null && error.status >= 500))));
      if (unresolved) {
        setUncertain(true);
        setMessage(
          error instanceof ApiRequestError && error.kind === "authorization"
            ? "entitlements.confirmUncertainAccess"
            : error instanceof ApiRequestError && error.status === 429
              ? "entitlements.confirmUncertainRateLimit"
              : "entitlements.confirmUncertain",
        );
      } else {
        setPreview(null);
        setUncertain(false);
        onLockChange(false);
        if (stale) {
          try {
            await onRefresh();
            setMessage("entitlements.stale");
          } catch {
            setMessage("entitlements.loadError");
          }
        } else setMessage("entitlements.error");
      }
      setPending(false);
      return;
    }
    setPreview(null);
    setUncertain(false);
    try {
      await onRefresh();
      setMessage("entitlements.success");
    } catch {
      setMessage("entitlements.successRefreshError");
    } finally {
      setPending(false);
      onLockChange(false);
    }
  };
  const featureChoices: readonly EntitlementFeatureKey[] =
    kind === "compatibility" ? P1_FEATURE_KEYS : ENTITLEMENT_FEATURE_KEYS;
  const operationChoices = (Object.keys(ENTITLEMENT_OPERATIONS) as EntitlementOperationId[]).filter(
    (id) =>
      kind === "temporary" ||
      ENTITLEMENT_OPERATIONS[id].features.some((feature) => features.includes(feature)),
  );
  return (
    <form
      className="catalog-form"
      onSubmit={(event) => {
        event.preventDefault();
        void calculate();
      }}
      onChange={invalidate}
    >
      <fieldset disabled={pending || uncertain}>
        <legend>
          {t(intent.intent === "prepare" ? "entitlements.prepare" : "entitlements.revoke")}
        </legend>
        {intent.intent === "prepare" ? (
          <>
            <Select
              label={t("entitlements.kind")}
              value={kind}
              onValueChange={(value) => {
                invalidate();
                setKind(value as "temporary" | "compatibility");
                setFeatures(["chzIntegration"]);
                setOperations([]);
                setQuotas({});
              }}
              options={["compatibility", "temporary"].map((value) => ({
                value,
                label: t(`entitlements.kinds.${value}`),
              }))}
            />
            <fieldset>
              <legend>{t("entitlements.effects")}</legend>
              {featureChoices.map((key) => (
                <Checkbox
                  key={key}
                  label={t(`entitlements.features.${key}`)}
                  checked={features.includes(key)}
                  onCheckedChange={(checked) => {
                    invalidate();
                    setFeatures((current) =>
                      checked ? [...current, key] : current.filter((k) => k !== key),
                    );
                    setOperations([]);
                  }}
                />
              ))}
              {kind === "temporary"
                ? ENTITLEMENT_QUOTA_KEYS.map((key) => (
                    <Input
                      key={key}
                      label={`${t(`entitlements.quotas.${key}`)} +`}
                      type="number"
                      min={1}
                      max={2147483647}
                      value={quotas[key] ?? ""}
                      onChange={(event) =>
                        setQuotas((current) => ({ ...current, [key]: event.target.value }))
                      }
                    />
                  ))
                : null}
            </fieldset>
            <fieldset>
              <legend>{t("entitlements.operations")}</legend>
              {operationChoices.map((id) => (
                <Checkbox
                  key={id}
                  label={t(`entitlements.operationsLabels.${id.replaceAll(".", "_")}`)}
                  checked={operations.includes(id)}
                  onCheckedChange={(checked) => {
                    invalidate();
                    setOperations((current) =>
                      checked ? [...current, id] : current.filter((key) => key !== id),
                    );
                  }}
                />
              ))}
            </fieldset>
            <p>
              {t("entitlements.periodHint", {
                zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              })}
            </p>
            <Input
              label={t("entitlements.from")}
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
            />
            <Input
              label={t("entitlements.until")}
              type="datetime-local"
              required={kind === "temporary"}
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
            />
          </>
        ) : (
          <p>{intent.sourceId}</p>
        )}
        <Input
          label={t("entitlements.reason")}
          value={reason}
          maxLength={1000}
          onChange={(event) => setReason(event.target.value)}
        />
        <Input
          label={t("entitlements.decision")}
          value={decisionReference}
          maxLength={1000}
          onChange={(event) => setDecision(event.target.value)}
        />
        <Button type="submit">{t("entitlements.preview")}</Button>
        <Button variant="secondary" onClick={onClose}>
          {t("entitlements.cancel")}
        </Button>
      </fieldset>
      {message ? (
        <Alert tone={message === "entitlements.success" ? "ok" : "warn"}>{t(message)}</Alert>
      ) : null}
      {preview ? (
        <section aria-label={t("entitlements.preview")}>
          <p>{t("entitlements.shadow")}</p>
          {intent.intent === "prepare" ? (
            <>
              <p>
                {new Date(startsAt).toLocaleString(i18n.language)} —{" "}
                {endsAt ? new Date(endsAt).toLocaleString(i18n.language) : t("entitlements.noEnd")}
              </p>
              <SourceEffects source={{ effects }} />
              <ul>
                {operations.map((id) => (
                  <li key={id}>{t(`entitlements.operationsLabels.${id.replaceAll(".", "_")}`)}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>{intent.sourceId}</p>
          )}
          <p>{reason}</p>
          <p>{decisionReference}</p>
          <p>
            {t("entitlements.previewExpires", {
              value: new Date(preview.expiresAt).toLocaleString(i18n.language),
            })}
          </p>
          <EntitlementPreviewComparison preview={preview} />
          <Button disabled={pending} onClick={() => void confirm()}>
            {t(
              uncertain
                ? "entitlements.retryConfirm"
                : intent.intent === "revoke"
                  ? "entitlements.confirmRevoke"
                  : "entitlements.confirm",
            )}
          </Button>
        </section>
      ) : null}
    </form>
  );
}
