import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { DefinitionGrid, StatusChip, type TableColumn, type TagPhase } from "@markiro/ui";

import type {
  CodePlacementState,
  OfficeCodeCard,
  OfficeCodeEvent,
  OfficeCodeItem,
} from "../../host/code-search.js";
import { PagedTable } from "../paging/PagedTable.js";
import { shiftCardPath, ssccText } from "../shifts/shift-card.js";
import { PackTextLink } from "./PackLinks.js";

/**
 * A placement's state in its phase: a code taken out is retired, one taken elsewhere wants a
 * look; a validation shift's accepted code (no box, plan РЕЖ) is done, as a packed one.
 */
export const PLACEMENT_PHASE = {
  open_box: "active",
  packed: "done",
  removed: "retired",
  displaced: "attention",
  checked: "done",
} as const satisfies Record<CodePlacementState, TagPhase>;

/** An instant the host reported, in the organization's zone, to the second. */
export type FormatInstant = (instant: string) => string;

export function instantFormat(zone: string): FormatInstant {
  const format = new Intl.DateTimeFormat("ru", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: zone,
  });
  return (instant) => format.format(new Date(instant));
}

/** A code as people read it: its GTIN and serial with their AIs, no crypto tail. */
export function codeText(item: Pick<OfficeCodeItem, "gtin14" | "serial">): string {
  return `01${item.gtin14}21${item.serial}`;
}

/** The full text a station kept, its group separators shown, since they print as nothing. */
export function canonicalText(canonical: string): string {
  return canonical.replaceAll("\u001d", "<GS>");
}

export function PlacementChip({ state }: { state: CodePlacementState }) {
  const { t } = useTranslation();
  return (
    <StatusChip phase={PLACEMENT_PHASE[state]} label={t(`office.codeSearch.state.${state}`)} />
  );
}

/**
 * A box as a row names it: its SSCC, or that it is open, and that it was taken apart; «—» for a
 * validation shift's scan, which has no box.
 */
export function boxLabel(item: OfficeCodeItem, t: TFunction): string {
  if (item.boxId === null) return t("office.common.none");
  const sscc = item.boxSscc === null ? t("office.codeSearch.openBox") : ssccText(item.boxSscc);
  return item.boxDisassembledAt === null
    ? sscc
    : t("office.codeSearch.disassembled", { what: sscc });
}

/**
 * A scan's box: a link to the box's card, or just «—» for a validation shift's scan, which has
 * no box and so no card to open (a link built from its null id would be dead).
 */
function BoxText({ item }: { item: OfficeCodeItem }) {
  const { t } = useTranslation();
  const label = boxLabel(item, t);
  return item.boxId === null ? (
    <>{label}</>
  ) : (
    <PackTextLink kind="box" id={item.boxId}>
      {label}
    </PackTextLink>
  );
}

export function palletLabel(item: OfficeCodeItem, t: TFunction): string {
  if (item.palletId === null) return t("office.common.none");
  const sscc =
    item.palletSscc === null ? t("office.codeSearch.openPallet") : ssccText(item.palletSscc);
  return item.palletDisassembledAt === null
    ? sscc
    : t("office.codeSearch.disassembled", { what: sscc });
}

/** The link to a shift's card, which a row's click does not also open. */
export function ShiftLink({ item }: { item: Pick<OfficeCodeItem, "shiftId" | "shiftNumber"> }) {
  return (
    <Link to={shiftCardPath(item.shiftId)} onClick={(event) => event.stopPropagation()}>
      {item.shiftNumber}
    </Link>
  );
}

function eventText(event: OfficeCodeEvent, t: TFunction): string {
  switch (event.type) {
    case "scan": {
      const verdict = t(`office.codeSearch.verdict.${event.verdict}`);
      // The earlier scan that took the code may be a validation shift's, in no box (plan
      // РЕЖ): the event does not say, so neither does the text.
      if (event.verdict === "ok" && !event.placed) {
        return t("office.codeSearch.event.scanLost", { verdict });
      }
      if (event.verdict === "duplicate" && event.duplicateSource !== null) {
        return t(`office.codeSearch.event.duplicate.${event.duplicateSource}`);
      }
      return t("office.codeSearch.event.scan", { verdict });
    }
    case "removed": {
      const kind =
        event.exception === null
          ? t("office.codeSearch.event.removedUnknown")
          : t(`office.codeSearch.exception.${event.exception}`);
      const reason =
        event.reasonText ??
        (event.reasonCode === null
          ? null
          : t(`floor.exceptions.reasons.disassemble.${event.reasonCode}`, {
              defaultValue: event.reasonCode,
            }));
      return reason === null ? kind : t("office.codeSearch.event.withReason", { kind, reason });
    }
    case "displaced":
      return t(
        event.boxId === null
          ? "office.codeSearch.event.displacedUnboxed"
          : "office.codeSearch.event.displaced",
      );
    case "reprint":
      return t("office.codeSearch.event.reprint", {
        outcome: t(`office.codeSearch.reprintOutcome.${event.outcome}`, {
          defaultValue: event.outcome,
        }),
        reason: t(`floor.warehouse.reasons.${event.reasonCode}`, {
          defaultValue: event.reasonCode,
        }),
      });
  }
}

