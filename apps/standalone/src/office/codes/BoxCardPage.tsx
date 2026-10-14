import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

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

import { HostError } from "../../host/client.js";
import {
  CARD_ROW_LIMIT,
  type OfficeBoxCard,
  type OfficeBoxException,
  type OfficeBoxItem,
} from "../../host/pack-cards.js";
import { CardFiles } from "../exports/CardFiles.js";
import { PrintFormDialog } from "../forms/PrintFormDialog.js";
import { formTimeZone } from "../forms/render-form.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { labelState, packState, ssccText } from "../shifts/shift-card.js";
import { civilDateLabel } from "../shifts/shift-list.js";
import {
  codeText,
  instantFormat,
  PlacementChip,
  ShiftLink,
  type FormatInstant,
} from "./CodeCard.js";
import { useBackToRegistry } from "./CodesSection.js";
import { usePackDisassembly } from "./PackDisassembly.js";
import { PackDocuments } from "./PackDocuments.js";
import { PackStateChip, PalletLinkOrOpen } from "./PackLinks.js";

/** Counts with the thousands apart by a no-break space: «1 200». */
const COUNT = new Intl.NumberFormat("ru");

export function isNotFound(error: unknown): boolean {
  // An address that is no id never reached the host (`getBoxCard` refuses it): it names nothing here.
  return error instanceof RangeError || (error instanceof HostError && error.code === "not_found");
}

/** «Назад» of a card: the page before, else the last part of «Поиск кодов». */
export function CardBack() {
  const { t } = useTranslation();
  const back = useBackToRegistry();
  return (
    <Link className="shift-card__back" to={back.href} onClick={back.onClick}>
      {t("office.boxCard.back")}
    </Link>
  );
}

/**
 * The card of a box (plan КРТ, the cloud's box card without its sales): where
 * it stands (shift, pallet, station, operator), every code it ever had with
 * where each stands now, and the station's exceptions on it. A code is its
 * GTIN and serial with a link to its own card, whose full text it keeps.
 */
export function BoxCardPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const [printing, setPrinting] = useState(false);
  const card = useOfficeQuery(officeKeys.boxCard(id), (api, token) => api.getBoxCard(token, id));
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
            title={t("office.boxCard.notFound")}
            hint={t("office.boxCard.notFoundHint")}
          />
        ) : (
          <LoadError error={card.error} onRetry={() => void card.refetch()} />
        )}
      </>
    );
  }
  const box = card.data;
  const label = box.sscc === null ? t("office.boxCard.noSscc") : ssccText(box.sscc);
  const state = packState(box);
  const labelCheck = box.closedAt === null ? "none" : labelState(box);

  return (
    <div className="office-stack">
      <CardBack />
      <PageHeader
        title={t("office.boxCard.title", { label })}
        actions={
          <RowActions>
            <Button
              variant="secondary"
              disabled={shift.data === undefined}
              onClick={() => setPrinting(true)}
            >
              {t("office.boxCard.contents")}
            </Button>
            {disassembly.button}
          </RowActions>
        }
      />
      {disassembly.notice}
      <div className="shift-cell">
        <PackStateChip state={state} kind="box" />
        {state === "closed" && box.digestMatches === false && (
          <StatusChip phase="attention" wrap label={t("office.shiftCard.boxMismatch")} />
        )}
        {box.disassembledAt !== null && (
          <span className="shift-cell__quiet">
            {t("office.boxCard.disassembledAt", { at: at(box.disassembledAt) })}
          </span>
        )}
      </div>
      <DefinitionGrid
        items={[
          { id: "product", term: t("office.boxCard.product"), description: box.shift.productName },
          {
            id: "shift",
            term: t("office.boxCard.shift"),
            description: (
              <ShiftLink item={{ shiftId: box.shift.id, shiftNumber: box.shift.number }} />
            ),
          },
          {
            id: "productionDate",
            term: t("office.boxCard.productionDate"),
            description: civilDateLabel(box.shift.productionDate),
            mono: true,
          },
          { id: "line", term: t("office.boxCard.line"), description: box.shift.lineName },
          { id: "station", term: t("office.boxCard.station"), description: box.deviceName },
          {
            id: "operator",
            term: t("office.boxCard.operator"),
            description: box.operatorName ?? t("office.common.none"),
          },
          { id: "openedAt", term: t("office.boxCard.openedAt"), description: at(box.openedAt) },
          { id: "closedAt", term: t("office.boxCard.closedAt"), description: at(box.closedAt) },
          {
            id: "pallet",
            term: t("office.boxCard.pallet"),
            description:
              box.pallet === null ? (
                t("office.common.none")
              ) : (
                <PalletLinkOrOpen id={box.pallet.id} sscc={box.pallet.sscc} />
              ),
          },
          {
            id: "units",
            term: t("office.boxCard.units"),
            description: COUNT.format(box.units),
            mono: true,
          },
          {
            id: "reported",
            term: t("office.boxCard.reported"),
            description:
              box.itemCountReported === null
                ? t("office.common.none")
                : COUNT.format(box.itemCountReported),
            mono: true,
          },
          {
            id: "label",
            term: t("office.boxCard.label"),
            description: t(`office.shiftCard.label.${labelCheck}`),
          },
        ]}
      />
      <BoxItems card={box} at={at} />
      <BoxExceptions card={box} at={at} format={format} />
      <PackDocuments documents={box.documents} at={at} />
      <CardFiles targetType="box" targetId={box.id} label={label} at={at} timeZone={zone} />
      {printing && shift.data !== undefined && (
        <PrintFormDialog
          shift={shift.data}
          target={{ kind: "box", boxId: box.id, label }}
          taskInputs={null}
          timeZone={zone}
          format="a4"
          onFormat={() => undefined}
          onClose={() => setPrinting(false)}
        />
      )}
    </div>
  );
}

