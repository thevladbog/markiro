import { isShiftCloseReasonCode, type PlacardFormat } from "@markiro/domain";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";

import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  DataTabs,
  DefinitionGrid,
  Input,
  RowActions,
  SidePanel,
  StatusChip,
  type TableColumn,
  type TagPhase,
} from "@markiro/ui";

import type {
  LabelTemplateSummary,
  OfficeBox,
  OfficePallet,
  OfficeShift,
  PalletSheets,
  ShiftStatus,
} from "../../host/protocol.js";
import { useCan } from "../access.js";
import { useTemplates } from "../catalog-queries.js";
import { hasPlacard } from "../forms/form-data.js";
import { BoxLink, PalletLink, PalletLinkOrOpen } from "../codes/PackLinks.js";
import { PrintFormDialog, type FormTarget } from "../forms/PrintFormDialog.js";
import { formTimeZone } from "../forms/render-form.js";
import { taskFormInputs } from "../forms/task-inputs.js";
import { DemoBadge } from "../demo/DemoBadge.js";
import { isDemoShift } from "../demo/demo.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { PagedTable } from "../paging/PagedTable.js";
import { LoadError, PageLoading } from "../page-state.js";
import { CloseShiftDialog } from "./CloseShiftDialog.js";
import {
  endsWithTail,
  isLateBox,
  labelState,
  packState,
  ssccTail,
  ssccText,
  type PackState,
} from "./shift-card.js";
import { civilDateLabel, recordLabel } from "./shift-list.js";
import { ShiftConflicts, ShiftExceptions, ShiftRejections } from "./ShiftReview.js";
import { shiftOutput } from "./shift-text.js";
import { ShiftTotalsBody } from "./ShiftTotalsDialog.js";
import { ShiftEditBody, type ShiftEditStatus } from "./ShiftEditor.js";
import { ShiftExports } from "./ShiftExports.js";
import { ShiftScans } from "./ShiftScans.js";
import { PalletCountTag } from "./PalletCountTag.js";

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

type CardDialog = "export" | "close";

/** The sections of the drawer, in the order of its tabs. */
export const DRAWER_TABS = [
  "summary",
  "boxes",
  "pallets",
  "scans",
  "exceptions",
  "rejections",
  "conflicts",
  "exports",
] as const;
export type DrawerTab = (typeof DRAWER_TABS)[number];

function isDrawerTab(value: string | null): value is DrawerTab {
  return DRAWER_TABS.some((tab) => tab === value);
}

/** The tabs a shift has: a planned one only its summary, a validation one no boxes or pallets. */
export function drawerTabs(shift: OfficeShift): DrawerTab[] {
  if (shift.status === "planned") return ["summary"];
  const validation = shift.mode === "validation";
  return DRAWER_TABS.filter((tab) => {
    if (tab === "boxes") return !validation;
    if (tab === "pallets") return shift.palletsEnabled;
    // Box and pallet exceptions only: a validation shift can have none.
    if (tab === "exceptions") return !validation;
    return true;
  });
}

export interface ShiftDrawerProps {
  /** The shift's id, from `?shift=` of «Смены». */
  id: string;
  onClose: () => void;
}

/**
 * The card of a shift (plan О-Ф, pilot spec §7) as a side drawer over «Смены»,
 * the way the cloud opens a shift: the list stays behind, the drawer says what
 * the shift is and has a tab per section, each reading on its own when it is
 * first opened — the figures («Итоги»), its boxes and its pallets as the host
 * derives them now, the exceptions, refused records and code conflicts of
 * plan КНФ, and the exports. Above the tabs stand the actions: the export
 * («Выгрузка», plan ЧЗ), the close, and the printed forms — «Бланк смены» until
 * the shift closes, «Ярлыки паллет смены», and in the tabs «Состав короба»,
 * «Состав паллеты» and «Ярлык паллеты» of one (pilot spec §5.5). Every role
 * reads it and prints; closing stays with `planShifts`. Times are written in
 * the organization's zone, as the forms write them. The tab is the link's
 * `?tab=`, so a drawer can be opened on a section.
 */
