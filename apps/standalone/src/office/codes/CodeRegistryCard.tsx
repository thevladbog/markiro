import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { DefinitionGrid, StatusChip, type TableColumn } from "@markiro/ui";

import type {
  CloudCodeItem,
  CodeRegistryCard,
  CodeRegistryItem,
} from "../../host/code-registry.js";
import { isSupportedHistoryTimeZone } from "../import/history-time-zone.js";
import { PagedTable } from "../paging/PagedTable.js";
import { ssccText } from "../shifts/shift-card.js";
import {
  canonicalText,
  CodeCardView,
  codeText,
  instantFormat,
  PlacementChip,
  ShiftLink,
  type FormatInstant,
} from "./CodeCard.js";

export function registryKey(row: CodeRegistryItem): string {
  return row.source === "local" ? `local:${row.item.scanId}` : `cloud:${row.item.id}`;
}

export function registryCodeText(row: CodeRegistryItem): string {
  if (row.item.gtin14 !== null && row.item.serial !== null)
    return codeText({
      gtin14: row.item.gtin14,
      serial: row.item.serial,
    });
  return row.source === "cloud" && row.item.canonical !== null
    ? canonicalText(row.item.canonical)
    : row.item.codeHash;
}

export function SourceChip({ source }: { source: CodeRegistryItem["source"] }) {
  const { t } = useTranslation();
  return <StatusChip phase="none" label={t(`office.codeSearch.sources.${source}`)} />;
}

export function RegistryState({ row }: { row: CodeRegistryItem }) {
  const { t } = useTranslation();
  if (row.source === "local") return <PlacementChip state={row.item.state} />;
  return (
    <StatusChip
      phase={row.item.state === "owned" ? "done" : "retired"}
      label={t(`office.codeSearch.cloud.state.${row.item.state}`)}
    />
  );
}

export function RegistryShift({ row }: { row: CodeRegistryItem }) {
  if (row.source === "local") return <ShiftLink item={row.item} />;
  return row.item.shiftAvailable ? (
    <Link to={`/cloud-shifts/${row.item.shiftId}`} onClick={(event) => event.stopPropagation()}>
      {row.item.shiftNumber}
    </Link>
  ) : (
    <>{row.item.shiftNumber}</>
  );
}

/** A frozen source instant is never silently rendered in today's organization zone. */
export function cloudInstant(row: CloudCodeItem, at = row.scannedAt): string {
  const original = `${at} (${row.sourceTimeZone})`;
  return isSupportedHistoryTimeZone(row.sourceTimeZone)
    ? `${instantFormat(row.sourceTimeZone)(at)} (${row.sourceTimeZone})`
    : original;
}

export function CloudPack({ item, kind }: { item: CloudCodeItem; kind: "box" | "pallet" }) {
  const { t } = useTranslation();
  const id = kind === "box" ? item.boxId : item.palletId;
  if (id === null) return <>{t("office.common.none")}</>;
  const available = kind === "box" ? item.boxAvailable : item.palletAvailable;
  const sscc = kind === "box" ? item.boxSscc : item.palletSscc;
  const disassembledAt = kind === "box" ? item.boxDisassembledAt : item.palletDisassembledAt;
  const base =
    sscc !== null
      ? ssccText(sscc)
      : t(`office.codeSearch.cloud.${available ? "withoutSscc" : "externalPack"}`);
  const label =
    disassembledAt === null ? base : t("office.codeSearch.disassembled", { what: base });
  return available ? (
    <Link
      to={`/cloud-${kind === "box" ? "boxes" : "pallets"}/${id}`}
      onClick={(event) => event.stopPropagation()}
    >
      {label}
    </Link>
  ) : (
    <>{label}</>
  );
}

function cloudColumns(t: TFunction): TableColumn<CloudCodeItem>[] {
  return [
    {
      key: "scannedAt",
      title: t("office.codeSearch.table.scannedAt"),
      render: (item) => cloudInstant(item),
    },
    {
      key: "state",
      title: t("office.codeSearch.table.state"),
      render: (item) => <RegistryState row={{ source: "cloud", item }} />,
    },
    {
      key: "shift",
      title: t("office.codeSearch.table.shift"),
      render: (item) => <RegistryShift row={{ source: "cloud", item }} />,
    },
    {
      key: "productName",
      title: t("office.codeSearch.table.product"),
      render: (item) => item.productName ?? t("office.common.none"),
    },
    {
      key: "box",
      title: t("office.codeSearch.table.box"),
      render: (item) => <CloudPack item={item} kind="box" />,
    },
    {
      key: "pallet",
      title: t("office.codeSearch.table.pallet"),
      render: (item) => <CloudPack item={item} kind="pallet" />,
    },
    {
      key: "releasedAt",
      title: t("office.codeSearch.cloud.releasedAt"),
      render: (item) =>
        item.releasedAt === null ? t("office.common.none") : cloudInstant(item, item.releasedAt),
    },
  ];
}

export function CodeRegistryCardView({
  card,
  format,
  headingLevel: Heading,
}: {
  card: CodeRegistryCard;
  format: FormatInstant;
  headingLevel: "h2" | "h3";
}) {
  const { t } = useTranslation();
  const owner = card.currentOwner;
  const identity = [owner?.item, card.local, ...card.cloud].find(
    (item) => item != null && item.gtin14 !== null && item.serial !== null,
  );
  const text =
    identity?.gtin14 != null && identity.serial !== null
      ? codeText({ gtin14: identity.gtin14, serial: identity.serial })
      : card.codeHash;
  const canonical =
    card.local?.canonical ??
    (owner?.source === "cloud" ? owner.item.canonical : null) ??
    card.cloud.find((row) => row.canonical !== null)?.canonical;
  return (
    <div className="office-stack">
      <DefinitionGrid
        items={[
          { id: "code", term: t("office.codeSearch.card.code"), description: text, mono: true },
          {
            id: "canonical",
            term: t("office.codeSearch.card.canonical"),
            description:
              canonical == null ? t("office.codeSearch.cloud.unknown") : canonicalText(canonical),
            mono: true,
          },
          {
            id: "product",
            term: t("office.codeSearch.card.product"),
            description:
              owner?.item.productName ??
              card.local?.placements[0]?.productName ??
              card.cloud[0]?.productName ??
              t("office.common.none"),
          },
          {
            id: "now",
            term: t("office.codeSearch.card.now"),
            description:
              owner === null ? (
                t("office.codeSearch.card.free")
              ) : (
                <span className="shift-cell">
                  <SourceChip source={owner.source} />
                  <RegistryState row={owner} />
                  <RegistryShift row={owner} />
                </span>
              ),
          },
        ]}
      />
      {card.local !== null && (
        <CodeCardView
          card={card.local}
          format={format}
          headingLevel={Heading}
          showSummary={false}
        />
      )}
      {card.cloud.length > 0 && (
        <section className="shift-card__section">
          <Heading>{t("office.codeSearch.cloud.title")}</Heading>
          <p className="office-note">{t("office.codeSearch.cloud.snapshot")}</p>
          {card.cloudCapped && (
            <p role="status" className="office-note">
              {t("office.codeSearch.cloud.capped")}
            </p>
          )}
          <PagedTable
            tableId="code-card-cloud"
            columns={cloudColumns(t)}
            rows={card.cloud}
            getRowKey={(item) => item.id}
            empty={t("office.codeSearch.nothingFound")}
            scrollLabel={t("office.codeSearch.cloud.title")}
          />
        </section>
      )}
    </div>
  );
}
