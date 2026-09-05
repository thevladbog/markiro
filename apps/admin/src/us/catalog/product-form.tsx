import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Drawer, Input } from "@markiro/ui";
import { normalizeToGtin14 } from "@markiro/domain";
import {
  createUsProductSchema,
  type CreateUsProductInput,
  type UpdateUsProductInput,
  type UsProduct,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import type { MasterDataViewProps, MutationRelease } from "../master-data/workspace-shared.js";

export type ProductSaveResult =
  "saved" | "product_gtin_taken" | "product_gtin_locked" | "forbidden" | "failed";
type Props = {
  product?: UsProduct;
  canWrite: boolean;
  onSave: (value: CreateUsProductInput | UpdateUsProductInput) => Promise<ProductSaveResult>;
  onClose: () => void;
  beginMutation: () => MutationRelease;
  onDirtyChange: (dirty: boolean) => void;
  accessRecovery?: MasterDataViewProps["accessRecovery"];
};

export function ProductForm({
  product,
  canWrite,
  onSave,
  onClose,
  beginMutation,
  onDirtyChange,
  accessRecovery,
}: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(product?.name ?? "");
  const [gtin, setGtin] = useState(product?.gtin14 ?? "");
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [errors, setErrors] = useState<{ name?: string; gtin?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const dirty = name !== (product?.name ?? "") || gtin !== (product?.gtin14 ?? "");
  const parsed = createUsProductSchema.safeParse({ name, gtin: gtin.trim() || null });
  const patch: UpdateUsProductInput = {};
  if (parsed.success && product) {
    if (parsed.data.name !== product.name) patch.name = parsed.data.name;
    const canonical = parsed.data.gtin === null ? null : normalizeToGtin14(parsed.data.gtin);
    if (canonical !== product.gtin14) patch.gtin = parsed.data.gtin;
  }
  const unchanged = product !== undefined && parsed.success && Object.keys(patch).length === 0;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (failure) alert.current?.focus();
  }, [failure, errors]);

  function requestClose() {
    if (saving.current || (dirty && !window.confirm(t("md.discardConfirm")))) return;
    onClose();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current || !canWrite || unchanged) return;
    if (!parsed.success) {
      const fields: { name?: string; gtin?: string } = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === "name") fields.name = name.trim() ? "nameFormat" : "required";
        if (issue.path[0] === "gtin") fields.gtin = "gtinFormat";
      }
      setErrors(fields);
      setFailure("invalid");
      return;
    }
    saving.current = true;
    setPending(true);
    setFailure(null);
    const release = beginMutation();
    try {
      const result = await onSave(product ? patch : parsed.data);
      if (result !== "saved") {
        setFailure(result);
        if (result === "product_gtin_taken" || result === "product_gtin_locked")
          setErrors({ gtin: result });
      }
    } finally {
      saving.current = false;
      setPending(false);
      release();
    }
  }

  return (
    <Drawer
      open
      title={t(product ? "catalog.edit" : "catalog.add")}
      closeLabel={t("md.close")}
      onClose={requestClose}
      className="us-md-drawer"
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={requestClose}>
            {t("md.cancel")}
          </Button>
          {canWrite ? (
            <Button type="submit" form="us-product-form" loading={pending} disabled={unchanged}>
              {t("catalog.save")}
            </Button>
          ) : null}
        </>
      }
    >
      <form
        ref={form}
        tabIndex={-1}
        id="us-product-form"
        className="us-md-form"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        {accessRecovery ? (
          <div role="alert">
            <p>{t("md.accessError")}</p>
            <Button
              disabled={pending || accessRecovery.pending}
              onClick={() => {
                setFailure(null);
                void accessRecovery.retry().then(() => form.current?.focus());
              }}
            >
              {t("md.retry")}
            </Button>
          </div>
        ) : null}
        {failure ? (
          <p ref={alert} role="alert" tabIndex={-1} className="us-md-field-error">
            {t(`catalog.${failure}`)}
          </p>
        ) : null}
        <Input
          label={t("catalog.name")}
          required
          disabled={pending || !canWrite}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setErrors({});
            setFailure(null);
          }}
          {...(errors.name ? { error: t(`catalog.${errors.name}`) } : {})}
        />
        <Input
          label={t("catalog.gtin")}
          inputMode="numeric"
          disabled={pending || !canWrite}
          value={gtin}
          onChange={(event) => {
            setGtin(event.target.value);
            setErrors({});
            setFailure(null);
          }}
          hint={t("catalog.gtinHint")}
          {...(errors.gtin ? { error: t(`catalog.${errors.gtin}`) } : {})}
        />
      </form>
    </Drawer>
  );
}
