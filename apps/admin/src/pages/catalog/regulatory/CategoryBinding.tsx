import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Checkbox, Input, Select, Spinner } from "@markiro/ui";
import { ApiRequestError } from "../../../api/client.js";
import {
  type RegulatoryProfile,
  type CategoryProposal,
  useApplyCategory,
  useCategoryChangePreview,
  useRegulatoryCategoryOptions,
  useReloadRegulatoryProfile,
} from "./api.js";
import { valueText } from "./value.js";

export function CategoryBinding({
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
  const [editing, setEditing] = useState(false);
  const [baseline, setBaseline] = useState(profile);
  const [schemaId, setSchemaId] = useState("");
  const [tnVed, setTnVed] = useState("");
  const [okpd, setOkpd] = useState("");
  const [mappingConfirmed, setMappingConfirmed] = useState(false);
  const [proposal, setProposal] = useState<CategoryProposal | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const options = useRegulatoryCategoryOptions(profile.productId, editing);
  const preview = useCategoryChangePreview(profile.productId);
  const apply = useApplyCategory(profile.productId);
  const reload = useReloadRegulatoryProfile(profile.productId);
  const busy = preview.isPending || apply.isPending || reload.isPending;
  const target = options.data?.items.find((item) => item.schemaVersionId === schemaId);
  useEffect(() => {
    onDirtyChange(editing);
    return () => onDirtyChange(false);
  }, [editing, onDirtyChange]);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  const binding = profile.binding;
  const start = async () => {
    setBaseline(profile);
    setTnVed(profile.binding?.tnVedCode ?? "");
    setOkpd(profile.binding?.okpd2Code ?? "");
    setEditing(true);
    setProposal(null);
    setFailure(null);
    setSchemaId("");
    setMappingConfirmed(false);
    try {
      const current = await reload.mutateAsync();
      setBaseline(current);
      setTnVed(current.binding?.tnVedCode ?? "");
      setOkpd(current.binding?.okpd2Code ?? "");
    } catch {
      setFailure("reloadError");
    }
  };
  const errorKey = (error: unknown) =>
    error instanceof ApiRequestError && error.status === 409 ? "changed" : "saveError";
  const previewCategory = async () => {
    if (
      disabled ||
      busy ||
      !target ||
      target.mappingState === "unmapped" ||
      (target.mappingState === "ambiguous" && !mappingConfirmed)
    )
      return;
    try {
      setFailure(null);
      const result = await preview.mutateAsync({
        baseRevision: baseline.binding?.revision ?? 0,
        targetSchemaVersionId: schemaId,
        tnVedCode: tnVed.trim() || null,
        okpd2Code: okpd.trim() || null,
        mappingConfirmed,
      });
      setProposal(result);
      setSelected(
        result.diff.entries
          .filter(
            (entry) =>
              entry.target === "attribute" &&
              (entry.disposition === "transferable" || entry.disposition === "convertible"),
          )
          .map((entry) => entry.entryId),
      );
    } catch (error) {
      setFailure(errorKey(error));
    }
  };
  const applyCategory = async () => {
    if (!proposal || disabled || busy || !canWrite) return;
    try {
      setFailure(null);
      await apply.mutateAsync({
        proposalId: proposal.proposalId,
        acceptedEntryIds: selected,
      });
      setEditing(false);
      setProposal(null);
    } catch (error) {
      setFailure(errorKey(error));
    }
  };

  return (
    <section
      className="mk-catalog-panel-section mk-regulatory"
      aria-labelledby="category-binding-title"
    >
      <h3 id="category-binding-title">{t(p + "category")}</h3>
      {binding ? (
        <dl className="mk-regulatory-binding">
          <dt>{t(p + "categoryName")}</dt>
          <dd>{binding.categoryName}</dd>
          <dt>{t(p + "tnVed")}</dt>
          <dd>{binding.tnVedCode ?? t(p + "notSet")}</dd>
          <dt>{t(p + "okpd")}</dt>
          <dd>{binding.okpd2Code ?? t(p + "notSet")}</dd>
          <dt>{t(p + "source")}</dt>
          <dd>{t(p + "sources." + binding.source)}</dd>
        </dl>
      ) : (
        <p>{t(p + "unbound")}</p>
      )}
      {canWrite && !editing && (
        <Button type="button" variant="secondary" disabled={disabled} onClick={() => void start()}>
          {t(p + (binding ? "changeCategory" : "chooseCategory"))}
        </Button>
      )}
      {editing && (
        <div className="mk-regulatory-category-editor">
          {!proposal ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void previewCategory();
              }}
            >
              {options.isPending ? (
                <Spinner label={t("common.loading")} />
              ) : options.isError ? (
                <>
                  <Alert tone="error">{t(p + "optionsError")}</Alert>
                  <Button type="button" onClick={() => void options.refetch()}>
                    {t(p + "retry")}
                  </Button>
                </>
              ) : (
                <>
                  <Select
                    native
                    label={t(p + "categoryName")}
                    disabled={disabled || busy}
                    value={schemaId}
                    options={[
                      { value: "", label: t(p + "chooseOption") },
                      ...(options.data?.items ?? []).map((item) => ({
                        value: item.schemaVersionId,
                        label: item.categoryName,
                        disabled: item.mappingState === "unmapped",
                      })),
                    ]}
                    onValueChange={(value) => {
                      setSchemaId(value);
                      setMappingConfirmed(false);
                    }}
                  />
                  {options.data?.items.length === 0 && (
                    <Alert tone="info">{t(p + "noCategories")}</Alert>
                  )}
                </>
              )}
              <Input
                label={t(p + "tnVed")}
                value={tnVed}
                disabled={disabled || busy}
                onChange={(e) => setTnVed(e.target.value)}
              />
              <Input
                label={t(p + "okpd")}
                value={okpd}
                disabled={disabled || busy}
                onChange={(e) => setOkpd(e.target.value)}
              />
              {target?.mappingState === "ambiguous" && (
                <Checkbox
                  label={t(p + "confirmMapping")}
                  checked={mappingConfirmed}
                  disabled={disabled || busy}
                  onCheckedChange={setMappingConfirmed}
                />
              )}
              <Button
                type="submit"
                disabled={
                  disabled ||
                  busy ||
                  !target ||
                  target.mappingState === "unmapped" ||
                  (target.mappingState === "ambiguous" && !mappingConfirmed)
                }
              >
                {t(p + "preview")}
              </Button>
            </form>
          ) : (
            <div>
              <h4>{t(p + "review")}</h4>
              <p>{proposal.diff.target.categoryName}</p>
              <p className="mk-regulatory-meta">{t(p + "transferHint")}</p>
              {proposal.diff.entries.length === 0 && <p>{t(p + "noTransfer")}</p>}
              <ul className="mk-category-diff">
                {proposal.diff.entries.map((entry, index) => {
                  const label =
                    entry.target === "attribute"
                      ? (baseline.definition?.attributes.find(
                          (a) => a.id === entry.targetAttributeId,
                        )?.label ?? t(p + "numberedAttribute", { index: index + 1 }))
                      : t(p + "egais");
                  const applicable =
                    entry.target === "attribute" &&
                    (entry.disposition === "transferable" || entry.disposition === "convertible");
                  return (
                    <li key={entry.entryId}>
                      {applicable ? (
                        <Checkbox
                          label={label}
                          checked={selected.includes(entry.entryId)}
                          disabled={disabled || busy}
                          onCheckedChange={(checked) =>
                            setSelected((ids) =>
                              checked
                                ? [...ids, entry.entryId]
                                : ids.filter((id) => id !== entry.entryId),
                            )
                          }
                        />
                      ) : (
                        <strong>{label}</strong>
                      )}
                      <p>
                        {entry.target === "attribute"
                          ? `${valueText(entry.currentValue, t)} → ${valueText(entry.proposedValue, t)}`
                          : entry.current.codes.join(", ")}
                      </p>
                      <p className="mk-regulatory-meta">
                        {t(
                          p +
                            "dispositions." +
                            (entry.target === "attribute" ? entry.disposition : "retained"),
                        )}
                      </p>
                    </li>
                  );
                })}
              </ul>
              <Button
                type="button"
                disabled={disabled || busy}
                onClick={() => void applyCategory()}
              >
                {t(p + "confirmCategory")}
              </Button>
            </div>
          )}
          {failure && <Alert tone="error">{t(p + failure)}</Alert>}
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setProposal(null);
            }}
          >
            {t("pages.catalog.cancel")}
          </Button>
        </div>
      )}
    </section>
  );
}
