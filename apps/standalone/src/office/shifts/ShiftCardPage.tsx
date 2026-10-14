import { isShiftCloseReasonCode, type PlacardFormat } from "@markiro/domain";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import {
  Alert,
  Button,
  Card,
  DefinitionGrid,
  Input,
  PageHeader,
  RowActions,
  StatusChip,
  Table,
  type TableColumn,
  type TagPhase,
} from "@markiro/ui";

import type { OfficeBox, OfficePallet, OfficeShift, ShiftStatus } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { hasPlacard } from "../forms/form-data.js";
import { PrintFormDialog, type FormTarget } from "../forms/PrintFormDialog.js";
import { formTimeZone } from "../forms/render-form.js";
import { taskFormInputs } from "../forms/task-inputs.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { OfficePager } from "../OfficePager.js";
import { LoadError, PageLoading } from "../page-state.js";
import { CloseShiftDialog } from "./CloseShiftDialog.js";
import {
  BOX_PAGE_SIZE,
  endsWithTail,
  isLateBox,
  labelState,
  packState,
  palletCountDiffers,
  ssccTail,
  ssccText,
  type PackState,
} from "./shift-card.js";
import { civilDateLabel, recordLabel } from "./shift-list.js";
import { ShiftTotalsDialog } from "./ShiftTotalsDialog.js";

/**
 * The export dialog comes with the domain's renderers and the check of every
 * format: a chunk of its own, read when «Выгрузка» is first pressed, as on
 * «Смены» (a static import here would put it back into the page's chunk).
 */
const ExportDialog = lazy(() =>
  import("../exports/ExportDialog.js").then((module) => ({ default: module.ExportDialog })),
);

/** A status in its phase, as the list shows it. */
const STATUS_PHASE = {
  planned: "planned",
  active: "active",
  closed: "done",
} as const satisfies Record<ShiftStatus, TagPhase>;

/** A box's or a pallet's state in its phase: the cloud tags one taken apart `dismantled`. */
const PACK_PHASE = {
  open: "active",
  closed: "done",
  disassembled: "dismantled",
} as const satisfies Record<PackState, TagPhase>;

/** Counts with the thousands apart by a no-break space: «1 200». */
const UNITS = new Intl.NumberFormat("ru");

type CardDialog = "totals" | "export" | "close";

/**
 * The card of a shift (plan О-Ф, pilot spec §7), opened from «Смены» by the
 * shift's number: what the shift is, its boxes and its pallets as the host
 * derives them now, and what the office does with it — the figures
 * («Итоги»), the exports («Выгрузка», plan ЧЗ), the close and the printed
 * forms: «Бланк смены» until the shift closes, «Состав короба» of a box,
 * «Состав паллеты» and «Ярлык паллеты» of a pallet, «Ярлыки паллет смены»
 * (pilot spec §5.5). Every role reads it and prints; closing stays with
 * `planShifts`. Times are written in the organization's zone, as the forms
 * write them.
 */
