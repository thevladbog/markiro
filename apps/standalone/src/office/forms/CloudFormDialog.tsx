import {
  renderBoxReportHtml,
  renderPalletPlacardHtml,
  renderPalletReportHtml,
  renderShiftPlacardsHtml,
  type PlacardFormat,
} from "@markiro/domain";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Modal, RadioGroup } from "@markiro/ui";
import type { HostApi } from "../../host/api.js";
import { requireHistoryTimeZone } from "../import/history-time-zone.js";
import { historyFailure } from "../import/history-errors.js";
import { useOfficeSession } from "../office-session.js";
import { useOfficeFiles } from "../exports/office-files-context.js";
import { useRefreshStoredFiles } from "../exports/use-refresh-files.js";
import { cloudPalletPlacardData, cloudPalletReportData } from "./cloud-form-data.js";
import { boxReportData } from "./form-data.js";
import { usePrintForm } from "./form-printer-context.js";
import { formFolder, openInBrowser, paint } from "./print-form.js";
import type { RenderedForm } from "./render-form.js";
import { storeForm } from "./store-form.js";

export type CloudFormTarget = {
  kind: "box" | "pallet" | "placard" | "placards";
  id: string;
  label: string;
};
async function draw(
  api: HostApi,
  token: string,
  target: CloudFormTarget,
  paper: PlacardFormat,
): Promise<RenderedForm | null> {
  if (target.kind === "box") {
    const rows = await api.getCloudBoxReportRows(token, target.id);
    return {
      kind: "box",
      html: renderBoxReportHtml(
        boxReportData(rows),
        requireHistoryTimeZone(rows.organization.timeZone),
      ),
      fileName: `Состав короба ${target.label}.html`,
    };
  }
  const all =
    target.kind === "placards"
      ? await api.listCloudShiftPallets(token, target.id)
      : [await api.getCloudPallet(token, target.id)];
  for (const source of all) requireHistoryTimeZone(source.organization.timeZone);
  const rows = all[0];
  if (target.kind === "pallet" && rows !== undefined)
    return {
      kind: "pallet",
      html: renderPalletReportHtml(cloudPalletReportData(rows), rows.organization.timeZone),
      fileName: `Состав паллеты ${target.label}.html`,
    };
  const data = all.map(cloudPalletPlacardData);
  if (data.length === 0 || data.some((row) => row === null)) return null;
  const valid = data.filter((row) => row !== null);
  if (target.kind === "placards")
    return {
      kind: "placards",
      html: renderShiftPlacardsHtml(valid, paper, target.label),
      fileName: `Ярлыки паллет ${target.label} ${paper.toUpperCase()}.html`,
    };
  const placard = valid[0];
  return placard === undefined
    ? null
    : {
        kind: "placard",
        html: renderPalletPlacardHtml(placard, paper),
        fileName: `Ярлык паллеты ${target.label} ${paper.toUpperCase()}.html`,
      };
}
/** Frozen sources, null original logo; the real domain forms and standard file/print controls. */
export function CloudFormDialog({
  target,
  timeZone,
  onClose,
}: {
  target: CloudFormTarget;
  timeZone: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const files = useOfficeFiles();
  const print = usePrintForm();
  const refresh = useRefreshStoredFiles();
  const [paper, setPaper] = useState<PlacardFormat>("a4");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const press = async (how: "print" | "open") => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      requireHistoryTimeZone(timeZone);
      await paint();
      const form = await session.call((token) => draw(session.api, token, target, paper));
      if (!alive.current) return;
      if (form === null) {
        setFailure(t(`office.forms.refused.${target.kind}`));
        return;
      }
      const warning = await storeForm(session, form, {
        type: target.kind === "box" ? "box" : target.kind === "placards" ? "shift" : "pallet",
        id: target.id,
      });
      refresh();
      if (warning !== null)
        setFailure(t("office.storedFiles.hostCopyFailed", { reason: t(warning) }));
      if (how === "print") print(form.html);
      else {
        const saved = await openInBrowser(
          files,
          form,
          formFolder(target.label, form.kind, new Date().toISOString(), timeZone),
        );
        setNotice(t("office.forms.opened", { path: saved.path }));
      }
    } catch (error) {
      if (alive.current) setFailure(historyFailure(t, error));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={t(`office.forms.titles.${target.kind}`, { label: target.label, number: target.label })}
      onClose={() => {
        if (!lock.current) onClose();
      }}
      closeLabel={t("office.common.close")}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t("office.common.close")}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void press("open")}>
            {t("office.forms.openInBrowser")}
          </Button>
          <Button disabled={busy} onClick={() => void press("print")}>
            {t("office.forms.print")}
          </Button>
        </>
      }
    >
      {(target.kind === "placard" || target.kind === "placards") && (
        <RadioGroup
          label={t("office.forms.paper")}
          name="cloud-paper"
          value={paper}
          disabled={busy}
          options={[
            { value: "a4", label: "A4" },
            { value: "a5", label: "A5" },
          ]}
          onValueChange={(value) => setPaper(value === "a5" ? "a5" : "a4")}
        />
      )}
      <p>{t("office.cloudShifts.frozenForms")}</p>
      {busy && <p role="status">{t("office.forms.drawing")}</p>}
      {failure && <Alert tone="error">{failure}</Alert>}
      {notice && <Alert tone="ok">{notice}</Alert>}
    </Modal>
  );
}
