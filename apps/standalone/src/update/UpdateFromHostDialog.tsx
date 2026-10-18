import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Modal } from "@markiro/ui";

import { useUpdateShell } from "../office/info/update-context.js";
import type { VerifiedReport } from "../office/info/update-shell.js";
import { refusalText, updateErrorText } from "../office/info/UpdateSection.js";
import type { HostUpdateOffer } from "./host-offer.js";
import { UpdateError } from "./updates-api.js";
import { useUpdates } from "./updates-context.js";

type Step =
  | { step: "idle" }
  | { step: "downloading"; received: number; total: number }
  | { step: "checking" }
  | { step: "ready"; report: VerifiedReport }
  | { step: "starting"; report: VerifiedReport }
  | { step: "failed"; message: string; report: VerifiedReport | null };

export interface UpdateFromHostDialogProps {
  open: boolean;
  offer: Extract<HostUpdateOffer, { kind: "available" }>;
  onClose: () => void;
  /**
   * Starts the checked package. In the office: plan ОБН-2's `runUpdate`
   * with the source `host` (a copy first on the host's PC, the
   * `app.update.start` row, the launch). Where no office opens (the
   * version screen, a station the host refuses): the shell's
   * `update_install` alone — Windows' administrator prompt is the
   * permission (ЛО16).
   */
  start: (report: VerifiedReport) => Promise<void>;
  /**
   * `floor` where the dialog opens on the station's sign-in screen: every
   * control is a floor-sized touch target. The modal's small × is left out
   * there (no `onClose` to the modal); «Отмена» closes it.
   */
  size?: "floor";
}

/**
 * «Обновить с хоста» (spec §10.11.4–10.11.5): the notes as text, «Скачать с
 * хоста» with its progress, then the shell checks the downloaded package
 * again (plan ОБН-2's `update_verify`: the signature, the SHA-256 through a
 * handle nobody else may write, the host on the package's very version) and
 * only then «Установить обновление». Nothing starts on its own; a silent
 * host is asked about first (ЛО12); a refusal leaves no button to install.
 */
export function UpdateFromHostDialog({
  open,
  offer,
  onClose,
  start,
  size,
}: UpdateFromHostDialogProps) {
  const { t } = useTranslation();
  const updates = useUpdates();
  const shell = useUpdateShell();
  const [state, setState] = useState<Step>({ step: "idle" });
  const failure = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.step === "failed") failure.current?.focus();
  }, [state.step]);
  const busy =
    state.step === "downloading" || state.step === "checking" || state.step === "starting";
  // A package checked or refused for one opening or one version is not shown
  // for the next: start over once the dialog is shut or the offer moves on.
  const version = offer.manifest.version;
  const [seen, setSeen] = useState({ open, version });
  if (seen.open !== open || seen.version !== version) {
    setSeen({ open, version });
    if (!busy && (!open || seen.version !== version)) setState({ step: "idle" });
  }

  const download = async () => {
    setState({ step: "downloading", received: 0, total: offer.manifest.sizeBytes });
    let manifestPath: string;
    try {
      const fetched = await updates.fetch(({ received, total }) =>
        setState({ step: "downloading", received, total }),
      );
      manifestPath = fetched.manifestPath;
    } catch (error) {
      const code = error instanceof UpdateError ? error.code : "refused";
      setState({ step: "failed", message: t(`update.errors.${code}`), report: null });
      return;
    }
    setState({ step: "checking" });
    try {
      const report = await shell.verify(manifestPath);
      const refused = refusalText(t, report);
      setState(
        refused === null
          ? { step: "ready", report }
          : { step: "failed", message: refused, report: null },
      );
    } catch (error) {
      setState({ step: "failed", message: updateErrorText(t, error), report: null });
    }
  };

  const install = async (report: VerifiedReport) => {
    setState({ step: "starting", report });
    try {
      await start(report);
      setState({ step: "ready", report });
      onClose();
    } catch (error) {
      setState({ step: "failed", message: updateErrorText(t, error), report });
    }
  };

  const percent =
    state.step === "downloading" && state.total > 0
      ? Math.floor((state.received * 100) / state.total)
      : 0;
  // The checked package, when there is one to start (again, after a failed start).
  const report = state.step === "ready" || state.step === "failed" ? state.report : null;
  const silent = report?.confirmations.includes("host_unreachable") ?? false;

  const floor = size === "floor" ? ({ size: "floor" } as const) : {};
  let action: ReactNode = null;
  if (state.step === "idle" || (state.step === "failed" && state.report === null)) {
    action = (
      <Button {...floor} onClick={() => void download()}>
        {t("update.dialog.download")}
      </Button>
    );
  } else if (state.step === "downloading" || state.step === "checking") {
    action = (
      <Button {...floor} loading>
        {t("update.dialog.download")}
      </Button>
    );
  } else if (state.step === "starting") {
    action = (
      <Button {...floor} loading>
        {t("update.dialog.install")}
      </Button>
    );
  } else if (report !== null) {
    action = silent ? (
      <Button {...floor} variant="destructive" onClick={() => void install(report)}>
        {t("update.dialog.installAnyway")}
      </Button>
    ) : (
      <Button {...floor} onClick={() => void install(report)}>
        {t("update.dialog.install")}
      </Button>
    );
  }

  return (
    <Modal
      open={open}
      title={t("update.dialog.title", { version: offer.manifest.version })}
      closeLabel={t("update.dialog.close")}
      {...(busy || size === "floor" ? {} : { onClose })}
      footer={
        <>
          <Button {...floor} variant="secondary" disabled={busy} onClick={onClose}>
            {t("update.dialog.cancel")}
          </Button>
          {action}
        </>
      }
    >
      {offer.manifest.channel === "beta" && <Alert tone="info">{t("update.dialog.beta")}</Alert>}
      <p>{t("update.dialog.from", { host: offer.hostVersion })}</p>
      <ul className="update-notes">
        {offer.manifest.notes.map((note, index) => (
          // Notes are plain text and may repeat; their order is their identity.
          <li key={`${index}:${note}`}>{note}</li>
        ))}
      </ul>
      <p className="office-note">{t("update.dialog.uac")}</p>
      {state.step === "downloading" && (
        <p>
          <progress
            max={100}
            value={percent}
            aria-valuenow={percent}
            aria-label={t("update.dialog.progressLabel")}
          />{" "}
          {t("update.dialog.progress", { percent })}
        </p>
      )}
      <div aria-live="polite">
        {state.step === "downloading" && (
          <p className="office-note">{t("update.dialog.downloading")}</p>
        )}
        {state.step === "checking" && <p>{t("update.dialog.checking")}</p>}
        {state.step === "ready" && !silent && <p>{t("update.dialog.checked")}</p>}
      </div>
      {silent && report !== null && <Alert tone="warn">{t("update.dialog.hostSilent")}</Alert>}
      {state.step === "failed" && (
        <div ref={failure} tabIndex={-1}>
          <Alert tone="error">{state.message}</Alert>
        </div>
      )}
    </Modal>
  );
}