export function ShiftCardPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const canPlan = useCan("planShifts");
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<CardDialog | null>(null);
  const [form, setForm] = useState<FormTarget | null>(null);
  const [paper, setPaper] = useState<PlacardFormat>("a4");
  const [notice, setNotice] = useState<string | null>(null);
  const noticeId = useId();
  const shift = useOfficeQuery(officeKeys.shift(id), (api, token) => api.getShift(token, id));
  const products = useOfficeQuery(officeKeys.products, (api, token) => api.listProducts(token));
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));
  const counterparties = useOfficeQuery(officeKeys.counterparties, (api, token) =>
    api.listCounterparties(token),
  );
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const palletList = useOfficeQuery(
    officeKeys.shiftPallets(id),
    (api, token) => api.listShiftPallets(token, id),
    {
      // A planned shift has no pallets, and no placards to offer.
      enabled:
        shift.data !== undefined && shift.data.palletsEnabled && shift.data.status !== "planned",
    },
  );

  // The product's photo for «Бланк смены» (plan ТОВ), read only when the product has one.
  const cardProduct = products.data?.find((each) => each.id === shift.data?.productId);
  const productId = cardProduct?.id ?? "";
  const photo = useOfficeQuery(
    officeKeys.productPhoto(productId),
    (api, token) => api.getProductPhoto(token, productId),
    { enabled: cardProduct !== undefined && cardProduct.photoChecksum !== null },
  );

  useEffect(() => {
    if (notice !== null) document.getElementById(noticeId)?.focus();
  }, [notice, noticeId]);

  /** After a close: the card and every list of shifts are read again. */
  const readAgain = () => {
    void queryClient.invalidateQueries({ queryKey: officeKeys.shifts });
    void queryClient.invalidateQueries({ queryKey: officeKeys.shift(id) });
    void queryClient.invalidateQueries({ queryKey: officeKeys.shiftBoxes(id) });
    void queryClient.invalidateQueries({ queryKey: officeKeys.shiftPallets(id) });
  };

  const back = (
    <Link className="shift-card__back" to="/shifts">
      {t("office.shiftCard.back")}
    </Link>
  );
  if (shift.isPending) {
    return (
      <>
        {back}
        <PageLoading />
      </>
    );
  }
  if (shift.isError) {
    return (
      <>
        {back}
        <LoadError error={shift.error} onRetry={() => void shift.refetch()} />
      </>
    );
  }

  const current = shift.data;
  const zone = formTimeZone(org.data);
  const time = new Intl.DateTimeFormat("ru", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: zone,
  });
  const at = (instant: string | null) =>
    instant === null ? t("office.common.none") : time.format(new Date(instant));
  // «Бланк смены» waits for every record it names, as the cloud reads them in one query.
  const taskInputs = taskFormInputs(
    current,
    products.data,
    lines.data,
    counterparties.data,
    org.isSuccess ? org.data : undefined,
    // Waited for while it is read; one that did not read leaves the blank without it.
    photo.isError ? null : photo.data?.photo,
  );
  // The cloud offers the shift's placards only when a pallet has one to print.
  const placards =
    palletList.data?.some((pallet) => hasPlacard(pallet) && pallet.disassembledAt === null) ===
    true;

  return (
    <div className="office-stack">
      {back}
      <PageHeader
        title={t("office.shiftCard.title", { number: current.number })}
        actions={
          <RowActions>
            {current.status !== "planned" && (
              <Button variant="secondary" onClick={() => setDialog("totals")}>
                {t("office.shifts.totalsAction")}
              </Button>
            )}
            {current.status !== "planned" && (
              <Button variant="secondary" onClick={() => setDialog("export")}>
                {t("office.shifts.export")}
              </Button>
            )}
            {canPlan && current.status === "active" && (
              <Button variant="secondary" onClick={() => setDialog("close")}>
                {t("office.shifts.close")}
              </Button>
            )}
            {current.status !== "closed" && (
              <Button variant="secondary" onClick={() => setForm({ kind: "task" })}>
                {t("office.shiftCard.taskForm")}
              </Button>
            )}
            {current.status !== "planned" && placards && (
              <Button variant="secondary" onClick={() => setForm({ kind: "placards" })}>
                {t("office.shiftCard.placards")}
              </Button>
            )}
          </RowActions>
        }
      />
      {notice && (
        <Alert tone="ok" id={noticeId} tabIndex={-1}>
          {notice}
        </Alert>
      )}
      <ShiftStatusLine shift={current} />
      <DefinitionGrid
        items={[
          {
            id: "product",
            term: t("office.shifts.table.product"),
            description: recordLabel("product", products.data, current.productId, t),
          },
          {
            id: "productionDate",
            term: t("office.shifts.table.productionDate"),
            description: civilDateLabel(current.productionDate),
            mono: true,
          },
          {
            id: "line",
            term: t("office.shifts.table.line"),
            description: recordLabel("line", lines.data, current.lineId, t),
          },
          {
            id: "counterparty",
            term: t("office.shiftCard.counterparty"),
            description:
              current.counterpartyId === null
                ? t("office.common.none")
                : recordLabel("counterparty", counterparties.data, current.counterpartyId, t),
          },
          {
            id: "mode",
            term: t("office.shifts.table.mode"),
            description: t(`office.shifts.modes.${current.mode}`),
          },
          {
            id: "plannedQty",
            term: t("office.shifts.table.plannedQty"),
            description:
              current.plannedQty === null
                ? t("office.common.none")
                : UNITS.format(current.plannedQty),
            mono: true,
          },
          {
            id: "boxCapacity",
            term: t("office.shiftCard.boxCapacity"),
            description: UNITS.format(current.boxCapacity),
            mono: true,
          },
          {
            id: "pallets",
            term: t("office.shiftCard.palletsFact"),
            description:
              current.palletBoxCapacity === null
                ? t("office.shiftCard.noPallets")
                : t("office.shiftCard.palletCapacity", {
                    boxes: UNITS.format(current.palletBoxCapacity),
                  }),
          },
          {
            id: "output",
            term: t("office.shifts.table.output"),
            description:
              current.status === "planned"
                ? t("office.common.none")
                : t("office.shifts.output", {
                    units: UNITS.format(current.totals.unitsInClosedBoxes),
                    boxes: UNITS.format(current.totals.closedBoxes),
                  }),
            mono: true,
          },
          {
            id: "openedAt",
            term: t("office.shiftCard.openedAt"),
            description: at(current.openedAt),
          },
          {
            id: "closedAt",
            term: t("office.shiftCard.closedAt"),
            description: at(current.closedAt),
          },
        ]}
      />
      {current.status !== "planned" && <ShiftBoxes shift={current} at={at} onForm={setForm} />}
      {current.status !== "planned" && current.palletsEnabled && (
        <ShiftPallets shift={current} at={at} onForm={setForm} />
      )}
      {form !== null && (
        <PrintFormDialog
          shift={current}
          target={form}
          taskInputs={taskInputs}
          timeZone={zone}
          format={paper}
          onFormat={setPaper}
          onClose={() => setForm(null)}
        />
      )}
      {dialog === "totals" && <ShiftTotalsDialog shift={current} onClose={() => setDialog(null)} />}
      {dialog === "export" && (
        <Suspense fallback={null}>
          <ExportDialog shift={current} onClose={() => setDialog(null)} />
        </Suspense>
      )}
      {canPlan && dialog === "close" && (
        <CloseShiftDialog
          shift={current}
          onClose={() => setDialog(null)}
          onClosed={(closed) => {
            setDialog(null);
            setNotice(t("office.shifts.closed", { number: closed.number }));
            readAgain();
          }}
          onReload={() => {
            setDialog(null);
            readAgain();
          }}
          onOutdated={readAgain}
        />
      )}
    </div>
  );
}

