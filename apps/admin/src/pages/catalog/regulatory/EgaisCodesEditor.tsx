import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Input, Select } from "@markiro/ui";
import { ApiRequestError } from "../../../api/client.js";
import { type RegulatoryProfile, useUpdateEgaisCodes, useReloadRegulatoryProfile } from "./api.js";

const collection = (profile: RegulatoryProfile) => ({
  codes: profile.egaisCodes.map((item) => item.code),
  primaryCode: profile.egaisCodes.find((item) => item.isPrimary)?.code ?? null,
});
export function EgaisCodesEditor({
  profile,
  canWrite,
  disabled,
  onDirtyChange,
  onBusyChange,
}: {
  profile: RegulatoryProfile;
  canWrite: boolean;
  disabled: boolean;
  onDirtyChange: (v: boolean) => void;
  onBusyChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const p = "pages.catalog.regulatory.";
  const [baseline, setBaseline] = useState(profile);
  const [draft, setDraft] = useState(() => collection(profile));
  const [failure, setFailure] = useState<string | null>(null);
  const mutation = useUpdateEgaisCodes(profile.productId);
  const reload = useReloadRegulatoryProfile(profile.productId);
  const busy = mutation.isPending || reload.isPending;
  const dirty = JSON.stringify(draft) !== JSON.stringify(collection(baseline));
  if (!dirty && profile !== baseline) {
    setBaseline(profile);
    setDraft(collection(profile));
  }
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  const binding = baseline.binding;
  if (!binding) return null;
  const saveEgais = async () => {
    if (disabled || busy) return;
    if (
      draft.codes.some((code) => !/^\d{19}$/.test(code)) ||
      new Set(draft.codes).size !== draft.codes.length ||
      (draft.codes.length > 0 && (!draft.primaryCode || !draft.codes.includes(draft.primaryCode)))
    ) {
      setFailure("egaisInvalid");
      return;
    }
    try {
      setFailure(null);
      const next = await mutation.mutateAsync({ baseRevision: binding.revision, ...draft });
      setBaseline(next);
      setDraft(collection(next));
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
      setDraft(collection(next));
      setFailure(null);
    } catch {
      setFailure("reloadError");
    }
  };

  return (
    <section className="mk-catalog-panel-section mk-regulatory" aria-labelledby="egais-codes-title">
      <h3 id="egais-codes-title">{t(p + "egais")}</h3>
      {canWrite ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveEgais();
          }}
        >
          {draft.codes.map((code, index) => (
            <div className="mk-regulatory-list-row" key={index}>
              <Input
                label={t(p + "egaisCode", { index: index + 1 })}
                value={code}
                inputMode="numeric"
                disabled={disabled || busy}
                onChange={(e) =>
                  setDraft((old) => ({
                    codes: old.codes.map((item, i) => (i === index ? e.target.value : item)),
                    primaryCode: old.primaryCode === code ? e.target.value : old.primaryCode,
                  }))
                }
              />
              <Button
                type="button"
                variant="secondary"
                disabled={disabled || busy}
                onClick={() =>
                  setDraft((old) => ({
                    codes: old.codes.filter((_, i) => i !== index),
                    primaryCode: old.primaryCode === code ? null : old.primaryCode,
                  }))
                }
              >
                {t(p + "removeValue", { index: index + 1 })}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            disabled={disabled || busy || draft.codes.length >= 20}
            onClick={() => setDraft((old) => ({ ...old, codes: [...old.codes, ""] }))}
          >
            {t(p + "addEgais")}
          </Button>
          <Select
            native
            label={t(p + "primaryEgais")}
            disabled={disabled || busy}
            value={draft.primaryCode ?? ""}
            options={[
              { value: "", label: t(p + "notSet") },
              ...new Set(draft.codes.filter(Boolean)),
            ]}
            onValueChange={(value) => setDraft((old) => ({ ...old, primaryCode: value || null }))}
          />
          {failure && <Alert tone="error">{t(p + failure)}</Alert>}
          <div className="mk-regulatory-actions">
            <Button type="submit" disabled={!dirty || disabled || busy}>
              {t(p + "saveEgais")}
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
        </form>
      ) : (
        <ul>
          {profile.egaisCodes.map((item) => (
            <li key={item.code}>
              {item.code}
              {item.isPrimary ? ` · ${t(p + "primaryEgais")}` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
