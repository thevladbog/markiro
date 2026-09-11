import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button } from "@markiro/ui";
import {
  isAttributeRequired,
  activeRequirementRules,
  validateProductAttributeValue,
  type ProductAttributeValue,
  type ProductAttributeValues,
} from "@markiro/domain";
import { ApiRequestError } from "../../../api/client.js";
import {
  type RegulatoryProfile,
  useUpdateRegulatoryAttributes,
  useReloadRegulatoryProfile,
} from "./api.js";
import { attributeVisible, valueText } from "./value.js";
import { AttributeControl } from "./AttributeControl.js";

export function CategoryAttributesForm({
  profile,
  canWrite,
  disabled,
  onDirtyChange,
  onBusyChange,
}: {
  profile: RegulatoryProfile;
  canWrite: boolean;
  disabled: boolean;
  onDirtyChange: (value: boolean) => void;
  onBusyChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const p = "pages.catalog.regulatory.";
  const [baseline, setBaseline] = useState(profile);
  const [draft, setDraft] = useState<Record<string, ProductAttributeValue | null>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const mutation = useUpdateRegulatoryAttributes(profile.productId);
  const reload = useReloadRegulatoryProfile(profile.productId);
  const busy = mutation.isPending || reload.isPending;
  const accepted = new Map(baseline.values.map((row) => [row.attributeId, row]));
  const changed = Object.keys(draft).filter(
    (id) => JSON.stringify(draft[id]) !== JSON.stringify(accepted.get(id)?.value ?? null),
  );
  const dirty = changed.length > 0;
  if (!dirty && profile !== baseline) {
    setBaseline(profile);
    setDraft({});
  }
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  const values: ProductAttributeValues = {};
  for (const row of baseline.values) values[row.attributeId] = row.value;
  for (const [id, value] of Object.entries(draft)) {
    if (value === null) delete values[id];
    else values[id] = value;
  }
  const definition = baseline.definition;
  const binding = baseline.binding;
  if (!binding || !definition) return null;
  const visible = definition.attributes.filter((attribute) => attributeVisible(attribute, values));
  const layer = (attribute: (typeof visible)[number]) =>
    isAttributeRequired(attribute, values, "code_ordering")
      ? 0
      : isAttributeRequired(attribute, values, "circulation")
        ? 1
        : activeRequirementRules(attribute, values, "code_ordering", "recommended").length ||
            activeRequirementRules(attribute, values, "circulation", "recommended").length
          ? 2
          : 3;
  const stale = profile.binding?.revision !== binding.revision;
  const saveAttributes = async () => {
    if (disabled || !canWrite || mutation.isPending) return;
    const updates = visible
      .filter((a) => changed.includes(a.id))
      .map((a) => ({ attributeId: a.id, value: normalizeDraft(draft[a.id]) }));
    const invalid = visible
      .filter((a) => {
        const value = normalizeDraft(draft[a.id]);
        return changed.includes(a.id) && value != null && !validateProductAttributeValue(a, value);
      })
      .map((a) => a.id);
    setErrors(invalid);
    setSaved(false);
    if (invalid.length) return;
    try {
      setFailure(null);
      const next = await mutation.mutateAsync({
        baseRevision: binding.revision,
        values: updates,
      });
      setBaseline(next);
      setDraft({});
      setSaved(true);
    } catch (error) {
      setFailure(
        error instanceof ApiRequestError && error.status === 409 ? "changed" : "saveError",
      );
    }
  };

  const discardAndReload = async () => {
    try {
      const next = await reload.mutateAsync();
      setBaseline(next);
      setDraft({});
      setErrors([]);
      setFailure(null);
    } catch {
      setFailure("reloadError");
    }
  };

  return (
    <section
      className="mk-catalog-panel-section mk-regulatory"
      aria-labelledby="category-attributes-title"
    >
      <h3 id="category-attributes-title">{t(p + "attributes")}</h3>
      {stale && !failure && <Alert tone="warn">{t(p + "changed")}</Alert>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void saveAttributes();
        }}
      >
        {[...visible]
          .sort((a, b) => layer(a) - layer(b))
          .map((attribute) => {
            const row = accepted.get(attribute.id);
            return (
              <div className="mk-regulatory-attribute" key={attribute.id}>
                <p className="mk-regulatory-meta">
                  {t(
                    p +
                      ["requiredOrdering", "requiredCirculation", "recommended", "optional"][
                        layer(attribute)
                      ],
                  )}
                  {row && (
                    <>
                      {" "}
                      · {t(p + "sources." + row.source)}: {valueText(row.value, t)}
                    </>
                  )}
                </p>
                {canWrite ? (
                  <AttributeControl
                    definition={attribute}
                    value={values[attribute.id] ?? null}
                    disabled={disabled || busy}
                    onChange={(value) => {
                      setDraft((old) => ({ ...old, [attribute.id]: value }));
                      setSaved(false);
                    }}
                    {...(errors.includes(attribute.id) ? { error: t(p + "invalidValue") } : {})}
                  />
                ) : (
                  <dl>
                    <dt>{attribute.label}</dt>
                    <dd>{valueText(values[attribute.id], t)}</dd>
                  </dl>
                )}
              </div>
            );
          })}
        {visible.length === 0 && <p>{t(p + "noFields")}</p>}
        {failure && <Alert tone="error">{t(p + failure)}</Alert>}
        {saved && <p role="status">{t(p + "saved")}</p>}
        {canWrite && (
          <div className="mk-regulatory-actions">
            <Button type="submit" disabled={!dirty || disabled || busy}>
              {t(p + "saveAttributes")}
            </Button>
            {dirty && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => void discardAndReload()}
              >
                {t(p + "resetChanges")}
              </Button>
            )}
          </div>
        )}
      </form>
    </section>
  );
}

function normalizeDraft(
  value: ProductAttributeValue | null | undefined,
): ProductAttributeValue | null {
  return value?.type === "decimal" && !value.value.trim() ? null : (value ?? null);
}