/** The shift's status and its marks, as the list's status cell shows them. */
function ShiftStatusLine({ shift }: { shift: OfficeShift }) {
  const { t } = useTranslation();
  return (
    <div className="shift-cell">
      <StatusChip
        phase={STATUS_PHASE[shift.status]}
        label={t(`office.shifts.statuses.${shift.status}`)}
      />
      {shift.lateDataAt !== null && (
        <StatusChip phase="attention" label={t("office.shifts.lateData")} />
      )}
      {shift.closeReasonText !== null && (
        <span className="shift-cell__quiet">
          {t("office.shifts.closedByOffice", { reason: shift.closeReasonText })}
        </span>
      )}
      {shift.closeReasonCode !== null && (
        <span className="shift-cell__quiet">
          {t("office.shifts.closeReason", {
            reason: isShiftCloseReasonCode(shift.closeReasonCode)
              ? t(`office.shifts.closeReasons.${shift.closeReasonCode}`)
              : shift.closeReasonCode,
          })}
        </span>
      )}
    </div>
  );
}

interface SectionProps {
  shift: OfficeShift;
  /** An instant in the organization's zone, or «—». */
  at: (instant: string | null) => string;
  /** Opens a form of a box or a pallet. */
  onForm: (target: FormTarget) => void;
}