/** Where, by whom and on what an event happened, on its quieter line. */
function eventWhere(event: OfficeCodeEvent, t: TFunction): string {
  const parts: string[] = [];
  if (event.type === "scan") {
    parts.push(t("office.codeSearch.event.shift", { number: event.shiftNumber }));
    parts.push(event.deviceName);
  }
  if (event.type === "removed" || (event.type === "displaced" && event.boxId !== null)) {
    parts.push(
      event.boxSscc === null
        ? t("office.codeSearch.event.openBox")
        : t("office.codeSearch.event.box", { sscc: ssccText(event.boxSscc) }),
    );
  }
  if (event.type === "reprint") parts.push(event.deviceName);
  if (event.type === "removed" && event.documentNo !== null) {
    parts.push(t("office.codeSearch.event.document", { docNo: event.documentNo }));
  }
  if ("operatorName" in event && event.operatorName !== null) parts.push(event.operatorName);
  if (event.type === "removed" && event.officeUserName !== null) parts.push(event.officeUserName);
  return parts.join(" · ");
}

export interface CodeCardViewProps {
  card: OfficeCodeCard;
  format: FormatInstant;
  /** The heading level of the card's parts: under a page's `h1`, or a drawer's `h2`. */
  headingLevel: "h2" | "h3";
  /** Unified registry renders identity and ownership across both sources once. */
  showSummary?: boolean;
}

/**
 * A code's card: what it is, where it is now, every box it was put into and
 * its history, as the host's facts tell them.
 */
export function CodeCardView({
  card,
  format,
  headingLevel: Heading,
  showSummary = true,
}: CodeCardViewProps) {
  const { t } = useTranslation();
  const owner = card.placements.find((placement) => placement.scanId === card.ownerScanId);
  const columns: TableColumn<OfficeCodeItem>[] = [
    {
      key: "scannedAt",
      title: t("office.codeSearch.table.scannedAt"),
      mono: true,
      render: (item) => format(item.scannedAt),
    },
    {
      key: "state",
      title: t("office.codeSearch.table.state"),
      render: (item) => <PlacementChip state={item.state} />,
    },
    {
      key: "box",
      title: t("office.codeSearch.table.box"),
      mono: true,
      render: (item) => <BoxText item={item} />,
    },
    {
      key: "pallet",
      title: t("office.codeSearch.table.pallet"),
      mono: true,
      render: (item) =>
        item.palletId === null ? (
          palletLabel(item, t)
        ) : (
          <PackTextLink
            kind={item.palletKind === "warehouse" ? "warehouse-pallet" : "pallet"}
            id={item.palletId}
          >
            {palletLabel(item, t)}
          </PackTextLink>
        ),
    },
    {
      key: "shift",
      title: t("office.codeSearch.table.shift"),
      render: (item) => <ShiftLink item={item} />,
    },
    { key: "lineName", title: t("office.codeSearch.table.line") },
    { key: "deviceName", title: t("office.codeSearch.table.device") },
    {
      key: "operatorName",
      title: t("office.codeSearch.table.operator"),
      render: (item) => item.operatorName ?? t("office.common.none"),
    },
  ];
  return (
    <div className="office-stack">
      {showSummary && (
        <DefinitionGrid
          items={[
            {
              id: "code",
              term: t("office.codeSearch.card.code"),
              description: codeText(card),
              mono: true,
            },
            {
              id: "canonical",
              term: t("office.codeSearch.card.canonical"),
              description: canonicalText(card.canonical),
              mono: true,
            },
            {
              id: "product",
              term: t("office.codeSearch.card.product"),
              description:
                owner?.productName ?? card.placements[0]?.productName ?? t("office.common.none"),
            },
            {
              id: "now",
              term: t("office.codeSearch.card.now"),
              description:
                owner === undefined ? (
                  t("office.codeSearch.card.free")
                ) : (
                  <span className="shift-cell">
                    <PlacementChip state={owner.state} />
                    <span className="shift-cell__quiet">
                      <BoxText item={owner} />
                    </span>
                  </span>
                ),
            },
          ]}
        />
      )}
      <section className="shift-card__section">
        <Heading>{t("office.codeSearch.card.placements")}</Heading>
        <PagedTable
          tableId="code-card-placements"
          columns={columns}
          rows={card.placements}
          getRowKey={(item) => item.scanId}
          empty={t("office.codeSearch.card.noPlacements")}
          scrollLabel={t("office.codeSearch.card.placements")}
        />
      </section>
      <section className="shift-card__section">
        <Heading>{t("office.codeSearch.card.history")}</Heading>
        <ol className="shift-card__section">
          {card.events.map((event, index) => (
            <li key={`${event.type}-${event.at}-${index}`} className="shift-cell">
              <span>
                <span className="font-mono">{format(event.at)}</span> — {eventText(event, t)}
              </span>
              <span className="shift-cell__quiet">{eventWhere(event, t)}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
