import { lazy, Suspense, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { Alert, Button, Card, DefinitionGrid, PageHeader, Select, Table } from "@markiro/ui";
import type { CloudShiftQuery } from "../../host/api.js";
import type { CloudPalletRows } from "../../host/cloud-history-read.js";
import type { ShiftExportRecord } from "../../host/protocol.js";
import { shiftExportRecord } from "../../host/requests.js";
import { isSupportedHistoryTimeZone, requireHistoryTimeZone } from "../import/history-time-zone.js";
import { historyFailure } from "../import/history-errors.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { PageLoading } from "../page-state.js";
import { CardFiles } from "../exports/CardFiles.js";
import { useOfficeFiles } from "../exports/office-files-context.js";
import { useRefreshStoredFiles } from "../exports/use-refresh-files.js";
import { storeExportFiles } from "../exports/stored-files.js";
import { exportFolder } from "../exports/export-checks.js";
import { runCloudPalletExport } from "../exports/run-export.js";
import { CloudFormDialog, type CloudFormTarget } from "../forms/CloudFormDialog.js";
import { instantFormat } from "../codes/CodeCard.js";
import { civilDateLabel } from "./shift-list.js";
import { DateRange, ListCard, ListFilters } from "../list/ListCard.js";
import { ListEmpty, ListNothing, ListSkeleton } from "../list/ListStates.js";
import { tableFloorStyle } from "../list/fill-model.js";

const ExportDialog = lazy(() =>
  import("../exports/ExportDialog.js").then((module) => ({ default: module.ExportDialog })),
);

function UnsupportedTimeZone() {
  const { t } = useTranslation();
  return (
    <Alert tone="error">{t("office.cloudHistory.errors.history_time_zone_unsupported")}</Alert>
  );
}

const cloudDate = (date: string | null) => (date === null ? "—" : civilDateLabel(date));

export function ShiftSourceLinks({ cloud = false }: { cloud?: boolean }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("office.cloudShifts.source")} className="office-source-nav">
      <Link aria-current={!cloud ? "page" : undefined} to="/shifts">
        {t("office.cloudShifts.native")}
      </Link>
      <Link aria-current={cloud ? "page" : undefined} to="/cloud-shifts">
        {t("office.cloudShifts.cloud")}
      </Link>
    </nav>
  );
}
export function CloudShifts() {
  const { t } = useTranslation();
  const [query, setQuery] = useState<CloudShiftQuery>({ page: 1 });
  const result = useOfficeQuery(officeKeys.cloudShiftList(query), (api, token) =>
    api.listCloudShifts(token, query),
  );
  const filtered = Boolean(query.from || query.to || query.mode);
  const reset = () => setQuery({ page: 1 });
  return (
    <>
      <PageHeader
        title={t("office.shifts.title")}
        description={t("office.cloudShifts.description")}
      />
      <ShiftSourceLinks cloud />
      <ListCard>
        <ListFilters label={t("office.shifts.filters")} onReset={filtered ? reset : undefined}>
          <DateRange
            label={t("office.shifts.period.productionLabel")}
            fromLabel={t("office.shifts.period.from")}
            toLabel={t("office.shifts.period.to")}
            from={query.from ?? ""}
            to={query.to ?? ""}
            onFrom={(from) => setQuery({ ...query, from, page: 1 })}
            onTo={(to) => setQuery({ ...query, to, page: 1 })}
          />
          <Select
            label={t("office.cloudShifts.mode")}
            value={query.mode ?? ""}
            options={[
              { value: "", label: t("office.cloudShifts.allModes") },
              { value: "aggregation", label: t("office.shifts.modes.aggregation") },
              { value: "validation", label: t("office.shifts.modes.validation") },
            ]}
            onValueChange={(value) =>
              setQuery(({ mode: _mode, ...old }) =>
                value === "aggregation" || value === "validation"
                  ? { ...old, mode: value, page: 1 }
                  : { ...old, page: 1 },
              )
            }
          />
        </ListFilters>
        {result.isPending ? (
          <ListSkeleton />
        ) : result.isError ? (
          <div className="office-list-state">
            <CloudReadError error={result.error} retry={() => void result.refetch()} />
          </div>
        ) : (
          <div className="office-paged">
            <Table
              fill
              style={tableFloorStyle(result.data.items.length)}
              scrollLabel={t("office.cloudShifts.cloud")}
              columns={[
                {
                  key: "number",
                  title: t("office.shifts.table.number"),
                  render: (row) => (
                    <Link to={`/cloud-shifts/${row.shift.id}`}>{row.shift.number}</Link>
                  ),
                },
                {
                  key: "product",
                  title: t("office.shifts.table.productAndPrint"),
                  wrap: true,
                  minWidth: 220,
                  render: (row) => row.shift.productName ?? t("office.common.none"),
                },
                {
                  key: "date",
                  title: t("office.shifts.table.productionDate"),
                  render: (row) => cloudDate(row.shift.productionDate),
                },
                {
                  key: "line",
                  title: t("office.shifts.table.line"),
                  wrap: true,
                  minWidth: 110,
                  render: (row) => row.shift.lineName ?? t("office.common.none"),
                },
                {
                  key: "mode",
                  title: t("office.cloudShifts.mode"),
                  render: (row) => t(`office.shifts.modes.${row.shift.mode}`),
                },
              ]}
              rows={result.data.items}
              getRowKey={(row) => row.shift.id}
              empty={
                filtered ? (
                  <ListNothing onReset={reset} />
                ) : (
                  <ListEmpty icon="calendarCheck" title={t("office.cloudShifts.empty")} />
                )
              }
            />
            {result.data.total > 0 && (
              <nav className="office-pagination" aria-label={t("office.shifts.pager")}>
                <span className="office-pagination__range">
                  {t("office.cloudShifts.page", {
                    page: result.data.page,
                    total: result.data.pageCount,
                    count: result.data.total,
                  })}
                </span>
                <div className="office-pagination__pages">
                  <Button
                    variant="secondary"
                    disabled={result.data.page <= 1}
                    onClick={() => setQuery({ ...query, page: result.data.page - 1 })}
                  >
                    {t("office.cloudShifts.previous")}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={result.data.page >= result.data.pageCount}
                    onClick={() => setQuery({ ...query, page: result.data.page + 1 })}
                  >
                    {t("office.cloudShifts.next")}
                  </Button>
                </div>
              </nav>
            )}
          </div>
        )}
      </ListCard>
    </>
  );
}
function CloudReadError({ error, retry }: { error: unknown; retry: () => void }) {
  const { t } = useTranslation();
  return (
    <Alert
      tone="error"
      action={
        <Button variant="secondary" onClick={retry}>
          {t("office.common.retry")}
        </Button>
      }
    >
      {historyFailure(t, error)}
    </Alert>
  );
}
function SavedFiles({
  type,
  id,
  label,
  zone,
}: {
  type: "shift" | "box" | "pallet";
  id: string;
  label: string;
  zone: string;
}) {
  return (
    <CardFiles
      targetType={type}
      targetId={id}
      label={label}
      timeZone={zone}
      at={instantFormat(zone)}
    />
  );
}
export function CloudShiftPage() {
  const { id = "" } = useParams();
  const { t } = useTranslation();
  const card = useOfficeQuery(officeKeys.cloudShift(id), (api, token) =>
    api.getCloudShift(token, id),
  );
  const boxes = useOfficeQuery(officeKeys.cloudBoxes(id), (api, token) =>
    api.listCloudShiftBoxes(token, id),
  );
  const pallets = useOfficeQuery(officeKeys.cloudPallets(id), (api, token) =>
    api.listCloudShiftPallets(token, id),
  );
  const [exporting, setExport] = useState(false);
  const [form, setForm] = useState<CloudFormTarget | null>(null);
  if (card.isPending) return <PageLoading />;
  if (card.isError) return <CloudReadError error={card.error} retry={() => void card.refetch()} />;
  const zone = card.data.sourceTimeZone;
  if (!isSupportedHistoryTimeZone(zone)) return <UnsupportedTimeZone />;
  const at = instantFormat(zone);
  const { shift } = card.data;
  return (
    <>
      <PageHeader
        title={t("office.cloudShifts.card", { number: shift.number })}
        description={t("office.cloudShifts.description")}
      />
      <ShiftSourceLinks cloud />
      <Card>
        <DefinitionGrid
          items={[
            {
              id: "product",
              term: t("office.shifts.table.productAndPrint"),
              description: shift.productName ?? t("office.common.none"),
            },
            {
              id: "date",
              term: t("office.shifts.table.productionDate"),
              description: cloudDate(shift.productionDate),
            },
            {
              id: "planned",
              term: t("office.shifts.table.plannedDate"),
              description: cloudDate(shift.plannedDate),
            },
            {
              id: "line",
              term: t("office.shifts.table.line"),
              description: shift.lineName ?? t("office.common.none"),
            },
            { id: "gtin", term: "GTIN", description: shift.gtin14 },
            {
              id: "closed",
              term: t("office.cloudShifts.closed"),
              description: shift.closedAt === null ? t("office.common.none") : at(shift.closedAt),
            },
            {
              id: "opened",
              term: t("office.cloudShifts.opened"),
              description: shift.openedAt === null ? t("office.common.none") : at(shift.openedAt),
            },
            {
              id: "mode",
              term: t("office.cloudShifts.mode"),
              description: t(`office.shifts.modes.${shift.mode}`),
            },
            {
              id: "counterparty",
              term: t("office.cloudShifts.counterparty"),
              description: shift.counterpartyName ?? t("office.common.none"),
            },
            {
              id: "reason",
              term: t("office.cloudShifts.closeReason"),
              description: shift.closeReason ?? t("office.common.none"),
            },
          ]}
        />
        <p>{t("office.cloudShifts.owners", { count: card.data.codeCount })}</p>
        <p>
          {t("office.cloudShifts.counts", {
            boxes: card.data.boxCount,
            pallets: card.data.palletCount,
          })}
        </p>
        {card.data.lateDataAt !== null && <Alert tone="warn">{t("office.shifts.lateData")}</Alert>}
        <Button onClick={() => setExport(true)}>{t("office.shifts.export")}</Button>
        {(pallets.data?.length ?? 0) > 0 && (
          <Button
            variant="secondary"
            onClick={() => setForm({ kind: "placards", id, label: shift.number })}
          >
            {t("office.cloudShifts.placards")}
          </Button>
        )}
        <p className="office-note">{t("office.cloudShifts.closedTask")}</p>
      </Card>
      <Card title={t("office.cloudShifts.boxes")} titleAs="h2">
        {boxes.isPending ? (
          <PageLoading />
        ) : boxes.isError ? (
          <CloudReadError error={boxes.error} retry={() => void boxes.refetch()} />
        ) : (
          <ul>
            {boxes.data.map((box) => (
              <li key={box.pack.id}>
                <Link to={`/cloud-boxes/${box.pack.id}`}>
                  {box.pack.sscc ?? t("office.cloudShifts.noSscc")}
                </Link>{" "}
                — {box.units}
                {box.pack.palletId !== null && (
                  <>
                    {" "}
                    ·{" "}
                    <Link to={`/cloud-pallets/${box.pack.palletId}`}>
                      {t("office.cloudShifts.pallet")}
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={t("office.cloudShifts.pallets")} titleAs="h2">
        {pallets.isPending ? (
          <PageLoading />
        ) : pallets.isError ? (
          <CloudReadError error={pallets.error} retry={() => void pallets.refetch()} />
        ) : (
          <ul>
            {pallets.data.map((row) => (
              <li key={row.pallet.id}>
                <Link to={`/cloud-pallets/${row.pallet.id}`}>
                  {row.pallet.sscc ?? t("office.cloudShifts.noSscc")}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <SavedFiles type="shift" id={id} label={shift.number} zone={zone} />
      {exporting && (
        <Suspense fallback={null}>
          <ExportDialog shift={shift} sourceKind="cloud" onClose={() => setExport(false)} />
        </Suspense>
      )}
      {form && <CloudFormDialog target={form} timeZone={zone} onClose={() => setForm(null)} />}
    </>
  );
}
export function CloudBoxPage() {
  const { id = "" } = useParams();
  const { t } = useTranslation();
  const card = useOfficeQuery(officeKeys.cloudBox(id), (api, token) => api.getCloudBox(token, id));
  const [form, setForm] = useState(false);
  if (card.isPending) return <PageLoading />;
  if (card.isError) return <CloudReadError error={card.error} retry={() => void card.refetch()} />;
  const zone = card.data.sourceTimeZone;
  if (!isSupportedHistoryTimeZone(zone)) return <UnsupportedTimeZone />;
  const { pack } = card.data;
  const label = pack.sscc ?? t("office.cloudShifts.noSscc");
  return (
    <>
      <PageHeader title={t("office.cloudShifts.boxTitle", { sscc: label })} />
      <Card>
        <p>
          <Link to={`/cloud-shifts/${pack.shiftId}`}>{card.data.shiftNumber}</Link>
        </p>
        <p>
          {card.data.productName ?? t("office.common.none")} · {cloudDate(card.data.productionDate)}
        </p>
        <PackFacts pack={pack} zone={zone} />
        <p>{t("office.cloudShifts.units", { count: card.data.units })}</p>
        {pack.palletId !== null && (
          <p>
            <Link to={`/cloud-pallets/${pack.palletId}`}>{t("office.cloudShifts.pallet")}</Link>
          </p>
        )}
        <Button onClick={() => setForm(true)}>{t("office.cloudShifts.boxForm")}</Button>
      </Card>
      <SavedFiles type="box" id={id} label={label} zone={zone} />
      {form && (
        <CloudFormDialog
          target={{ kind: "box", id, label }}
          timeZone={zone}
          onClose={() => setForm(false)}
        />
      )}
    </>
  );
}
function PackFacts({
  pack,
  zone,
}: {
  zone: string;
  pack: { openedAt: string; closedAt: string | null; disassembledAt: string | null };
}) {
  const { t } = useTranslation();
  const at = instantFormat(zone);
  return (
    <DefinitionGrid
      items={[
        { id: "open", term: t("office.cloudShifts.opened"), description: at(pack.openedAt) },
        {
          id: "close",
          term: t("office.cloudShifts.closed"),
          description: pack.closedAt === null ? t("office.common.none") : at(pack.closedAt),
        },
        {
          id: "disassembled",
          term: t("office.cloudShifts.disassembled"),
          description:
            pack.disassembledAt === null ? t("office.common.none") : at(pack.disassembledAt),
        },
      ]}
    />
  );
}
export function CloudPalletPage() {
  const { id = "" } = useParams();
  const { t } = useTranslation();
  const card = useOfficeQuery(officeKeys.cloudPallet(id), (api, token) =>
    api.getCloudPallet(token, id),
  );
  const [form, setForm] = useState<CloudFormTarget | null>(null);
  if (card.isPending) return <PageLoading />;
  if (card.isError) return <CloudReadError error={card.error} retry={() => void card.refetch()} />;
  const zone = card.data.organization.timeZone;
  if (!isSupportedHistoryTimeZone(zone)) return <UnsupportedTimeZone />;
  const { pallet, boxes } = card.data;
  const label = pallet.sscc ?? t("office.cloudShifts.noSscc");
  return (
    <>
      <PageHeader title={t("office.cloudShifts.palletTitle", { sscc: label })} />
      <Card>
        <p>{pallet.productName ?? t("office.common.none")}</p>
        <p>{t(`office.cloudShifts.${pallet.kind}`)}</p>
        <PackFacts pack={pallet} zone={zone} />
        <ul>
          {boxes.map((box) => (
            <li key={box.pack.id}>
              <Link to={`/cloud-boxes/${box.pack.id}`}>
                {box.pack.sscc ?? t("office.cloudShifts.noSscc")}
              </Link>{" "}
              · <Link to={`/cloud-shifts/${box.pack.shiftId}`}>{box.shiftNumber}</Link> ·{" "}
              {cloudDate(box.productionDate)} · {box.units}
            </li>
          ))}
        </ul>
        <div className="standalone-form__actions">
          <Button onClick={() => setForm({ kind: "pallet", id, label })}>
            {t("office.cloudShifts.palletForm")}
          </Button>
          <Button variant="secondary" onClick={() => setForm({ kind: "placard", id, label })}>
            {t("office.cloudShifts.placard")}
          </Button>
        </div>
        <CloudPalletExport rows={card.data} />
      </Card>
      <SavedFiles type="pallet" id={id} label={label} zone={zone} />
      {form && <CloudFormDialog target={form} timeZone={zone} onClose={() => setForm(null)} />}
    </>
  );
}
function CloudPalletExport({ rows }: { rows: CloudPalletRows }) {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const files = useOfficeFiles();
  const refresh = useRefreshStoredFiles();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [unrecorded, setUnrecorded] = useState<ShiftExportRecord | null>(null);
  const lock = useRef(false);
  const record = async (body: ShiftExportRecord) => {
    try {
      await session.call((token) =>
        session.api.recordCloudPalletExport(token, rows.pallet.id, body),
      );
      setUnrecorded(null);
    } catch (error) {
      setUnrecorded(body);
      setFailure(t("office.exports.recordFailed", { reason: historyFailure(t, error) }));
    }
  };
  const run = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice(null);
    setFailure(null);
    try {
      const fresh = await session.call((token) =>
        session.api.getCloudPallet(token, rows.pallet.id),
      );
      const originalZone = requireHistoryTimeZone(fresh.organization.timeZone);
      const formedAt = new Date().toISOString();
      const documentId = crypto.randomUUID();
      const result = runCloudPalletExport(fresh, {
        formatId: "pallet_xml_gismt_aggregation",
        formatVersion: 1,
        maxLines: null,
        palletId: rows.pallet.id,
        formedAt,
        documentId,
      });
      if (!result.ok) {
        setFailure(t(`office.exports.failures.${result.failure}`));
        return;
      }
      const stored = await storeExportFiles(session, {
        kind: "pallet_export",
        targetType: "pallet",
        targetId: rows.pallet.id,
        batchId: documentId,
        formatId: "pallet_xml_gismt_aggregation",
        formatVersion: 1,
        parts: result.parts.map((part, index) => ({
          partNo: index + 1,
          name: part.filename,
          bytes: part.bytes,
        })),
      });
      refresh();
      let saved = false;
      try {
        await files.save(
          exportFolder(
            fresh.pallet.sscc ?? fresh.pallet.id,
            "pallet_xml_gismt_aggregation",
            formedAt,
            originalZone,
          ),
          result.parts.map((part) => ({ name: part.filename, bytes: part.bytes })),
        );
        saved = true;
      } catch {
        setFailure(t("office.exports.files.storage"));
      }
      if (!stored.ok) {
        setFailure(t("office.storedFiles.hostCopyFailed", { reason: t(stored.messageKey) }));
      }
      if (!stored.ok && !saved) return;
      setNotice(t("office.cloudShifts.xmlSaved"));
      await record(
        shiftExportRecord({
          formatId: "pallet_xml_gismt_aggregation",
          formatVersion: 1,
          maxLines: null,
          palletId: rows.pallet.id,
          documentId,
          parts: result.parts,
          openPalletSuppressedBoxCount: result.openPalletSuppressedBoxCount,
        }),
      );
    } catch (error) {
      setFailure(historyFailure(t, error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="secondary" disabled={busy} onClick={() => void run()}>
        {t("office.exports.palletExport")}
      </Button>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {failure && <Alert tone="error">{failure}</Alert>}
      {unrecorded && (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            if (lock.current) return;
            lock.current = true;
            setBusy(true);
            setFailure(null);
            void record(unrecorded).finally(() => {
              lock.current = false;
              setBusy(false);
            });
          }}
        >
          {t("office.exports.recordAgain")}
        </Button>
      )}
      <p className="office-note">{t("office.cloudShifts.manualUpload")}</p>
    </>
  );
}