/** The shift's boxes, opened first first, a page at a time, filtered by the SSCC's last digits. */
function ShiftBoxes({ shift, at, onForm }: SectionProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const [tail, setTail] = useState("");
  const [page, setPage] = useState(1);
  const boxes = useOfficeQuery(officeKeys.shiftBoxes(shift.id), (api, token) =>
    api.listShiftBoxes(token, shift.id),
  );
  const pallets = useOfficeQuery(
    officeKeys.shiftPallets(shift.id),
    (api, token) => api.listShiftPallets(token, shift.id),
    { enabled: shift.palletsEnabled },
  );

  const palletById = useMemo(
    () => new Map((pallets.data ?? []).map((pallet) => [pallet.id, pallet])),
    [pallets.data],
  );
  const palletLabel = (box: OfficeBox) => {
    if (box.palletId === null) return t("office.common.none");
    // Not "not found" while the pallets are still coming or did not come: they are not known yet.
    if (pallets.isPending) return t("office.common.loading");
    if (pallets.isError) return t("office.shiftCard.palletsUnread");
    const pallet = palletById.get(box.palletId);
    if (pallet === undefined) return t("office.shiftCard.unknownPallet");
    return pallet.sscc === null ? t("office.shiftCard.openPallet") : ssccText(pallet.sscc);
  };

  const columns: TableColumn<OfficeBox>[] = [
    {
      key: "sscc",
      title: t("office.shiftCard.boxes.sscc"),
      mono: true,
      render: (box) => (box.sscc === null ? t("office.shiftCard.noSscc") : ssccText(box.sscc)),
    },
    {
      key: "units",
      title: t("office.shiftCard.boxes.units"),
      mono: true,
      align: "right",
      render: (box) => UNITS.format(box.units),
    },
    {
      key: "closedAt",
      title: t("office.shiftCard.boxes.closedAt"),
      wrap: true,
      minWidth: 150,
      render: (box) => at(box.closedAt),
    },
    ...(shift.palletsEnabled
      ? [
          {
            key: "pallet",
            title: t("office.shiftCard.boxes.pallet"),
            mono: true,
            render: palletLabel,
          },
        ]
      : []),
    {
      key: "state",
      title: t("office.shiftCard.boxes.state"),
      wrap: true,
      minWidth: 180,
      render: (box) => (
        <PackStateCell
          pack={box}
          kind="box"
          at={at}
          late={box.palletId !== null && isLateBox(box, palletById.get(box.palletId))}
        />
      ),
    },
    {
      key: "label",
      title: t("office.shiftCard.boxes.label"),
      render: (box) =>
        box.closedAt === null
          ? t("office.common.none")
          : t(`office.shiftCard.label.${labelState(box)}`),
    },
    {
      key: "forms",
      title: t("office.shiftCard.forms"),
      render: (box) => {
        const label = box.sscc === null ? t("office.shiftCard.noSscc") : ssccText(box.sscc);
        return (
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.shiftCard.boxContentsNamed", { label })}
            onClick={() => onForm({ kind: "box", boxId: box.id, label })}
          >
            {t("office.shiftCard.contents")}
          </Button>
        );
      },
    },
  ];

  const content = () => {
    if (boxes.isPending) return <PageLoading />;
    if (boxes.isError)
      return <LoadError error={boxes.error} onRetry={() => void boxes.refetch()} />;
    const kept = boxes.data.filter((box) => endsWithTail(box.sscc, tail));
    const pageCount = Math.max(1, Math.ceil(kept.length / BOX_PAGE_SIZE));
    const shown = Math.min(page, pageCount);
    return (
      <>
        <p className="office-note" aria-live="polite">
          {t("office.shiftCard.boxes.found", { shown: kept.length, total: boxes.data.length })}
        </p>
        <Table
          columns={columns}
          rows={kept.slice((shown - 1) * BOX_PAGE_SIZE, shown * BOX_PAGE_SIZE)}
          getRowKey={(box) => box.id}
          empty={t(
            boxes.data.length === 0
              ? "office.shiftCard.boxes.empty"
              : "office.shiftCard.boxes.none",
          )}
          scrollLabel={t("office.shiftCard.boxes.table")}
        />
        {pageCount > 1 && (
          <OfficePager
            label={t("office.shiftCard.boxes.pager")}
            page={shown}
            pageCount={pageCount}
            onPage={setPage}
          />
        )}
      </>
    );
  };

  return (
    <section className="shift-card__section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("office.shiftCard.boxes.title")}</h2>
      <Card>
        <Input
          label={t("office.shiftCard.boxes.tail")}
          hint={t("office.shiftCard.boxes.tailHint")}
          inputMode="numeric"
          value={tail}
          onChange={(event) => {
            setTail(ssccTail(event.target.value));
            setPage(1);
          }}
        />
        {content()}
      </Card>
    </section>
  );
}