function BoxItems({ card, at }: { card: OfficeBoxCard; at: (instant: string | null) => string }) {
  const { t } = useTranslation();
  // An item the box's applied document took out left at the instant the box was taken apart.
  const byDocument = (item: OfficeBoxItem): string | null =>
    item.state === "removed" && card.disassembledAt !== null && item.leftAt === card.disassembledAt
      ? (card.documents[0]?.docNo ?? null)
      : null;
  const columns: TableColumn<OfficeBoxItem>[] = [
    {
      key: "code",
      title: t("office.boxCard.items.code"),
      mono: true,
      render: (item) => (
        <Link
          to={`/codes?codeHash=${item.codeHash}`}
          aria-label={t("office.boxCard.items.openNamed", { code: codeText(item) })}
        >
          {codeText(item)}
        </Link>
      ),
    },
    {
      key: "addedAt",
      title: t("office.boxCard.items.addedAt"),
      wrap: true,
      minWidth: 150,
      render: (item) => at(item.addedAt),
    },
    {
      key: "state",
      title: t("office.boxCard.items.state"),
      render: (item) => (
        <span className="shift-cell">
          <PlacementChip state={item.state} />
          {byDocument(item) !== null && (
            <span className="shift-cell__quiet">
              {t("office.packs.documents.byDocument", { docNo: byDocument(item) ?? "" })}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "leftAt",
      title: t("office.boxCard.items.leftAt"),
      wrap: true,
      minWidth: 150,
      render: (item) => at(item.leftAt),
    },
    {
      key: "operator",
      title: t("office.boxCard.items.operator"),
      render: (item) => item.operatorName ?? t("office.common.none"),
    },
  ];
  return (
    <section className="shift-card__section" aria-labelledby="box-items">
      <h2 id="box-items">{t("office.boxCard.items.title")}</h2>
      <Card>
        <Table
          columns={columns}
          rows={card.items}
          getRowKey={(item) => item.scanId}
          empty={t("office.boxCard.items.empty")}
          scrollLabel={t("office.boxCard.items.table")}
        />
        {card.itemsCapped && (
          <p className="office-note">
            {t("office.boxCard.items.capped", { limit: COUNT.format(CARD_ROW_LIMIT) })}
          </p>
        )}
      </Card>
    </section>
  );
}

function reasonText(
  kind: "reprint" | "disassemble",
  code: string | null,
  text: string | null,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  if (text !== null) return text;
  if (code === null) return null;
  return t(`floor.exceptions.reasons.${kind}.${code}`, { defaultValue: code });
}

function BoxExceptions({
  card,
  at,
  format,
}: {
  card: OfficeBoxCard;
  at: (instant: string | null) => string;
  format: FormatInstant;
}) {
  const { t } = useTranslation();
  const codeOf = (exception: OfficeBoxException): string | null => {
    const item = card.items.find((each) => each.codeHash === exception.codeHash);
    return item === undefined ? null : codeText(item);
  };
  return (
    <section className="shift-card__section" aria-labelledby="box-exceptions">
      <h2 id="box-exceptions">{t("office.boxCard.exceptions")}</h2>
      {card.exceptions.length === 0 ? (
        <p className="office-note">{t("office.boxCard.noExceptions")}</p>
      ) : (
        <ol className="shift-card__section">
          {card.exceptions.map((exception) => {
            const code = codeOf(exception);
            const reason =
              exception.kind === "reprint" || exception.kind === "disassemble"
                ? reasonText(exception.kind, exception.reasonCode, exception.reasonText, t)
                : null;
            return (
              <li key={exception.id} className="shift-cell">
                <span>
                  <span className="font-mono">{at(exception.occurredAt)}</span>
                  {" — "}
                  {t(`office.boxCard.exceptionKind.${exception.kind}`)}
                  {code !== null && ` (${t("office.boxCard.exceptionCode", { code })})`}
                  {reason !== null && ` (${t("office.boxCard.exceptionReason", { reason })})`}
                </span>
                <span className="shift-cell__quiet">
                  {[
                    exception.deviceName,
                    exception.operatorName,
                    t("office.boxCard.receivedAt", { at: format(exception.receivedAt) }),
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
