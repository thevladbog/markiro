import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, SidePanel, RadioGroup } from "@markiro/ui";
import { ShiftExportDomainError, type PlacardFormat } from "@markiro/domain";
import { errorMessageKey } from "../../host/errors.js";
import { readFormLogo } from "../branding.js";
import { exportFolder } from "../exports/export-checks.js";
import { useOfficeFiles } from "../exports/office-files-context.js";
import { OfficeFilesError } from "../exports/office-files.js";
import { storeExportFiles } from "../exports/stored-files.js";
import { useRefreshStoredFiles } from "../exports/use-refresh-files.js";
import { usePrintForm } from "../forms/form-printer-context.js";
import { formFolder, openInBrowser, paint } from "../forms/print-form.js";
import { storeForm } from "../forms/store-form.js";
import { useOfficeSession } from "../office-session.js";
import { warehousePalletForm, warehousePalletXml } from "./warehouse-pallet-documents.js";

export function WarehousePalletDocumentDialog({
  id,
  label,
  kind,
  onClose,
}: {
  id: string;
  label: string;
  kind: "pallet" | "placard" | "xml";
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const cache = useQueryClient();
  const files = useOfficeFiles();
  const print = usePrintForm();
  const refresh = useRefreshStoredFiles();
  const [paper, setPaper] = useState<PlacardFormat>("a4");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  async function press(how: "print" | "open" | "xml") {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setWarning(null);
    setSaved(null);
    let stage: "read" | "render" | "files" = "read";
    try {
      const pallet = await session.call((token) => session.api.getWarehousePallet(token, id));
      stage = "render";
      await paint();
      if (how === "xml") {
        const batch = crypto.randomUUID();
        const now = new Date().toISOString();
        const part = warehousePalletXml(pallet, batch, now);
        const copy = await storeExportFiles(session, {
          kind: "pallet_export",
          targetType: "warehouse_pallet",
          targetId: id,
          batchId: batch,
          formatId: "pallet_xml_gismt_aggregation",
          formatVersion: 1,
          parts: [{ partNo: 1, name: part.filename, bytes: part.bytes }],
        });
        refresh();
        if (!copy.ok) setWarning(t(copy.messageKey));
        stage = "files";
        const folder = await files.save(
          exportFolder(
            pallet.sscc ?? id,
            "pallet_xml_gismt_aggregation",
            now,
            pallet.organization.timeZone,
          ),
          [{ name: part.filename, bytes: part.bytes }],
        );
        setSaved(folder.path);
        return;
      }
      if (kind === "xml") return;
      if (kind === "placard" && (pallet.sscc === null || pallet.closedAt === null)) {
        setError(t("office.forms.refused.placard"));
        return;
      }
      const logo = await readFormLogo(cache, session.api, session.call);
      const form = warehousePalletForm(pallet, kind, paper, logo);
      const copy = await storeForm(session, form, { type: "warehouse_pallet", id });
      refresh();
      if (copy !== null) setWarning(t(copy));
      if (how === "print") {
        await print(form.html);
        if (copy === null) onClose();
        return;
      }
      stage = "files";
      const folder = await openInBrowser(
        files,
        form,
        formFolder(pallet.sscc ?? id, kind, new Date().toISOString(), pallet.organization.timeZone),
      );
      setSaved(folder.path);
      if (copy === null) onClose();
    } catch (failure) {
      if (failure instanceof Error && failure.message === "DEMO_SHIFT")
        setError(t("office.demo.exportsNote"));
      else if (failure instanceof Error && failure.message === "PALLET_DISASSEMBLED")
        setError(t("office.warehouseCard.xmlDisassembled"));
      else if (failure instanceof Error && failure.message === "PALLET_NOT_CLOSED")
        setError(t("office.forms.refused.placard"));
      else if (failure instanceof ShiftExportDomainError)
        setError(
          t(
            failure.code === "INVALID_DOCUMENT_METADATA"
              ? "office.warehouseCard.xmlMetadata"
              : `office.exports.failures.${failure.code}`,
            { defaultValue: t("office.exports.failures.GENERATION_FAILED") },
          ),
        );
      else if (failure instanceof OfficeFilesError)
        setError(t(`office.forms.files.${failure.code}`));
      else
        setError(
          t(
            stage === "read"
              ? errorMessageKey(failure)
              : stage === "files"
                ? "office.forms.files.storage"
                : "office.forms.printFailed",
          ),
        );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const title =
    kind === "xml"
      ? t("office.exports.palletTitle", { sscc: label })
      : t(`office.forms.titles.${kind}`, { label });
  return (
    <SidePanel
      open
      title={title}
      size="standard"
      busy={busy}
      onClose={() => {
        if (!running.current) onClose();
      }}
      closeLabel={t("office.common.close")}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t("office.common.close")}
          </Button>
          {kind === "xml" ? (
            <Button loading={busy} onClick={() => void press("xml")}>
              {t("office.warehouseCard.generateXml")}
            </Button>
          ) : (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => void press("open")}>
                {t("office.forms.openInBrowser")}
              </Button>
              <Button loading={busy} onClick={() => void press("print")}>
                {t("office.forms.print")}
              </Button>
            </>
          )}
        </>
      }
    >
      {kind === "placard" && (
        <RadioGroup
          label={t("office.forms.paper")}
          name="warehouse-paper"
          value={paper}
          disabled={busy}
          onValueChange={(value) => setPaper(value === "a5" ? "a5" : "a4")}
          options={[
            { value: "a4", label: "A4" },
            { value: "a5", label: "A5" },
          ]}
        />
      )}
      <p className="office-note">
        {t(kind === "xml" ? "office.warehouseCard.xmlHint" : "office.forms.hint")}
      </p>
      {busy && <p role="status">{t("office.forms.drawing")}</p>}
      {error !== null && <Alert tone="error">{error}</Alert>}
      {warning !== null && (
        <Alert tone="warn">{t("office.storedFiles.hostCopyFailed", { reason: warning })}</Alert>
      )}
      {saved !== null && <Alert tone="ok">{t("office.forms.opened", { path: saved })}</Alert>}
    </SidePanel>
  );
}
