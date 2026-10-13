import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { PalletSheetSpecV2 } from "@markiro/domain";
import {
  Alert,
  Badge,
  Button,
  Card,
  FileDropZone,
  Input,
  Modal,
  PageHeader,
  RowActions,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type { PalletSheet, PalletSheets } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { byNameThenId, withRecord } from "../records.js";
import { downloadFile } from "../templates/download.js";
import { SheetPreview } from "./SheetPreview.js";
import {
  duplicateSheetNames,
  inUseShiftIds,
  MAX_SHEET_FILE_BYTES,
  missingPresets,
  readSheetSpec,
  sheetExport,
  sheetFailureKey,
  sheetFileName,
  sheetImport,
  sheetLayoutKey,
  sheetNameTaken,
} from "./sheet-list.js";

type Dialog =
  | { kind: "preview"; sheet: PalletSheet; spec: PalletSheetSpecV2 }
  | { kind: "rename"; sheet: PalletSheet }
  | { kind: "delete"; sheet: PalletSheet };

/** A refused write: the `ru.json` key of the reason and, for «in use», the planned shifts that hold the sheet. */
interface Failure {
  key: string;
  shiftIds: string[] | null;
}

/** What the picker offers for a sheet file. */
const SHEET_ACCEPT = "application/json,.json";

/** The planned shifts a refusal lists by name; the rest are counted. */
const SHIFTS_LISTED = 10;

function failureOf(error: unknown): Failure {
  const shiftIds = inUseShiftIds(error);
  // A refusal «in use» that names no shift is still said, without a count.
  const key =
    shiftIds !== null && shiftIds.length === 0
      ? "office.palletSheets.errors.inUseUnknown"
      : sheetFailureKey(error);
  return { key, shiftIds };
}

/**
 * A refused write in words. A sheet that planned shifts hold is refused with
 * their ids: each is a link to the shift's card (no more than ten; the rest
 * are counted), so the refusal says where to change the sheet.
 */
function FailureAlert({ failure }: { failure: Failure | null }) {
  const { t } = useTranslation();
  if (failure === null) return null;
  const ids = failure.shiftIds;
  return (
    <Alert tone="error">
      {t(failure.key, { shifts: ids?.length ?? 0 })}
      {ids !== null && ids.length > 0 && (
        <ul>
          {ids.slice(0, SHIFTS_LISTED).map((id) => (
            <li key={id}>
              <Link to={`/shifts/${id}`}>
                {t("office.palletSheets.errors.shiftLink", { id: id.slice(0, 8) })}
              </Link>
            </li>
          ))}
          {ids.length > SHIFTS_LISTED && (
            <li>
              {t("office.palletSheets.errors.shiftsMore", { more: ids.length - SHIFTS_LISTED })}
            </li>
          )}
        </ul>
      )}
    </Alert>
  );
}

/**
 * A4 pallet sheets (plan А4, pilot spec §29), the «Листы А4» tab of
 * «Шаблоны»: the stock sheets, a sheet from a JSON file, rename, on and off, a
 * JSON copy and a preview. Which sheet is the default — the organization's, a
 * category's, a product's — is chosen on the «По умолчанию» tab beside the
 * pallet labels (beta feedback); the list marks the organization's. The
 * layout itself is edited as JSON outside (decision А4-11): «Скачать JSON»,
 * change, «Загрузить JSON» — always a new sheet. Both office roles change
 * sheets (`editCatalog`); every write's answer goes into the cached list. The
 * host does not keep names unique, so the page says when two sheets share
 * one. One write runs at a time; a refused delete names the planned shifts.
 */
export function PalletSheetsPage() {
  const { t } = useTranslation();
  const canEdit = useCan("editCatalog");
  const queryClient = useQueryClient();
  const sheets = useOfficeQuery(officeKeys.palletSheets, (api, token) =>
    api.listPalletSheets(token),
  );
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  // Set at once, so a second click before the buttons are off is dropped.
  const inFlight = useRef(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const focusNotice = useRef(false);

  const create = useOfficeMutation(
    (api, token, body: { name: string; presetKey?: string; spec: Record<string, unknown> }) =>
      api.createPalletSheet(token, body),
  );
  const update = useOfficeMutation(
    (api, token, v: { sheet: PalletSheet; name?: string; enabled?: boolean }) =>
      api.updatePalletSheet(token, v.sheet.id, {
        ...(v.name === undefined ? {} : { name: v.name }),
        ...(v.enabled === undefined ? {} : { enabled: v.enabled }),
        expectedRevision: v.sheet.revision,
      }),
  );
  const remove = useOfficeMutation((api, token, id: string) => api.deletePalletSheet(token, id));

  // After a delete the row (and the button that opened its dialog) is gone: the
  // notice takes the focus, once the dialog has returned it.
  useEffect(() => {
    if (focusNotice.current && dialog === null && noticeRef.current !== null) {
      focusNotice.current = false;
      noticeRef.current.focus();
    }
  });

  const change = (apply: (list: PalletSheets) => PalletSheets) =>
    queryClient.setQueryData<PalletSheets>(officeKeys.palletSheets, (list) =>
      list === undefined ? list : apply(list),
    );
  const keepSheet = (sheet: PalletSheet) =>
    change((list) => ({ ...list, sheets: withRecord(list.sheets, sheet) }));

  /**
   * One write at a time. A refusal is shown and the list is read again (it may
   * be out of date); the answer of a write has already gone into the cache.
   */
  const run = async (work: () => Promise<unknown>, done: string): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
      return true;
    } catch (error) {
      setFailure(failureOf(error));
      void queryClient.invalidateQueries({ queryKey: officeKeys.palletSheets });
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const open = (next: Dialog) => {
    setFailure(null);
    setNotice(null);
    setDialog(next);
  };

  const addStock = (list: readonly PalletSheet[]) =>
    run(async () => {
      for (const preset of missingPresets(list)) {
        keepSheet(
          await create.mutateAsync({ name: preset.name, presetKey: preset.key, spec: preset.spec }),
        );
      }
    }, t("office.palletSheets.stockAdded"));

  const importFile = async (file: File) => {
    setNotice(null);
    setFailure(null);
    if (file.size > MAX_SHEET_FILE_BYTES) {
      setFailure({ key: "office.palletSheets.errors.fileTooLarge", shiftIds: null });
      return;
    }
    let parsed: ReturnType<typeof sheetImport>;
    try {
      parsed = sheetImport(await file.text());
    } catch {
      setFailure({ key: "office.palletSheets.errors.importInvalid", shiftIds: null });
      return;
    }
    await run(
      async () => keepSheet(await create.mutateAsync({ name: parsed.name, spec: parsed.spec })),
      t("office.palletSheets.imported", { name: parsed.name }),
    );
  };

  const download = (sheet: PalletSheet) => {
    setNotice(null);
    setFailure(null);
    try {
      downloadFile(
        new Blob([sheetExport(sheet)], { type: "application/json" }),
        sheetFileName(sheet.name),
      );
    } catch {
      setFailure({ key: "office.palletSheets.errors.exportFailed", shiftIds: null });
    }
  };

  if (sheets.isPending) return <PageLoading />;
  if (sheets.isError) {
    return <LoadError error={sheets.error} onRetry={() => void sheets.refetch()} />;
  }
  const list = sheets.data;
  const rows = [...list.sheets].sort(byNameThenId);
  const duplicates = duplicateSheetNames(list.sheets);
  const sharesName = (sheet: PalletSheet) => sheetNameTaken(list.sheets, sheet.name, sheet.id);

  const columns: TableColumn<PalletSheet>[] = [
    {
      key: "name",
      title: t("office.palletSheets.table.name"),
      wrap: true,
      minWidth: 200,
      render: (sheet) => (
        <>
          {sheet.name}{" "}
          {list.defaultId === sheet.id && (
            <Badge tone="teal">{t("office.palletSheets.default")}</Badge>
          )}{" "}
          {sheet.presetKey !== null && <Badge tone="steel">{t("office.palletSheets.stock")}</Badge>}{" "}
          {sharesName(sheet) && (
            <StatusChip phase="duplicate" label={t("office.palletSheets.sameName")} />
          )}
        </>
      ),
    },
    {
      key: "layout",
      title: t("office.palletSheets.table.layout"),
      render: (sheet) => {
        const layout = sheetLayoutKey(sheet.spec);
        return layout === null
          ? t("office.palletSheets.layouts.unreadable")
          : t(`office.palletSheets.layouts.${layout}`);
      },
    },
    {
      key: "state",
      title: t("office.palletSheets.table.state"),
      render: (sheet) => (
        <StatusChip
          phase={sheet.enabled ? "active" : "retired"}
          label={t(sheet.enabled ? "office.palletSheets.enabled" : "office.palletSheets.disabled")}
        />
      ),
    },
    {
      key: "actions",
      title: t("office.palletSheets.table.actions"),
      render: (sheet) => {
        const spec = readSheetSpec(sheet.spec);
        return (
          <RowActions>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.palletSheets.previewNamed", { name: sheet.name })}
              disabled={spec === null}
              onClick={() => {
                if (spec !== null) open({ kind: "preview", sheet, spec });
              }}
            >
              {t("office.palletSheets.preview")}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.palletSheets.exportNamed", { name: sheet.name })}
              disabled={spec === null}
              onClick={() => download(sheet)}
            >
              {t("office.palletSheets.export")}
            </Button>
            {canEdit && (
              <>
                <Button
                  variant="secondary"
                  size="compact"
                  aria-label={t(
                    sheet.enabled
                      ? "office.palletSheets.disableNamed"
                      : "office.palletSheets.enableNamed",
                    { name: sheet.name },
                  )}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      async () =>
                        keepSheet(await update.mutateAsync({ sheet, enabled: !sheet.enabled })),
                      t(
                        sheet.enabled
                          ? "office.palletSheets.disabledNotice"
                          : "office.palletSheets.enabledNotice",
                        { name: sheet.name },
                      ),
                    )
                  }
                >
                  {t(sheet.enabled ? "office.palletSheets.disable" : "office.palletSheets.enable")}
                </Button>
                <Button
                  variant="secondary"
                  size="compact"
                  aria-label={t("office.palletSheets.renameNamed", { name: sheet.name })}
                  disabled={busy}
                  onClick={() => open({ kind: "rename", sheet })}
                >
                  {t("office.palletSheets.rename")}
                </Button>
                <Button
                  variant="destructive-outline"
                  size="compact"
                  aria-label={t("office.palletSheets.deleteNamed", { name: sheet.name })}
                  disabled={busy}
                  onClick={() => open({ kind: "delete", sheet })}
                >
                  {t("office.palletSheets.delete")}
                </Button>
              </>
            )}
          </RowActions>
        );
      },
    },
  ];

  const stockMissing = missingPresets(list.sheets).length > 0;
  return (
    <>
      <PageHeader
        title={t("office.palletSheets.title")}
        {...(canEdit
          ? {
              actions: (
                <>
                  {stockMissing && (
                    <Button disabled={busy} onClick={() => void addStock(list.sheets)}>
                      {t("office.palletSheets.addStock")}
                    </Button>
                  )}
                  <FileDropZone
                    compact
                    label={t("office.palletSheets.import")}
                    accept={SHEET_ACCEPT}
                    busy={busy}
                    onFile={(file) => void importFile(file)}
                    onRejected={() => {
                      setNotice(null);
                      setFailure({
                        key: "office.palletSheets.errors.importInvalid",
                        shiftIds: null,
                      });
                    }}
                  />
                </>
              ),
            }
          : {})}
      />
      <div ref={noticeRef} tabIndex={-1}>
        {notice !== null && <Alert tone="ok">{notice}</Alert>}
        {dialog === null && <FailureAlert failure={failure} />}
      </div>
      {duplicates.length > 0 && (
        <Alert tone="warn">
          {t("office.palletSheets.duplicates", { names: duplicates.join(", ") })}
        </Alert>
      )}
      <Card>
        <p>{t("office.palletSheets.intro")}</p>
        <Table
          columns={columns}
          rows={rows}
          getRowKey={(sheet) => sheet.id}
          empty={t("office.palletSheets.empty")}
          scrollLabel={t("office.palletSheets.title")}
        />
      </Card>
      {dialog?.kind === "preview" && (
        <Modal
          open
          title={dialog.sheet.name}
          onClose={() => setDialog(null)}
          closeLabel={t("office.common.close")}
          width={720}
        >
          <SheetPreview spec={dialog.spec} label={dialog.sheet.name} />
        </Modal>
      )}
      {canEdit && dialog?.kind === "rename" && (
        <RenameSheetDialog
          sheet={dialog.sheet}
          sheets={list.sheets}
          failure={failure}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const done = await run(
              async () => keepSheet(await update.mutateAsync({ sheet: dialog.sheet, name })),
              t("office.palletSheets.renamed", { name }),
            );
            if (done) setDialog(null);
          }}
        />
      )}
      {canEdit && dialog?.kind === "delete" && (
        <FormDialog
          title={t("office.palletSheets.deleteTitle", { name: dialog.sheet.name })}
          submitLabel={t("office.palletSheets.delete")}
          submitVariant="destructive"
          onClose={() => setDialog(null)}
          alert={<FailureAlert failure={failure} />}
          onSubmit={async () => {
            const done = await run(
              async () => {
                await remove.mutateAsync(dialog.sheet.id);
                change((current) => ({
                  ...current,
                  sheets: current.sheets.filter((each) => each.id !== dialog.sheet.id),
                }));
              },
              t("office.palletSheets.deleted", { name: dialog.sheet.name }),
            );
            if (done) {
              focusNotice.current = true;
              setDialog(null);
            }
          }}
        >
          <p>{t("office.palletSheets.deleteText")}</p>
        </FormDialog>
      )}
    </>
  );
}

function RenameSheetDialog({
  sheet,
  sheets,
  failure,
  onClose,
  onSubmit,
}: {
  sheet: PalletSheet;
  sheets: readonly PalletSheet[];
  failure: Failure | null;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(sheet.name);
  const trimmed = name.trim();
  return (
    <FormDialog
      title={t("office.palletSheets.renameTitle")}
      submitLabel={t("office.common.save")}
      submitDisabled={trimmed === "" || trimmed === sheet.name}
      onClose={onClose}
      alert={<FailureAlert failure={failure} />}
      onSubmit={() => onSubmit(trimmed)}
    >
      <Input
        label={t("office.palletSheets.table.name")}
        value={name}
        maxLength={200}
        {...(sheetNameTaken(sheets, trimmed, sheet.id)
          ? { hint: t("office.palletSheets.nameTaken") }
          : {})}
        onChange={(event) => setName(event.target.value)}
      />
    </FormDialog>
  );
}
