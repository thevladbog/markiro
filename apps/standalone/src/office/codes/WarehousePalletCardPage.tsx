import { DemoBadge } from "../demo/DemoBadge.js";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import {
  Button,
  Card,
  DefinitionGrid,
  EmptyState,
  PageHeader,
  RowActions,
  type TableColumn,
} from "@markiro/ui";
import type { OfficeWarehousePalletDetail } from "../../host/office-pallet-create.js";
import { CardFiles } from "../exports/CardFiles.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { PagedTable } from "../paging/PagedTable.js";
import { civilDateLabel } from "../shifts/shift-list.js";
import { packState, ssccText } from "../shifts/shift-card.js";
import { CardBack, isNotFound } from "./BoxCardPage.js";
import { instantFormat, ShiftLink } from "./CodeCard.js";
import { BoxLink, PackStateChip } from "./PackLinks.js";
import { usePackDisassembly } from "./PackDisassembly.js";
import { WarehousePalletDocumentDialog } from "./WarehousePalletDocumentDialog.js";

const COUNT = new Intl.NumberFormat("ru");
type Member = OfficeWarehousePalletDetail["members"][number];
export function WarehousePalletCardPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const [form, setForm] = useState<"pallet" | "placard" | "xml" | null>(null);
  const card = useOfficeQuery(officeKeys.warehousePallet(id), (api, token) =>
    api.getWarehousePallet(token, id),
  );
  const disassembly = usePackDisassembly({
    sscc: card.data?.sscc ?? null,
    closed: card.data?.closedAt != null,
    disassembled: card.data?.disassembledAt != null,
    shiftStatus: "closed",
  });
  if (card.isPending)
    return (
      <>
        <CardBack />
        <PageLoading />
      </>
    );
  if (card.isError)
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
  const pallet = card.data;
  const zone = pallet.organization.timeZone;
  const format = instantFormat(zone);
  const at = (instant: string | null) =>
    instant === null ? t("office.common.none") : format(instant);
  const label = pallet.sscc === null ? t("office.palletCard.noSscc") : ssccText(pallet.sscc);
  const closed = pallet.closedAt !== null && pallet.sscc !== null;
  const columns: TableColumn<Member>[] = [
    {
      key: "sscc",
      title: t("office.palletCard.members.sscc"),
      mono: true,
      render: (box) => <BoxLink id={box.id} sscc={box.sscc} />,
    },
    {
      key: "shift",
      title: t("office.warehouseCard.shift"),
      render: (box) => <ShiftLink item={{ shiftId: box.shiftId, shiftNumber: box.shiftNumber }} />,
    },
    {
      key: "productionDate",
      title: t("office.warehouseCard.productionDate"),
      mono: true,
      render: (box) => civilDateLabel(box.productionDate),
    },
    {
      key: "units",
      title: t("office.palletCard.members.units"),
      mono: true,
      align: "right",
      render: (box) => COUNT.format(box.units),
    },
    {
      key: "state",
      title: t("office.palletCard.members.state"),
      render: (box) =>
        box.disassembledAt !== null
          ? t("office.palletCard.members.disassembled")
          : box.removedAt !== null
            ? t("office.warehouseCard.removed")
            : t("office.shiftCard.boxState.closed"),
    },
  ];
  return (
    <div className="office-stack">
      <CardBack />
      <PageHeader
        title={t("office.palletCard.title", { label })}
        actions={
          <RowActions>
            <Button variant="secondary" onClick={() => setForm("pallet")}>
              {t("office.palletCard.contents")}
            </Button>
            {closed && (
              <Button variant="secondary" onClick={() => setForm("placard")}>
                {t("office.palletCard.placard")}
              </Button>
            )}
            {closed && !pallet.demo && pallet.disassembledAt === null && (
              <Button variant="secondary" onClick={() => setForm("xml")}>
                {t("office.palletCard.xml")}
              </Button>
            )}
            {disassembly.button}
          </RowActions>
        }
      />
      {pallet.demo && <DemoBadge />}
      {disassembly.notice}
      <PackStateChip kind="pallet" state={packState(pallet)} />
      <DefinitionGrid
        items={[
          { id: "product", term: t("office.palletCard.product"), description: pallet.productName },
          {
            id: "source",
            term: t("office.warehouseCard.source"),
            description:
              pallet.source === "cabinet" ? t("office.warehouseCard.office") : pallet.deviceName,
          },
          {
            id: "creator",
            term: t("office.warehouseCard.creator"),
            description: pallet.createdByName ?? t("office.common.none"),
          },
          { id: "device", term: t("office.warehouseCard.device"), description: pallet.deviceName },
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
            description: COUNT.format(pallet.boxes),
            mono: true,
          },
          {
            id: "units",
            term: t("office.palletCard.units"),
            description: COUNT.format(pallet.units),
            mono: true,
          },
        ]}
      />
      {pallet.disassembledAt !== null && (
        <p>{t("office.palletCard.disassembledAt", { at: at(pallet.disassembledAt) })}</p>
      )}
      <section className="shift-card__section">
        <h2>{t("office.palletCard.members.title")}</h2>
        <Card>
          <PagedTable
            tableId="warehouse-pallet-members"
            columns={columns}
            rows={pallet.members}
            getRowKey={(box) => box.membershipId}
            empty={t("office.palletCard.members.empty")}
            scrollLabel={t("office.palletCard.members.table")}
          />
        </Card>
      </section>
      <CardFiles
        targetType="warehouse_pallet"
        targetId={id}
        label={label}
        at={format}
        timeZone={zone}
      />
      {form !== null && (
        <WarehousePalletDocumentDialog
          id={id}
          label={label}
          kind={form}
          onClose={() => setForm(null)}
        />
      )}
    </div>
  );
}
