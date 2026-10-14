import { useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import { HostError } from "../../../host/client.js";
import { errorMessageKey } from "../../../host/errors.js";
import type { OfficeLicense } from "../../../host/protocol.js";
import { EMERGENCY_MS, licenseMinute } from "../../../lib/license-dates.js";
import { OfficeFilesError } from "../../exports/office-files.js";
import { useOfficeFiles } from "../../exports/office-files-context.js";
import { FormDialog } from "../../FormDialog.js";
import { officeKeys, useOfficeMutation } from "../../office-query.js";
import { ACTIVATION_FILE, activationBytes, activationFolder } from "./license-files.js";
import type { LicenseText } from "./license-view.js";

type Saved =
  | { kind: "saved"; path: string; segments: readonly string[] }
  | { kind: "failed"; text: LicenseText };

export interface LicenseActionsProps {
  license: OfficeLicense;
  zone: string | null;
}

/**
 * The administrator's actions besides a file (spec §9.2): «Сохранить запрос
 * на активацию» (the host builds it, the shell saves it under
 * `Документы\Markiro\Лицензия` without a file dialog) and, where no new
 * shift opens and the host allows it, «Открыть новые смены ещё 3 дня»
 * (spec §3.5), asked first, once per license. A second press while the
 * request is fetched or saved sends nothing; the button is busy all along.
 * The question reads the license afresh first, so «до …» counts from the
 * host's time now (the last known one if the host does not answer); a
 * refusal because the extension was used or is not needed reads it again, so
 * the offer goes when the host no longer makes it.
 */
export function LicenseActions({ license, zone }: LicenseActionsProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const files = useOfficeFiles();
  const queryClient = useQueryClient();
  // The answer names the organization and its INN: reset once saved, and
  // `gcTime: 0` drops it from the mutation cache at once.
  const request = useOfficeMutation((api, token, _: null) => api.getActivationRequest(token), {
    gcTime: 0,
  });
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const opening = useRef(false);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState<LicenseText | null>(null);
  // The host offers it only while no new shift opens and it was not used for this file (plan ЛЦ-2, Д6).
  const emergencyOffered = license.emergency.available;

  const save = async () => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setSaved(null);
    setNotice(null);
    try {
      const body = await request.mutateAsync(null);
      const folder = await files.save(activationFolder(new Date()), [
        { name: ACTIVATION_FILE, bytes: activationBytes(body) },
      ]);
      setSaved({ kind: "saved", path: folder.path, segments: folder.segments });
    } catch (error) {
      setSaved({
        kind: "failed",
        text:
          error instanceof OfficeFilesError
            ? { key: "office.about.license.activation.saveFailed" }
            : { key: errorMessageKey(error) },
      });
    } finally {
      // The request names the organization and its INN: once saved (or not), no copy stays.
      request.reset();
      saving.current = false;
      setBusy(false);
    }
  };

  const ask = async () => {
    if (opening.current) return;
    opening.current = true;
    // A message leaves with the next action, the saved request's too.
    setSaved(null);
    setNotice(null);
    // The host's time now, for «до …»; a failed read keeps the last answer (no throw).
    await queryClient.refetchQueries({ queryKey: officeKeys.license, exact: true });
    opening.current = false;
    const fresh = queryClient.getQueryData<OfficeLicense>(officeKeys.license) ?? license;
    if (fresh.emergency.available) setAsking(true);
  };

  return (
    <section className="license-part" aria-labelledby={titleId}>
      <h3 id={titleId}>{t("office.about.license.actionsTitle")}</h3>
      <p className="office-note">{t("office.about.license.activation.hint")}</p>
      <div className="standalone-form__actions">
        <Button variant="secondary" loading={busy} onClick={() => void save()}>
          {t("office.about.license.activation.save")}
        </Button>
        {emergencyOffered && (
          <Button variant="secondary" onClick={() => void ask()}>
            {t("office.about.license.emergency.open")}
          </Button>
        )}
      </div>
      <div className="backup-alerts" aria-live="polite">
        {saved?.kind === "saved" && (
          <Alert
            tone="ok"
            role="presentation"
            action={
              <Button
                variant="secondary"
                size="compact"
                onClick={() => void files.open(saved.segments).catch(() => undefined)}
              >
                {t("office.about.license.activation.showFolder")}
              </Button>
            }
          >
            {t("office.about.license.activation.saved", { path: saved.path })}
          </Alert>
        )}
        {saved?.kind === "failed" && (
          <Alert tone="error" role="presentation">
            {t(saved.text.key, saved.text.values ?? {})}
          </Alert>
        )}
        {notice !== null && (
          <Alert tone="ok" role="presentation">
            {t(notice.key, notice.values ?? {})}
          </Alert>
        )}
      </div>
      {asking && (
        <EmergencyDialog
          license={license}
          zone={zone}
          onClose={() => setAsking(false)}
          onRefused={() => void queryClient.invalidateQueries({ queryKey: officeKeys.license })}
          onEnabled={(next) => {
            setAsking(false);
            queryClient.setQueryData(officeKeys.license, next);
            setNotice({
              key: "office.about.license.emergency.done",
              values: {
                until:
                  next.emergency.until === null ? "—" : licenseMinute(next.emergency.until, zone),
              },
            });
          }}
        />
      )}
    </section>
  );
}

/** A refusal in words, and whether it says the host's state moved on (the license is read again). */
function emergencyFailure(error: unknown): { text: LicenseText; stale: boolean } {
  if (error instanceof HostError && error.code === "conflict") {
    if (error.details.constraint === "emergency_used") {
      return { text: { key: "office.about.license.emergency.used" }, stale: true };
    }
    if (error.details.constraint === "emergency_not_needed") {
      return { text: { key: "office.about.license.emergency.notNeeded" }, stale: true };
    }
  }
  return { text: { key: errorMessageKey(error) }, stale: false };
}

function EmergencyDialog({
  license,
  zone,
  onClose,
  onEnabled,
  onRefused,
}: {
  license: OfficeLicense;
  zone: string | null;
  onClose: () => void;
  onEnabled: (next: OfficeLicense) => void;
  /** The host refused because the extension was used or is not needed: its state moved on. */
  onRefused: () => void;
}) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<LicenseText | null>(null);
  const enable = useOfficeMutation((api, token, _: null) => api.enableLicenseEmergency(token));
  // The host's time, not this PC's: the office does not compare clocks with the host.
  const until = licenseMinute(
    new Date(Date.parse(license.effectiveAt) + EMERGENCY_MS).toISOString(),
    zone,
  );
  const submit = async () => {
    setFailure(null);
    let next: OfficeLicense;
    try {
      next = await enable.mutateAsync(null);
    } catch (error) {
      const refusal = emergencyFailure(error);
      setFailure(refusal.text);
      if (refusal.stale) onRefused();
      return;
    }
    onEnabled(next);
  };
  return (
    <FormDialog
      title={t("office.about.license.emergency.title")}
      submitLabel={t("office.about.license.emergency.submit")}
      onSubmit={submit}
      onClose={onClose}
      alert={
        failure === null ? null : <Alert tone="error">{t(failure.key, failure.values ?? {})}</Alert>
      }
    >
      <p>{t("office.about.license.emergency.body", { until })}</p>
    </FormDialog>
  );
}
