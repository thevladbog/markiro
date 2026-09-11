import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { CABINET_CAPABILITY, isEgaisApplicable } from "@markiro/domain";
import { Alert, Button, Spinner } from "@markiro/ui";
import { useCan } from "../../../access/context.js";
import type { ProductDto } from "../api.js";
import { useProductReadiness, useProductRegulatoryProfile } from "./api.js";
import { ReadinessPanel } from "./ReadinessPanel.js";
import { CategoryBinding } from "./CategoryBinding.js";
import { CategoryAttributesForm } from "./CategoryAttributesForm.js";
import { EgaisCodesEditor } from "./EgaisCodesEditor.js";

export function ProductRegulatorySections({
  product,
  disabled = false,
  onDirtyChange,
  onBusyChange,
  onProfileBoundChange,
}: {
  product: ProductDto;
  disabled?: boolean;
  onDirtyChange: (value: boolean) => void;
  onBusyChange?: (value: boolean) => void;
  onProfileBoundChange?: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const p = "pages.catalog.regulatory.";
  const permission = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const canWrite = permission && !product.archived;
  const profile = useProductRegulatoryProfile(product.id);
  const readiness = useProductReadiness(product.id);
  const [categoryDirty, setCategoryDirty] = useState(false);
  const [attributesDirty, setAttributesDirty] = useState(false);
  const [egaisDirty, setEgaisDirty] = useState(false);
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [attributesBusy, setAttributesBusy] = useState(false);
  const [egaisBusy, setEgaisBusy] = useState(false);
  const dirty = categoryDirty || attributesDirty || egaisDirty;
  const busy = categoryBusy || attributesBusy || egaisBusy;
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (profile.data) onProfileBoundChange?.(Boolean(profile.data.binding));
  }, [profile.data, onProfileBoundChange]);
  return (
    <div className="mk-product-regulatory">
      {disabled && <Alert tone="info">{t(p + "saveBaseFirst")}</Alert>}
      {readiness.isPending ? (
        <Spinner label={t(p + "loadingReadiness")} />
      ) : readiness.isError ? (
        <Alert
          tone="error"
          action={<Button onClick={() => void readiness.refetch()}>{t(p + "retry")}</Button>}
        >
          {t(p + "readinessError")}
        </Alert>
      ) : (
        <ReadinessPanel readiness={readiness.data} profile={profile.data ?? null} />
      )}
      {profile.isPending && <Spinner label={t(p + "loadingProfile")} />}
      {profile.isError && (
        <Alert
          tone="error"
          action={<Button onClick={() => void profile.refetch()}>{t(p + "retry")}</Button>}
        >
          {t(p + "profileError")}
        </Alert>
      )}
      {profile.data && (
        <>
          <CategoryBinding
            profile={profile.data}
            canWrite={canWrite}
            disabled={disabled || attributesDirty || egaisDirty || attributesBusy || egaisBusy}
            onDirtyChange={setCategoryDirty}
            onBusyChange={setCategoryBusy}
          />
          {profile.data.binding && !profile.data.definition && (
            <Alert tone="warn">{t(p + "schemaUnavailable")}</Alert>
          )}
          <CategoryAttributesForm
            profile={profile.data}
            canWrite={canWrite}
            disabled={disabled || categoryDirty || egaisDirty || categoryBusy || egaisBusy}
            onDirtyChange={setAttributesDirty}
            onBusyChange={setAttributesBusy}
          />
          {profile.data.binding && isEgaisApplicable(product.chzProductGroupCode) && (
            <EgaisCodesEditor
              profile={profile.data}
              canWrite={canWrite}
              disabled={
                disabled || categoryDirty || attributesDirty || categoryBusy || attributesBusy
              }
              onDirtyChange={setEgaisDirty}
              onBusyChange={setEgaisBusy}
            />
          )}
        </>
      )}
      <section className="mk-catalog-panel-section">
        <h3>{t(p + "nationalCatalog")}</h3>
        <p>{t(p + "nationalCatalogHint")}</p>
        <Link
          to={`/catalog/${encodeURIComponent(product.id)}/chz`}
          state={{ catalogBackground: true }}
        >
          {t(p + "openChz")}
        </Link>
      </section>
    </div>
  );
}