/** The shift's pallets, opened first first, with what stands on each now. */
function ShiftPallets({ shift, at, onForm }: SectionProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const pallets = useOfficeQuery(officeKeys.shiftPallets(shift.id), (api, token) =>
    api.listShiftPallets(token, shift.id),
  );

  const columns: TableColumn<OfficePallet>[] = [
    {
      key: "sscc",
      title: t("office.shiftCard.pallets.sscc"),
      mono: true,
      render: (pallet) =>
        pallet.sscc === null ? t("office.shiftCard.noSscc") : ssccText(pallet.sscc),
    },
    {
      key: "boxes",
      title: t("office.shiftCard.pallets.boxes"),
      mono: true,
      align: "right",
      // A pallet taken apart keeps its boxes' link on the host: those are not its boxes now.
      render: (pallet) =>
        packState(pallet) === "disassembled" ? t("office.common.none") : UNITS.format(pallet.boxes),
    },
    {
      key: "units",
      title: t("office.shiftCard.pallets.units"),
      mono: true,
      align: "right",
      render: (pallet) =>
        packState(pallet) === "disassembled" ? t("office.common.none") : UNITS.format(pallet.units),
    },
    {
      key: "closedAt",
      title: t("office.shiftCard.pallets.closedAt"),
      wrap: true,
      minWidth: 150,
      render: (pallet) => at(pallet.closedAt),
    },
    {
      key: "state",
      title: t("office.shiftCard.pallets.state"),
      wrap: true,
      minWidth: 180,
      render: (pallet) => <PackStateCell pack={pallet} kind="pallet" at={at} />,
    },
    {
      key: "forms",
      title: t("office.shiftCard.forms"),
      render: (pallet) => {
        const label = pallet.sscc === null ? t("office.shiftCard.noSscc") : ssccText(pallet.sscc);
        return (
          <RowActions>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.shiftCard.palletContentsNamed", { label })}
              onClick={() => onForm({ kind: "pallet", palletId: pallet.id, label })}
            >
              {t("office.shiftCard.contents")}
            </Button>
            {hasPlacard(pallet) && (
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shiftCard.placardNamed", { label })}
                onClick={() => onForm({ kind: "placard", palletId: pallet.id, label })}
              >
                {t("office.shiftCard.placard")}
              </Button>
            )}
          </RowActions>
        );
      },
    },
  ];

  return (
    <section className="shift-card__section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("office.shiftCard.pallets.title")}</h2>
      <Card>
        {pallets.isPending ? (
          <PageLoading />
        ) : pallets.isError ? (
          <LoadError error={pallets.error} onRetry={() => void pallets.refetch()} />
        ) : (
          <Table
            columns={columns}
            rows={pallets.data}
            getRowKey={(pallet) => pallet.id}
            empty={t("office.shiftCard.pallets.empty")}
            scrollLabel={t("office.shiftCard.pallets.table")}
          />
        )}
      </Card>
    </section>
  );
}

/**
 * A box's or a pallet's state, and what the station's close said against
 * what stands there now: a closed box whose digest did not match, a pallet
 * whose count differs from its boxes not taken apart, a box that was closed
 * after its pallet (`late`). Shown, never fixed; each as a word, not a colour.
 */
function PackStateCell({
  pack,
  kind,
  at,
  late = false,
}: {
  pack: OfficeBox | OfficePallet;
  kind: "box" | "pallet";
  at: (instant: string | null) => string;
  late?: boolean;
}) {
  const { t } = useTranslation();
  const state = packState(pack);
  // Each says its own: a box's digest only while it stands closed (a box taken apart is stale),
  // a pallet's count by `palletCountDiffers`, which leaves a pallet taken apart out.
  const mismatch =
    "digestMatches" in pack
      ? state === "closed" && pack.digestMatches === false
      : palletCountDiffers(pack);
  return (
    <span className="shift-cell">
      <StatusChip phase={PACK_PHASE[state]} label={t(`office.shiftCard.${kind}State.${state}`)} />
      {state === "disassembled" && (
        <span className="shift-cell__quiet">
          {t("office.shiftCard.disassembledAt", { at: at(pack.disassembledAt) })}
        </span>
      )}
      {mismatch && (
        <StatusChip phase="attention" wrap label={t(`office.shiftCard.${kind}Mismatch`)} />
      )}
      {late && <StatusChip phase="attention" wrap label={t("office.shiftCard.lateBox")} />}
    </span>
  );
}
