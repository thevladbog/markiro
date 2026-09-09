import type {
  ImportDecision,
  ImportPrepareResponse,
  ImportPreview,
} from "@markiro/platform-contracts";
import { Alert, Button, Checkbox, Input, Select } from "@markiro/ui";
import { useState } from "react";
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
  comparisonRejected?: boolean;
  rejectedPreviewIds?: string[];
  onPrepare: (drafts: ReviewDrafts) => void;
  onApply: (decisions: ImportDecision[]) => void;
  onPhoto: (previewId: string, candidateId: string) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
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
  const [viewing, setViewing] = useState<Record<string, string>>({});
  const choiceFor = (p: ImportPreview) => currentChoice(p, choices[p.id]);
  function update(p: ImportPreview, fn: (choice: ReviewChoice) => ReviewChoice) {
    setChoices((previous) => ({ ...previous, [p.id]: fn(currentChoice(p, previous[p.id])) }));
  }
  const applicable = data.items.filter((p) => p.canApply);
  const ready = ["ready", "partial"].includes(data.preparation.state);
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
    <section aria-label={tr("review")}>
      <h2>{tr("review")}</h2>
      <p>{tr("reviewHint")}</p>
      {comparisonRejected && <Alert tone="error">{tr("comparisonRejected")}</Alert>}
      {!ready && <p role="status">{tr("preparing")}</p>}
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
              {preview.fields.map((field) => (
                <div key={field.id}>
                  <Checkbox
                    label={field.labelKey ? tr(`fields.${field.labelKey}`) : field.label}
                    checked={choice.decision.acceptedEntryIds.includes(field.id)}
                    disabled={
                      !canWrite ||
                      busy ||
                      !field.applicable ||
                      field.requiresEntryIds.some(
                        (id) => !choice.decision.acceptedEntryIds.includes(id),
                      )
                    }
                    onCheckedChange={(checked) =>
                      update(preview, (c) => toggleField(preview, c, field.id, checked))
                    }
                  />
                  <p>
                    <span>
                      {tr("before")}: {field.before ?? "—"}
                    </span>
                    <br />
                    <span>
                      {tr(field.source === "manual" ? "manualSource" : "after")}:{" "}
                      {field.after ?? "—"}
                    </span>
                  </p>
                  {field.reason && (
                    <p>
                      {t(`pages.catalog.import.reasons.${field.reason}`, {
                        defaultValue: tr("fieldUnavailable"),
                      })}
                    </p>
                  )}
                </div>
              ))}
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
            <h3>{tr("photo")}</h3>
            {!canPreparePhotos && preview.photos.some((photo) => photo.state === "pending") && (
              <p>{tr("photosUnavailable")}</p>
            )}
            <Button
              variant="secondary"
              disabled={!canWrite || busy}
              aria-pressed={choice.decision.photo.kind === "keep"}
              onClick={() => update(preview, keepPhoto)}
            >
              {preview.productId ? tr("keepPhoto") : tr("noPhoto")}
            </Button>
            <div className="mk-nc-photos">
              {preview.photos.map((photo) => (
                <div key={photo.candidateId}>
                  {photo.state === "ready" &&
                  (photo.reason === null || photo.reason === "barcode_mismatch") ? (
                    <>
                      <Button
                        variant="secondary"
                        onClick={() => setViewing({ ...viewing, [preview.id]: photo.candidateId })}
                      >
                        {tr("viewPhoto")}
                      </Button>
                      {viewing[preview.id] === photo.candidateId && (
                        <img
                          src={photoUrl(sessionId, photo.candidateId)}
                          alt={tr("photoPreview")}
                          width={120}
                          height={120}
                          onLoad={() =>
                            update(preview, (c) =>
                              c.viewedCandidateIds.includes(photo.candidateId)
                                ? c
                                : {
                                    ...c,
                                    viewedCandidateIds: [
                                      ...c.viewedCandidateIds,
                                      photo.candidateId,
                                    ],
                                  },
                            )
                          }
                        />
                      )}
                      <Button
                        variant="secondary"
                        disabled={!canWrite || busy}
                        aria-pressed={
                          choice.decision.photo.kind === "candidate" &&
                          choice.decision.photo.candidateId === photo.candidateId
                        }
                        onClick={() =>
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
                        {tr("choosePhoto")}
                      </Button>
                    </>
                  ) : (
                    <>
                      <p>{tr(photo.state === "pending" ? "photoPending" : "photoFailed")}</p>
                      {(photo.state === "pending" ||
                        (photo.state === "failed" && photo.reason === "download_failed")) && (
                        <Button
                          variant="secondary"
                          disabled={!canWrite || busy || !canPreparePhotos}
                          onClick={() => onPhoto(preview.id, photo.candidateId)}
                        >
                          {tr(photo.state === "failed" ? "retryPhotoPreparation" : "preparePhoto")}
                        </Button>
                      )}
                    </>
                  )}
                  {photo.reason && (
                    <p>
                      {t(`pages.catalog.import.reasons.${photo.reason}`, {
                        defaultValue: tr("photoFailed"),
                      })}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </fieldset>
        );
      })}
      {canWrite && (
        <p aria-label={tr("confirmationSummary")} aria-live="polite">
          {canConfirm
            ? t("pages.catalog.import.confirmationTotals", totals)
            : tr("confirmationIncomplete")}
        </p>
      )}
      {canWrite && (
        <div className="mk-nc-actions">
          <Button
            variant="secondary"
            disabled={busy || invalidName}
            onClick={() => onPrepare(effectiveDrafts)}
          >
            {tr("refreshComparison")}
          </Button>
          <Button
            variant="primary"
            disabled={!canConfirm}
            onClick={() => onApply(applicable.map((p) => choiceFor(p).decision))}
          >
            {tr("apply")}
          </Button>
        </div>
      )}
      {dirty && <p>{tr("draftNeedsComparison")}</p>}
    </section>
  );
}
