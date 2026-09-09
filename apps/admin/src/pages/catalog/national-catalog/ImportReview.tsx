import type {
  ImportDecision,
  ImportPrepareResponse,
  ImportPreview,
} from "@markiro/platform-contracts";
import { Alert, Button, Checkbox, Input, Select, RadioCard, Spinner } from "@markiro/ui";
import { useId, useState } from "react";
import { productImageUrl, type ProductDto } from "../api.js";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { photoUrl } from "./api.js";
import { currentChoice, keepPhoto, toggleField, type ReviewChoice } from "./reviewState.js";
export interface ReviewDrafts {
  manualNames: Record<string, string>;
  categoryChoices: Record<string, string>;
}
export function ImportReview({
  sessionId,
  data,
  canWrite,
  busy,
  canPreparePhotos = false,
  products = [],
  comparisonRejected = false,
  rejectedPreviewIds = [],
  onPrepare,
  onApply,
  onPhoto,
  onRetry,
}: {
  sessionId: string;
  data: ImportPrepareResponse;
  canWrite: boolean;
  busy: boolean;
  canPreparePhotos?: boolean;
  products?: readonly ProductDto[];
  comparisonRejected?: boolean;
  rejectedPreviewIds?: string[];
  onPrepare: (drafts: ReviewDrafts) => void;
  onApply: (decisions: ImportDecision[]) => void;
  onPhoto: (previewId: string, candidateId: string) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const choiceGroup = useId();
  const tr = (key: string) => t(`pages.catalog.import.${key}`);
  const [choices, setChoices] = useState<Record<string, ReviewChoice>>({});
  const [drafts, setDrafts] = useState<ReviewDrafts>(() => ({
    manualNames: Object.fromEntries(
      data.items.flatMap((p) =>
        p.fields
          .filter((f) => f.source === "manual" && f.after !== null)
          .map((f) => [p.itemId, f.after ?? ""]),
      ),
    ),
    categoryChoices: Object.fromEntries(
      data.items.flatMap((p) =>
        p.categoryOptions.filter((o) => o.selected).map((o) => [p.itemId, o.optionId]),
      ),
    ),
  }));
  const effectiveDrafts: ReviewDrafts = {
    manualNames: {
      ...Object.fromEntries(
        data.items.flatMap((p) =>
          p.fields
            .filter((f) => f.source === "manual" && f.after !== null)
            .map((f) => [p.itemId, f.after ?? ""]),
        ),
      ),
      ...drafts.manualNames,
    },
    categoryChoices: {
      ...Object.fromEntries(
        data.items.flatMap((p) =>
          p.categoryOptions.filter((o) => o.selected).map((o) => [p.itemId, o.optionId]),
        ),
      ),
      ...drafts.categoryChoices,
    },
  };
  const [dirty, setDirty] = useState(false);
  const choiceFor = (p: ImportPreview) => currentChoice(p, choices[p.id]);
  function update(p: ImportPreview, fn: (choice: ReviewChoice) => ReviewChoice) {
    setChoices((previous) => ({ ...previous, [p.id]: fn(currentChoice(p, previous[p.id])) }));
  }
  const applicable = data.items.filter((p) => p.canApply);
  const preparing =
    ["queued", "loading"].includes(data.preparation.state) ||
    (data.preparation.automaticWorkPending && data.preparation.completed < data.preparation.total);
  const ready = !preparing && ["ready", "partial"].includes(data.preparation.state);
  const invalidName = Object.values(effectiveDrafts.manualNames).some(
    (name) => name.trim().length > 200,
  );
  const validChoices = applicable.filter((p) => {
    const choice = choiceFor(p);
    return (
      !(p.linkAction === "replace" && !choice.replaceConfirmed) &&
      choice.decision.acceptedEntryIds.every((id) =>
        p.fields.some(
          (f) =>
            f.id === id &&
            f.applicable &&
            f.requiresEntryIds.every((required) =>
              choice.decision.acceptedEntryIds.includes(required),
            ),
        ),
      ) &&
      (p.productId !== null ||
        !p.fields.some((f) => f.labelKey === "name") ||
        choice.decision.acceptedEntryIds.some((id) =>
          p.fields.some((f) => f.id === id && f.labelKey === "name"),
        )) &&
      (choice.decision.photo.kind === "keep" ||
        p.photos.some(
          (photo) =>
            choice.decision.photo.kind === "candidate" &&
            photo.candidateId === choice.decision.photo.candidateId &&
            photo.state === "ready" &&
            (photo.reason === null || photo.reason === "barcode_mismatch"),
        ))
    );
  });
  const canConfirm =
    !busy &&
    !comparisonRejected &&
    !dirty &&
    ready &&
    applicable.length > 0 &&
    validChoices.length === applicable.length;
  const totals = {
    created: validChoices.filter((p) => !p.productId).length,
    attached: validChoices.filter((p) => p.linkAction === "attach").length,
    replaced: validChoices.filter((p) => p.linkAction === "replace").length,
    changed: validChoices.filter(
      (p) => p.productId && choiceFor(p).decision.acceptedEntryIds.length > 0,
    ).length,
    photos: validChoices.filter((p) => choiceFor(p).decision.photo.kind === "candidate").length,
  };
  return (
    <section aria-label={tr("review")} className="mk-nc-review">
      <header className="mk-nc-section-heading">
        <h2>{tr("review")}</h2>
        <p className="mk-nc-hint">{tr("reviewHint")}</p>
      </header>
      {comparisonRejected && <Alert tone="error">{tr("comparisonRejected")}</Alert>}
      {preparing && (
        <div className="mk-nc-progress" role="status">
          <Spinner aria-hidden="true" />
          <div>
            <p>{tr("preparing")}</p>
            <p className="mk-nc-hint">
              {t("pages.catalog.import.preparationProgress", {
                completed: data.preparation.completed,
                total: data.preparation.total,
              })}
            </p>
          </div>
        </div>
      )}
      {!ready && !preparing && <Alert tone="error">{tr("loadFailed")}</Alert>}
      {data.preparation.failures.map((f) => (
        <Alert key={f.itemId} tone="error">
          {f.itemId}:{" "}
          {t(`pages.catalog.import.reasons.${f.reason}`, { defaultValue: tr("itemUnavailable") })}
        </Alert>
      ))}
      {canWrite && data.preparation.failures.some((f) => f.retryable) && (
        <Button variant="secondary" disabled={busy} onClick={onRetry}>
          {tr("retryComparison")}
        </Button>
      )}
      {data.items.map((preview) => {
        const choice = choiceFor(preview);
        const product = products.find((item) => item.id === preview.productId);
        const currentPhoto = product ? productImageUrl(product) : null;
        return (
          <fieldset className="mk-nc-review-item" key={preview.id}>
            <legend>
              {preview.identity.gtin14} · {preview.identity.name ?? tr("unnamed")}
            </legend>
            {comparisonRejected && rejectedPreviewIds.includes(preview.id) && (
              <Alert tone="error">{tr("rejectedItem")}</Alert>
            )}
            <p>
              {tr(
                preview.linkAction === "replace"
                  ? "matches.other_link"
                  : preview.linkAction === "keep"
                    ? "matches.linked"
                    : preview.productId
                      ? "matches.existing"
                      : "matches.new",
              )}
            </p>
            {preview.productId && (
              <Link to={`/catalog/${preview.productId}/edit`}>{tr("openProduct")}</Link>
            )}
            {!preview.canApply && (
              <Alert tone="error">
                {t(`pages.catalog.import.reasons.${preview.reason}`, {
                  defaultValue: tr("itemUnavailable"),
                })}
              </Alert>
            )}
            <Input
              disabled={!canWrite || busy}
              label={tr("manualName")}
              hint={tr("manualNameHint")}
              maxLength={200}
              value={effectiveDrafts.manualNames[preview.itemId] ?? ""}
              onChange={(e) => {
                setDirty(true);
                setDrafts({
                  ...effectiveDrafts,
                  manualNames: { ...effectiveDrafts.manualNames, [preview.itemId]: e.target.value },
                });
              }}
            />
            {preview.categoryOptions.length > 0 && (
              <Select
                native
                disabled={!canWrite || busy}
                label={tr("initialCategory")}
                value={
                  effectiveDrafts.categoryChoices[preview.itemId] ??
                  preview.categoryOptions.find((o) => o.selected)?.optionId ??
                  ""
                }
                options={[
                  { value: "", label: tr("noCategory") },
                  ...preview.categoryOptions.map((o) => ({ value: o.optionId, label: o.label })),
                ]}
                onValueChange={(optionId) => {
                  const next = {
                    ...effectiveDrafts,
                    categoryChoices: {
                      ...effectiveDrafts.categoryChoices,
                      [preview.itemId]: optionId,
                    },
                  };
                  setDrafts(next);
                  setDirty(true);
                  if (!invalidName) onPrepare(next);
                }}
              />
            )}
            <div className="mk-nc-fields">
              <div className="mk-nc-comparison-head" aria-hidden="true">
                <span>{tr("currentColumn")}</span>
                <span>{tr("proposedColumn")}</span>
              </div>
              {preview.fields.map((field) => {
                const title = field.labelKey ? tr(`fields.${field.labelKey}`) : field.label;
                const accepted = choice.decision.acceptedEntryIds.includes(field.id);
                const missing = field.requiresEntryIds.filter(
                  (id) => !choice.decision.acceptedEntryIds.includes(id),
                );
                const reason = missing.length
                  ? t("pages.catalog.import.requiresFields", {
                      fields: missing
                        .map((id) => {
                          const required = preview.fields.find((entry) => entry.id === id);
                          return required?.labelKey
                            ? tr(`fields.${required.labelKey}`)
                            : (required?.label ?? id);
                        })
                        .join(", "),
                    })
                  : field.reason
                    ? t(`pages.catalog.import.reasons.${field.reason}`, {
                        defaultValue: tr("fieldUnavailable"),
                      })
                    : undefined;
                return (
                  <fieldset className="mk-nc-comparison-row" key={field.id}>
                    <legend className="mk-nc-sr-only">{title}</legend>
                    <RadioCard
                      name={`${choiceGroup}-${preview.id}-${field.id}`}
                      label={`${title} — ${tr("currentColumn")}`}
                      title={title}
                      caption={tr("currentColumn")}
                      checked={!accepted}
                      disabled={!canWrite || busy || !preview.canApply || !field.applicable}
                      onSelect={() =>
                        update(preview, (c) => toggleField(preview, c, field.id, false))
                      }
                    >
                      {field.before ?? tr(preview.productId ? "emptyValue" : "doNotAdd")}
                    </RadioCard>
                    <RadioCard
                      name={`${choiceGroup}-${preview.id}-${field.id}`}
                      label={`${title} — ${tr("proposedColumn")}`}
                      title={title}
                      caption={tr(field.source === "manual" ? "manualSource" : "providerSource")}
                      checked={accepted}
                      disabled={
                        !canWrite ||
                        busy ||
                        !preview.canApply ||
                        !field.applicable ||
                        missing.length > 0
                      }
                      description={reason}
                      onSelect={() =>
                        update(preview, (c) => toggleField(preview, c, field.id, true))
                      }
                    >
                      {field.after ?? tr("emptyValue")}
                    </RadioCard>
                  </fieldset>
                );
              })}
            </div>
            {preview.productId && canWrite && (
              <Button
                variant="secondary"
                onClick={() =>
                  update(preview, (c) => ({
                    ...c,
                    decision: { ...c.decision, acceptedEntryIds: [] },
                  }))
                }
              >
                {tr("linkOnly")}
              </Button>
            )}
            {preview.linkAction === "replace" && (
              <Checkbox
                disabled={!canWrite || busy}
                label={tr("confirmReplace")}
                checked={choice.replaceConfirmed}
                onCheckedChange={(replaceConfirmed) =>
                  update(preview, (c) => ({ ...c, replaceConfirmed }))
                }
              />
            )}
            <fieldset className="mk-nc-photo-comparison">
              <legend>{tr("photo")}</legend>
              <div className="mk-nc-comparison-row">
                <RadioCard
                  name={`${choiceGroup}-${preview.id}-photo`}
                  label={tr(preview.productId ? "keepPhoto" : "noPhoto")}
                  title={tr("photo")}
                  caption={tr("currentColumn")}
                  checked={choice.decision.photo.kind === "keep"}
                  disabled={!canWrite || busy || !preview.canApply}
                  onSelect={() => update(preview, keepPhoto)}
                >
                  {currentPhoto && (
                    <img src={currentPhoto} alt={tr("currentPhoto")} width={120} height={120} />
                  )}
                  {tr(preview.productId ? "keepPhoto" : "noPhoto")}
                </RadioCard>
                <div className="mk-nc-photo-candidates">
                  {preview.photos.length === 0 && <p>{tr("noSourcePhoto")}</p>}
                  {!canPreparePhotos &&
                    preview.photos.some((photo) => photo.state === "pending") && (
                      <p>{tr("photosUnavailable")}</p>
                    )}
                  {preview.photos.map((photo) => {
                    const available =
                      photo.state === "ready" &&
                      (photo.reason === null || photo.reason === "barcode_mismatch");
                    return (
                      <div className="mk-nc-photo-candidate" key={photo.candidateId}>
                        <RadioCard
                          name={`${choiceGroup}-${preview.id}-photo`}
                          label={tr("choosePhoto")}
                          title={tr("photo")}
                          caption={tr("providerSource")}
                          checked={
                            choice.decision.photo.kind === "candidate" &&
                            choice.decision.photo.candidateId === photo.candidateId
                          }
                          disabled={!canWrite || busy || !preview.canApply || !available}
                          description={
                            photo.reason
                              ? t(`pages.catalog.import.reasons.${photo.reason}`, {
                                  defaultValue: tr("photoFailed"),
                                })
                              : undefined
                          }
                          onSelect={() =>
                            update(preview, (c) => ({
                              ...c,
                              photoExplicit: true,
                              decision: {
                                ...c.decision,
                                photo: { kind: "candidate", candidateId: photo.candidateId },
                              },
                            }))
                          }
                        >
                          {available && (
                            <img
                              src={photoUrl(sessionId, photo.candidateId)}
                              alt={tr("photoPreview")}
                              width={120}
                              height={120}
                              onLoad={() =>
                                update(preview, (c) =>
                                  c.loadedCandidateIds.includes(photo.candidateId)
                                    ? c
                                    : {
                                        ...c,
                                        loadedCandidateIds: [
                                          ...c.loadedCandidateIds,
                                          photo.candidateId,
                                        ],
                                      },
                                )
                              }
                            />
                          )}
                          {tr(
                            available
                              ? "choosePhoto"
                              : photo.state === "pending"
                                ? photo.automaticWorkPending === false
                                  ? "photoNotPrepared"
                                  : "photoPending"
                                : "photoFailed",
                          )}
                        </RadioCard>
                        {!available &&
                          ((photo.state === "pending" && photo.automaticWorkPending !== true) ||
                            (photo.state === "failed" && photo.reason === "download_failed")) && (
                            <Button
                              variant="secondary"
                              disabled={!canWrite || busy || !canPreparePhotos}
                              onClick={() => onPhoto(preview.id, photo.candidateId)}
                            >
                              {tr(
                                photo.state === "failed" ? "retryPhotoPreparation" : "preparePhoto",
                              )}
                            </Button>
                          )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </fieldset>
          </fieldset>
        );
      })}
      {canWrite && ready && (
        <p aria-label={tr("confirmationSummary")} aria-live="polite">
          {canConfirm
            ? t("pages.catalog.import.confirmationTotals", totals)
            : tr("confirmationIncomplete")}
        </p>
      )}
      {canWrite && !preparing && (
        <div className="mk-nc-actions">
          <Button
            variant="secondary"
            disabled={busy || invalidName}
            onClick={() => onPrepare(effectiveDrafts)}
          >
            {tr("refreshComparison")}
          </Button>
          {ready && (
            <Button
              variant="primary"
              disabled={!canConfirm}
              onClick={() => onApply(applicable.map((p) => choiceFor(p).decision))}
            >
              {tr("apply")}
            </Button>
          )}
        </div>
      )}
      {dirty && <p>{tr("draftNeedsComparison")}</p>}
    </section>
  );
}
