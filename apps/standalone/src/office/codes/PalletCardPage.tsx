import type { PlacardFormat } from "@markiro/domain";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";

import {
  Button,
  Card,
  DefinitionGrid,
  EmptyState,
  PageHeader,
  RowActions,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";

import {
  CARD_ROW_LIMIT,
  type OfficePalletBox,
  type OfficePalletCard,
} from "../../host/pack-cards.js";
import { CardFiles } from "../exports/CardFiles.js";
import { hasPlacard } from "../forms/form-data.js";
import { PrintFormDialog, type FormTarget } from "../forms/PrintFormDialog.js";
import { formTimeZone } from "../forms/render-form.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { civilDateLabel } from "../shifts/shift-list.js";
import { labelState, packState, palletCountDiffers, ssccText } from "../shifts/shift-card.js";
import { instantFormat, ShiftLink } from "./CodeCard.js";
import { CardBack, isNotFound } from "./BoxCardPage.js";
import { usePackDisassembly } from "./PackDisassembly.js";
import { PackDocuments } from "./PackDocuments.js";
import { BoxLink, PackStateChip } from "./PackLinks.js";

/** The export dialog is a chunk of its own, read when «XML паллеты» is first pressed. */
const ExportDialog = lazy(() =>
  import("../exports/ExportDialog.js").then((module) => ({ default: module.ExportDialog })),
);

/** Counts with the thousands apart by a no-break space: «1 200». */
const COUNT = new Intl.NumberFormat("ru");

/**
 * The card of a pallet (plan КРТ, the cloud's pallet card): where it stands,
 * every box that joined it (the ones taken apart stay on the list), the
 * station's count against what stands now, the station's exceptions, and
 * its forms: «Состав паллеты», «Ярлык паллеты» on A4 or A5 and the pallet's
 * «XML паллеты».
 */
export function PalletCardPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const [form, setForm] = useState<FormTarget | null>(null);
  const [exporting, setExporting] = useState(false);
  const [paper, setPaper] = useState<PlacardFormat>("a4");
  const card = useOfficeQuery(officeKeys.palletCard(id), (api, token) =>
    api.getPalletCard(token, id),
  );
  const shiftId = card.data?.shift.id ?? "";
  const shift = useOfficeQuery(
    officeKeys.shift(shiftId),
    (api, token) => api.getShift(token, shiftId),
    { enabled: card.isSuccess },
  );
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const disassembly = usePackDisassembly({
    sscc: card.data?.sscc ?? null,
    closed: card.data?.closedAt != null,
    disassembled: card.data?.disassembledAt != null,
    shiftStatus: card.data?.shift.status ?? "planned",
  });
  const zone = formTimeZone(org.data);
  const format = instantFormat(zone);
  const at = (instant: string | null) =>
    instant === null ? t("office.common.none") : format(instant);

  if (card.isPending) {
    return (
      <>
        <CardBack />
        <PageLoading />
      </>
    );
  }
  if (card.isError) {
    return (
      <>
        <CardBack />
        {isNotFound(card.error) ? (
          <EmptyState
            title={t("office.palletCard.notFound")}
            hint={t("office.palletCard.notFoundHint")}
          />
        ) : (
          <LoadError error={card.error} onRetry={() => void card.refetch()} />
        )}
      </>
    );
  }
  const pallet = card.data;
  const label = pallet.sscc === null ? t("office.palletCard.noSscc") : ssccText(pallet.sscc);
  const state = packState(pallet);
  const labelCheck = pallet.closedAt === null ? "none" : labelState(pallet);
  const ready = shift.data !== undefined;
  const xml = pallet.closedAt !== null && pallet.sscc !== null && shift.data?.status !== "planned";

  return (
    <div className="office-stack">
      <CardBack />
      <PageHeader
        title={t("office.palletCard.title", { label })}
        actions={
          <RowActions>
            <Button
              variant="secondary"
              disabled={!ready}
              onClick={() => setForm({ kind: "pallet", palletId: pallet.id, label })}
            >
              {t("office.palletCard.contents")}
            </Button>
            {hasPlacard(pallet) && (
              <Button
                variant="secondary"
                disabled={!ready}
                onClick={() => setForm({ kind: "placard", palletId: pallet.id, label })}
              >
                {t("office.palletCard.placard")}
              </Button>
            )}
            {xml && (
              <Button variant="secondary" disabled={!ready} onClick={() => setExporting(true)}>
                {t("office.palletCard.xml")}
              </Button>
            )}
            {disassembly.button}
          </RowActions>
        }
      />
      {disassembly.notice}
      <div className="shift-cell">
        <PackStateChip state={state} kind="pallet" />
        {palletCountDiffers(pallet) && (
          <StatusChip phase="attention" wrap label={t("office.palletCard.changedAfterClose")} />
        )}
        {pallet.disassembledAt !== null && (
          <span className="shift-cell__quiet">
            {t("office.palletCard.disassembledAt", { at: at(pallet.disassembledAt) })}
          </span>
        )}
      </div>
      <DefinitionGrid
        items={[
          {
            id: "product",
            term: t("office.palletCard.product"),
            description: pallet.shift.productName,
          },
          {
            id: "shift",
            term: t("office.palletCard.shift"),
            description: (
              <ShiftLink item={{ shiftId: pallet.shift.id, shiftNumber: pallet.shift.number }} />
            ),
          },
          {
            id: "productionDate",
            term: t("office.palletCard.productionDate"),
            description: civilDateLabel(pallet.shift.productionDate),
            mono: true,
          },
          { id: "line", term: t("office.palletCard.line"), description: pallet.shift.lineName },
          { id: "station", term: t("office.palletCard.station"), description: pallet.deviceName },
          {
            id: "operator",
            term: t("office.palletCard.operator"),
            description: pallet.operatorName ?? t("office.common.none"),
          },
          {
            id: "openedAt",
            term: t("office.palletCard.openedAt"),
            description: at(pallet.openedAt),
          },
          {
            id: "closedAt",
            term: t("office.palletCard.closedAt"),
            description: at(pallet.closedAt),
          },
          {
            id: "boxes",
            term: t("office.palletCard.boxes"),
            description:
              state === "disassembled" ? t("office.common.none") : COUNT.format(pallet.boxes),
            mono: true,
          },
          {
            id: "reported",
            term: t("office.palletCard.reported"),
            description:
              pallet.boxCountReported === null
                ? t("office.common.none")
                : COUNT.format(pallet.boxCountReported),
            mono: true,
          },
          {
            id: "units",
            term: t("office.palletCard.units"),
            description:
              state === "disassembled" ? t("office.common.none") : COUNT.format(pallet.units),
            mono: true,
          },
          {
            id: "label",
            term: t("office.palletCard.label"),
            description: t(`office.shiftCard.label.${labelCheck}`),
          },
        ]}
      />
      <PalletMembers card={pallet} at={at} />
      <PalletExceptions card={pallet} at={at} receivedAt={format} />
      <PackDocuments documents={pallet.documents} at={at} />
      <CardFiles targetType="pallet" targetId={pallet.id} label={label} at={at} timeZone={zone} />
      {form !== null && shift.data !== undefined && (
        <PrintFormDialog
          shift={shift.data}
          target={form}
          taskInputs={null}
          timeZone={zone}
          format={paper}
          onFormat={setPaper}
          onClose={() => setForm(null)}
        />
      )}
      {exporting && shift.data !== undefined && (
        <Suspense fallback={null}>
          <ExportDialog
            shift={shift.data}
            palletId={pallet.id}
            onClose={() => setExporting(false)}
          />
        </Suspense>
      )}
    </div>
  );
}

