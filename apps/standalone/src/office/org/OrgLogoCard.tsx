import { useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import type { MonoBitmap } from "@markiro/domain";
import { Alert, Button, Card, FileDropZone } from "@markiro/ui";

import type { OrgLogoState } from "../../host/protocol.js";
import { decodeLogoFile, LOGO_FILE_TYPES, logoFromWire, logoToWire } from "../../labels/logo.js";
import { useCan } from "../access.js";
import { useLogoUploadLocked } from "../branding.js";
import { alertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { OfficeIcon } from "../OfficeIcon.js";
import { LoadError, PageLoading, WriteFailureAlert } from "../page-state.js";
import { BitmapCanvas } from "./BitmapCanvas.js";
import { hasInk } from "./logo-canvas.js";
import { logoDecodeKey, logoWriteKey } from "./logo-failure.js";

type Message = { tone: "ok" | "error"; text: string };

/** What the picker offers: the types `decodeLogoFile` accepts. */
const LOGO_ACCEPT = LOGO_FILE_TYPES.join(",");

/**
 * The organization's print logo (plan А4): what labels with a logo box and A4
 * sheets print, shown as it prints — black and white. The picked picture is
 * untrusted: it is turned into 1-bit dots here (`decodeLogoFile` refuses a
 * wrong type or a large file unread and draws the picture, an SVG included,
 * only into a canvas) and only the dots are shown and sent, after the
 * administrator has seen them. Without a logo the bundled Markiro logo
 * prints. Administrators change it; removing it asks first.
 */
export function OrgLogoCard() {
  const { t } = useTranslation();
  const canEdit = useCan("editReference");
  const locked = useLogoUploadLocked();
  const lockNoteId = useId();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const state = useOfficeQuery(officeKeys.orgLogo, (api, token) => api.getOrgLogo(token));
  const put = useOfficeMutation((api, token, bitmap: MonoBitmap) =>
    api.putOrgLogo(token, logoToWire(bitmap)),
  );
  // The latest picked file wins: a slow decode of an earlier one is dropped.
  const pick = useRef(0);
  const saving = useRef(false);
  const [staged, setStaged] = useState<MonoBitmap | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [removing, setRemoving] = useState(false);
  const logo = state.data?.logo ?? null;
  const current = useMemo(() => (logo === null ? null : logoFromWire(logo)), [logo]);

  const stored = (next: OrgLogoState, text: string) => {
    queryClient.setQueryData(officeKeys.orgLogo, next);
    setMessage({ tone: "ok", text });
  };

  const choose = async (file: File) => {
    const mine = ++pick.current;
    setMessage(null);
    setStaged(null);
    let bitmap: MonoBitmap;
    try {
      bitmap = await decodeLogoFile(file);
    } catch (error) {
      if (mine === pick.current) setMessage({ tone: "error", text: t(logoDecodeKey(error)) });
      return;
    }
    if (mine !== pick.current) return;
    if (!hasInk(bitmap)) {
      setMessage({ tone: "error", text: t("office.org.logo.errors.blank") });
      return;
    }
    setStaged(bitmap);
  };

  const save = async () => {
    if (staged === null || saving.current) return;
    saving.current = true;
    setMessage(null);
    try {
      stored(await put.mutateAsync(staged), t("office.org.logo.saved"));
      setStaged(null);
    } catch (error) {
      setMessage({ tone: "error", text: t(logoWriteKey(error)) });
    } finally {
      saving.current = false;
    }
  };

  if (state.isPending) return <PageLoading />;
  if (state.isError) return <LoadError error={state.error} onRetry={() => void state.refetch()} />;
  return (
    <Card className="org-card org-logo-card">
      <div className="org-logo-card__head">
        <h2 className="org-logo-card__title">
          <OfficeIcon name={locked && canEdit ? "lock" : "image"} size={20} />
          {t("office.org.logo.title")}
        </h2>
        {locked && canEdit && (
          <span className="office-chip">
            <OfficeIcon name="lock" size={16} />
            {t("office.org.logo.needsLicense")}
          </span>
        )}
      </div>
      <p className="org-logo-card__intro">{t("office.org.logo.intro")}</p>
      {message !== null && <Alert tone={message.tone}>{message.text}</Alert>}
      {/* The paper the logo prints on: literal white in both themes, the printer's black on it. */}
      <div className="org-logo-paper">
        {logo === null ? (
          <p className="org-logo-paper__none">{t("office.org.logo.none")}</p>
        ) : current === null ? (
          <Alert tone="warn">{t("office.org.logo.unreadableStored")}</Alert>
        ) : (
          <BitmapCanvas
            bitmap={current}
            className="org-logo-preview"
            label={t("office.org.logo.preview")}
          />
        )}
      </div>
      {staged !== null && (
        <section aria-label={t("office.org.logo.stagedTitle")}>
          <p>{t("office.org.logo.stagedIntro")}</p>
          <BitmapCanvas
            bitmap={staged}
            className="org-logo-preview"
            label={t("office.org.logo.stagedPreview")}
          />
          <div className="standalone-form__actions">
            <Button loading={put.isPending} onClick={() => void save()}>
              {t("office.org.logo.save")}
            </Button>
            <Button variant="secondary" disabled={put.isPending} onClick={() => setStaged(null)}>
              {t("office.org.logo.discard")}
            </Button>
          </div>
        </section>
      )}
      {canEdit ? (
        <>
          {locked && (
            <>
              <Alert tone="info" role="note" id={lockNoteId} tabIndex={0}>
                {t("office.org.logo.licenseLocked")}
              </Alert>
              <Button
                variant="secondary"
                icon={<OfficeIcon name="arrowRight" size={20} />}
                onClick={() => void navigate("/about#license")}
              >
                {t("office.org.logo.openAbout")}
              </Button>
            </>
          )}
          <div role="group" aria-describedby={locked ? lockNoteId : undefined}>
            <FileDropZone
              compact
              disabled={locked}
              label={t(logo === null ? "office.org.logo.upload" : "office.org.logo.replace")}
              accept={LOGO_ACCEPT}
              busy={put.isPending}
              onFile={(file) => void choose(file)}
              onRejected={() => {
                pick.current += 1;
                setStaged(null);
                setMessage({ tone: "error", text: t("office.org.logo.errors.unsupported_type") });
              }}
            />
          </div>
          <div className="standalone-form__actions">
            {logo !== null && (
              <Button
                variant="destructive-outline"
                disabled={put.isPending}
                onClick={() => setRemoving(true)}
              >
                {t("office.org.logo.remove")}
              </Button>
            )}
          </div>
        </>
      ) : (
        <p className="office-note">{t("office.org.logo.readOnly")}</p>
      )}
      {removing && (
        <RemoveLogoDialog
          onClose={() => setRemoving(false)}
          onRemoved={(next) => {
            setRemoving(false);
            setStaged(null);
            stored(next, t("office.org.logo.removed"));
          }}
        />
      )}
    </Card>
  );
}

function RemoveLogoDialog({
  onClose,
  onRemoved,
}: {
  onClose: () => void;
  onRemoved: (state: OrgLogoState) => void;
}) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<ReturnType<typeof alertFailure> | null>(null);
  const clear = useOfficeMutation((api, token, _: null) => api.deleteOrgLogo(token));
  const submit = async () => {
    setFailure(null);
    let next: OrgLogoState;
    try {
      next = await clear.mutateAsync(null);
    } catch (error) {
      setFailure(alertFailure(error));
      return;
    }
    onRemoved(next);
  };
  return (
    <FormDialog
      title={t("office.org.logo.removeTitle")}
      submitLabel={t("office.org.logo.removeSubmit")}
      submitVariant="destructive"
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <p>{t("office.org.logo.removeBody")}</p>
    </FormDialog>
  );
}