export function ShiftDrawer({ id, onClose }: ShiftDrawerProps) {
  const { t } = useTranslation();
  const canPlan = useCan("planShifts");
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<CardDialog | null>(null);
  const [form, setForm] = useState<FormTarget | null>(null);
  const [paper, setPaper] = useState<PlacardFormat>("a4");
  const [notice, setNotice] = useState<string | null>(null);
  const noticeId = useId();
  // «Изменить» switches the card to the shift's fields (a planned shift only); the editor reports
  // its state for the footer, and leaving with unsaved changes asks first.
  const [editing, setEditing] = useState(false);
  const [editStatus, setEditStatus] = useState<ShiftEditStatus>({
    dirty: false,
    submitDisabled: true,
    sending: false,
  });
  const [asking, setAsking] = useState<"close" | "cancel" | null>(null);
  const formId = useId();
  const shift = useOfficeQuery(officeKeys.shift(id), (api, token) => api.getShift(token, id));
  const products = useOfficeQuery(officeKeys.products, (api, token) => api.listProducts(token));
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));
  const counterparties = useOfficeQuery(officeKeys.counterparties, (api, token) =>
    api.listCounterparties(token),
  );
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const templates = useTemplates();
  const palletSheets = useOfficeQuery(
    officeKeys.palletSheets,
    (api, token) => api.listPalletSheets(token),
    // A validation shift has no pallets, whatever its switch holds.
    { enabled: shift.data?.palletsEnabled === true && shift.data.mode !== "validation" },
  );
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
    void queryClient.invalidateQueries({ queryKey: officeKeys.shiftExceptions(id) });
    void queryClient.invalidateQueries({ queryKey: officeKeys.shiftRejections(id) });
    void queryClient.invalidateQueries({ queryKey: officeKeys.shiftExports(id) });
    void queryClient.invalidateQueries({ queryKey: officeKeys.conflicts });
  };

  /** The × and Escape: while editing, unsaved changes are asked about, and a write on its way is not abandoned. */
  const requestClose = () => {
    if (editing && editStatus.sending) return;
    if (editing && editStatus.dirty) setAsking("close");
    else onClose();
  };
  const requestCancel = () => {
    if (editStatus.sending) return;
    if (editStatus.dirty) setAsking("cancel");
    else setEditing(false);
  };
  const panel = (title: string, body: ReactNode, footer?: ReactNode) => (
    <>
      <SidePanel
        open
        size="complex"
        className="shift-drawer"
        title={title}
        closeLabel={t("office.shiftCard.close")}
        onClose={requestClose}
        busy={editing && editStatus.sending}
        footer={footer}
      >
        {body}
      </SidePanel>
      <ConfirmDialog
        open={asking !== null}
        title={t("office.drawer.discardTitle")}
        description={t("office.drawer.discardBody")}
        confirmLabel={t("office.drawer.discard")}
        cancelLabel={t("office.drawer.keepEditing")}
        tone="destructive"
        onConfirm={() => {
          const action = asking;
          setAsking(null);
          if (action === "close") onClose();
          else setEditing(false);
        }}
        onCancel={() => setAsking(null)}
      />
    </>
  );
  if (shift.isPending) {
    return panel(t("office.shiftCard.loadingTitle"), <PageLoading />);
  }
  if (shift.isError) {
    return panel(
      t("office.shiftCard.loadingTitle"),
      <LoadError error={shift.error} onRetry={() => void shift.refetch()} />,
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

  const tabs = drawerTabs(current);
  const asked = params.get("tab");
  // A conflict's older link names a box: it opens on the boxes, filtered.
  const active: DrawerTab =
    isDrawerTab(asked) && tabs.includes(asked)
      ? asked
      : params.get("box") !== null && tabs.includes("boxes")
        ? "boxes"
        : "summary";
  const selectTab = (tab: DrawerTab) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set("tab", tab);
        return next;
      },
      { replace: true },
    );

  const editable = canPlan && current.status === "planned";
  const demo = isDemoShift(current, products.data);
  if (editing && editable) {
    return panel(
      t("office.shiftCard.title", { number: current.number }),
      <div className="office-stack">
        <ShiftStatusLine shift={current} demo={demo} />
        <ShiftEditBody
          key={current.id}
          shift={current}
          formId={formId}
          onStatus={setEditStatus}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setNotice(t("office.common.saved"));
            readAgain();
          }}
          onReload={() => {
            setEditing(false);
            readAgain();
          }}
          onOutdated={readAgain}
        />
      </div>,
      <>
        <Button variant="secondary" onClick={requestCancel} disabled={editStatus.sending}>
          {t("office.common.cancel")}
        </Button>
        <Button
          type="submit"
          form={formId}
          loading={editStatus.sending}
          disabled={editStatus.submitDisabled}
        >
          {t("office.common.save")}
        </Button>
      </>,
    );
  }

  return panel(
    t("office.shiftCard.title", { number: current.number }),
    <div className="office-stack">
      <ShiftStatusLine shift={current} demo={demo} />
      <RowActions>
        {editable && (
          <Button
            variant="secondary"
            aria-label={t("office.shiftCard.editNamed", { number: current.number })}
            onClick={() => {
              setNotice(null);
              setEditStatus({ dirty: false, submitDisabled: true, sending: false });
              setEditing(true);
            }}
          >
            {t("office.shiftCard.edit")}
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
      {notice && (
        <Alert tone="ok" id={noticeId} tabIndex={-1}>
          {notice}
        </Alert>
      )}
      {tabs.length > 1 && (
        <DataTabs
          label={t("office.shiftCard.tabs.label")}
          items={tabs.map((tab) => ({
            id: tab,
            label: t(`office.shiftCard.tabs.${tab}`),
            panelId: `${id}-tab-panel`,
          }))}
          activeId={active}
          onChange={selectTab}
        />
      )}
      {/* Keyed by the shift: a link to another shift's card (a conflict's winner) opens this
          drawer again, and its filters and pages, `?box=` included, start afresh. */}
      <div id={`${id}-tab-panel`} role="tabpanel" className="office-stack">
        {active === "summary" && (
          <ShiftSummary
            shift={current}
            at={at}
            products={products.data}
            lines={lines.data}
            counterparties={counterparties.data}
            templates={templates.data}
            sheets={palletSheets.data}
          />
        )}
        {active === "boxes" && (
          <ShiftBoxes key={`boxes-${current.id}`} shift={current} at={at} onForm={setForm} />
        )}
        {active === "pallets" && (
          <ShiftPallets key={`pallets-${current.id}`} shift={current} at={at} onForm={setForm} />
        )}
        {active === "scans" && (
          <ShiftScans key={`scans-${current.id}`} shift={current} at={at} zone={zone} />
        )}
        {active === "exceptions" && (
          <ShiftExceptions key={`exceptions-${current.id}`} shift={current} at={at} />
        )}
        {active === "rejections" && (
          <ShiftRejections key={`rejections-${current.id}`} shift={current} at={at} />
        )}
        {active === "conflicts" && (
          <ShiftConflicts key={`conflicts-${current.id}`} shift={current} at={at} />
        )}
        {active === "exports" && (
          <ShiftExports key={`exports-${current.id}`} shift={current} at={at} timeZone={zone} />
        )}
      </div>
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
      {dialog === "export" && (
        <Suspense fallback={null}>
          <ExportDialog
            shift={current}
            demo={demo}
            onClose={() => {
              setDialog(null);
              // A finished export wrote a row of the history.
              void queryClient.invalidateQueries({ queryKey: officeKeys.shiftExports(id) });
            }}
          />
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
    </div>,
  );
}

/** What the shift is and its figures: the details, the print control and «Итоги». */
function ShiftSummary({
  shift: current,
  at,
  products,
  lines,
  counterparties,
  templates,
  sheets,
}: {
  shift: OfficeShift;
  at: (instant: string | null) => string;
  templates: readonly LabelTemplateSummary[] | undefined;
  sheets: PalletSheets | undefined;
  products: Parameters<typeof recordLabel>[1];
  lines: Parameters<typeof recordLabel>[1];
  counterparties: Parameters<typeof recordLabel>[1];
}) {
  const { t } = useTranslation();
  const figuresId = useId();
  const validation = current.mode === "validation";
  const duplicate =
    current.validationPrint?.mode === "duplicate_dm" ? current.validationPrint : null;
  return (
    <>
      <DefinitionGrid
        items={[
          {
            id: "product",
            term: t("office.shifts.table.product"),
            description: recordLabel("product", products, current.productId, t),
          },
          {
            id: "plannedDate",
            term: t("office.shifts.table.plannedDate"),
            description: civilDateLabel(current.plannedDate),
            mono: true,
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
            description: recordLabel("line", lines, current.lineId, t),
          },
          {
            id: "counterparty",
            term: t("office.shiftCard.counterparty"),
            description:
              current.counterpartyId === null
                ? t("office.common.none")
                : recordLabel("counterparty", counterparties, current.counterpartyId, t),
          },
          {
            id: "mode",
            term: t("office.shifts.table.mode"),
            description: t(`office.shifts.modes.${current.mode}`),
          },
          // The duplicate print is a validation shift's alone (plan РЕЖ part B).
          ...(validation
            ? [
                {
                  id: "duplicate",
                  term: t("office.shiftCard.duplicate"),
                  description:
                    duplicate === null
                      ? t("office.shiftCard.duplicateOff")
                      : t(
                          duplicate.verification === "required"
                            ? "office.shiftCard.duplicateRequired"
                            : "office.shiftCard.duplicateOptional",
                        ),
                },
              ]
            : []),
          {
            id: "plannedQty",
            term: t("office.shifts.table.plannedQty"),
            description:
              current.plannedQty === null
                ? t("office.common.none")
                : UNITS.format(current.plannedQty),
            mono: true,
          },
          // A validation shift has no boxes and no pallets (plan РЕЖ, Р11): the capacity it
          // keeps (Р4) means nothing to it.
          ...(validation
            ? []
            : [
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
              ]),
          // The templates the shift prints with, frozen at its opening (a validation shift
          // prints no box label; its duplicate template is shown above with the flag).
          ...(validation
            ? duplicate === null
              ? []
              : [
                  {
                    id: "duplicateTemplate",
                    term: t("office.shiftCard.duplicateTemplate"),
                    description: templateName(templates, duplicate.templateId, t),
                  },
                ]
            : [
                {
                  id: "boxTemplate",
                  term: t("office.shiftCard.boxTemplate"),
                  description: templateName(templates, current.boxTemplateId, t),
                },
                ...(current.palletTemplateId === null
                  ? []
                  : [
                      {
                        id: "palletTemplate",
                        term: t("office.shiftCard.palletTemplate"),
                        description: templateName(templates, current.palletTemplateId, t),
                      },
                      {
                        id: "palletSheet",
                        term: t("office.shiftCard.palletSheet"),
                        description:
                          current.palletSheetTemplateId === null
                            ? t("office.shiftCard.defaultSheet")
                            : (sheets?.sheets.find(
                                (sheet) => sheet.id === current.palletSheetTemplateId,
                              )?.name ??
                              t("office.shiftCard.templateNamed", {
                                id: current.palletSheetTemplateId.slice(0, 8),
                              })),
                      },
                    ]),
              ]),
          {
            id: "output",
            term: t("office.shifts.table.output"),
            description: shiftOutput(current, t),
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
      {current.status !== "planned" && current.totals.unitLabels !== undefined && (
        <UnitLabelControl figures={current.totals.unitLabels} />
      )}
      {current.status !== "planned" && (
        <section className="shift-card__section" aria-labelledby={figuresId}>
          <h2 id={figuresId}>{t("office.shiftCard.figures")}</h2>
          <Card>
            <ShiftTotalsBody shift={current} />
          </Card>
        </section>
      )}
    </>
  );
}

/** A template by its name; one the list lacks (deleted, or the list did not load) by the start of its id. */
function templateName(
  templates: readonly LabelTemplateSummary[] | undefined,
  id: string,
  t: TFunction,
): string {
  return (
    templates?.find((each) => each.id === id)?.name ??
    t("office.shiftCard.templateNamed", { id: id.slice(0, 8) })
  );
}

/** The shift's status and its marks, as the list's status cell shows them. */
function ShiftStatusLine({ shift, demo }: { shift: OfficeShift; demo: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="shift-cell">
      <StatusChip
        phase={STATUS_PHASE[shift.status]}
        label={t(`office.shifts.statuses.${shift.status}`)}
      />
      {demo && <DemoBadge />}
      {/* The working day, in the header of every tab (beta 3); the production date is in the summary. */}
      <span className="shift-cell__quiet">
        {t("office.shiftCard.headerDate", { date: civilDateLabel(shift.plannedDate) })}
      </span>
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

/**
 * «Контроль печати» (the cloud's `pages.shifts.productLabels`): what the host
 * counts of a printing shift's unit labels from its facts — attempts sent,
 * attempts verified, checks skipped, jobs not finished yet, reprints — with
 * the cloud's warning that a send is not a print, and a word, not a colour,
 * when some labels still need finishing.
 */
function UnitLabelControl({
  figures,
}: {
  figures: NonNullable<OfficeShift["totals"]["unitLabels"]>;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <section className="shift-card__section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("office.shiftCard.unitLabels.title")}</h2>
      <Card>
        <p className="office-note">{t("office.shiftCard.unitLabels.hint")}</p>
        {figures.unresolved > 0 && (
          <StatusChip phase="attention" wrap label={t("office.shiftCard.unitLabels.attention")} />
        )}
        <DefinitionGrid
          items={[
            { id: "sent", term: t("office.shiftCard.unitLabels.sent"), value: figures.sent },
            {
              id: "verified",
              term: t("office.shiftCard.unitLabels.verified"),
              value: figures.verified,
            },
            {
              id: "skipped",
              term: t("office.shiftCard.unitLabels.skipped"),
              value: figures.skipped,
            },
            {
              id: "unresolved",
              term: t("office.shiftCard.unitLabels.unresolved"),
              value: figures.unresolved,
            },
            {
              id: "reprints",
              term: t("office.shiftCard.unitLabels.reprints"),
              value: figures.reprints,
            },
          ].map(({ id, term, value }) => ({
            id,
            term,
            description: UNITS.format(value),
            mono: true,
          }))}
        />
      </Card>
    </section>
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
  const [params] = useSearchParams();
  // An older link of a conflict names the loser's box here (plan КНФ); the box's card has it now.
  const [tail, setTail] = useState(() => ssccTail(params.get("box") ?? ""));
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
    return <PalletLinkOrOpen id={pallet.id} sscc={pallet.sscc} />;
  };

  const columns: TableColumn<OfficeBox>[] = [
    {
      key: "sscc",
      title: t("office.shiftCard.boxes.sscc"),
      mono: true,
      render: (box) => <BoxLink id={box.id} sscc={box.sscc} />,
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
    return (
      <>
        <p className="office-note" aria-live="polite">
          {t("office.shiftCard.boxes.found", { shown: kept.length, total: boxes.data.length })}
        </p>
        <PagedTable
          tableId="shift-boxes"
          pagerLabel={t("office.shiftCard.boxes.pager")}
          resetKey={`${tail}`}
          columns={columns}
          rows={kept}
          getRowKey={(box) => box.id}
          empty={t(
            boxes.data.length === 0
              ? "office.shiftCard.boxes.empty"
              : "office.shiftCard.boxes.none",
          )}
          scrollLabel={t("office.shiftCard.boxes.table")}
        />
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
      render: (pallet) => <PalletLink id={pallet.id} sscc={pallet.sscc} />,
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
          <PagedTable
            tableId="shift-pallets"
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
  // a pallet's count by `PalletCountTag`, which leaves a pallet taken apart out and tells a
  // disassembly's difference from a real one.
  const boxMismatch = "digestMatches" in pack && state === "closed" && pack.digestMatches === false;
  return (
    <span className="shift-cell">
      <StatusChip phase={PACK_PHASE[state]} label={t(`office.shiftCard.${kind}State.${state}`)} />
      {state === "disassembled" && (
        <span className="shift-cell__quiet">
          {t("office.shiftCard.disassembledAt", { at: at(pack.disassembledAt) })}
        </span>
      )}
      {boxMismatch && (
        <StatusChip phase="attention" wrap label={t("office.shiftCard.boxMismatch")} />
      )}
      {"digestMatches" in pack ? null : (
        <PalletCountTag pallet={pack} differsLabel={t("office.shiftCard.palletMismatch")} />
      )}
      {late && <StatusChip phase="attention" wrap label={t("office.shiftCard.lateBox")} />}
    </span>
  );
}