function PalletMembers({
  card,
  at,
}: {
  card: OfficePalletCard;
  at: (instant: string | null) => string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const columns: TableColumn<OfficePalletBox>[] = [
    {
      key: "sscc",
      title: t("office.palletCard.members.sscc"),
      mono: true,
      render: (box) => <BoxLink id={box.id} sscc={box.sscc} />,
    },
    {
      key: "units",
      title: t("office.palletCard.members.units"),
      mono: true,
      align: "right",
      render: (box) => COUNT.format(box.units),
    },
    {
      key: "closedAt",
      title: t("office.palletCard.members.closedAt"),
      wrap: true,
      minWidth: 150,
      render: (box) => at(box.closedAt),
    },
    {
      key: "state",
      title: t("office.palletCard.members.state"),
      wrap: true,
      minWidth: 180,
      render: (box) => (
        <span className="shift-cell">
          <PackStateChip state={packState(box)} kind="box" />
          {box.disassembledAt !== null && (
            <span className="shift-cell__quiet">{t("office.palletCard.members.disassembled")}</span>
          )}
        </span>
      ),
    },
  ];
  return (
    <section className="shift-card__section" aria-labelledby="pallet-members">
      <h2 id="pallet-members">{t("office.palletCard.members.title")}</h2>
      <Card>
        <Table
          columns={columns}
          rows={card.members}
          getRowKey={(box) => box.id}
          onRowClick={(box) => void navigate(`/codes/box/${box.id}`)}
          empty={t("office.palletCard.members.empty")}
          scrollLabel={t("office.palletCard.members.table")}
        />
        {card.membersCapped && (
          <p className="office-note">
            {t("office.palletCard.members.capped", { limit: COUNT.format(CARD_ROW_LIMIT) })}
          </p>
        )}
      </Card>
    </section>
  );
}

function PalletExceptions({
  card,
  at,
  receivedAt,
}: {
  card: OfficePalletCard;
  at: (instant: string | null) => string;
  receivedAt: (instant: string) => string;
}) {
  const { t } = useTranslation();
  return (
    <section className="shift-card__section" aria-labelledby="pallet-exceptions">
      <h2 id="pallet-exceptions">{t("office.palletCard.exceptions")}</h2>
      {card.exceptions.length === 0 ? (
        <p className="office-note">{t("office.palletCard.noExceptions")}</p>
      ) : (
        <ol className="shift-card__section">
          {card.exceptions.map((exception) => {
            const reason =
              exception.reasonText ??
              t(`floor.exceptions.reasons.${exception.kind}.${exception.reasonCode}`, {
                defaultValue: exception.reasonCode,
              });
            return (
              <li key={exception.id} className="shift-cell">
                <span>
                  <span className="font-mono">{at(exception.occurredAt)}</span>
                  {" — "}
                  {t(`office.palletCard.exceptionKind.${exception.kind}`)}
                  {` (${t("office.palletCard.exceptionReason", { reason })})`}
                </span>
                <span className="shift-cell__quiet">
                  {[
                    exception.deviceName,
                    exception.operatorName,
                    t("office.palletCard.receivedAt", { at: receivedAt(exception.receivedAt) }),
                  ]
                    .filter((part) => part !== null)
                    .join(" · ")}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
