import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";

import {
  Card,
  EmptyState,
  FilterBar,
  Input,
  PageHeader,
  Select,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type { OfficeBox, OfficeShift } from "../../host/protocol.js";
import { isPackId } from "../../host/pack-cards.js";
import { formTimeZone } from "../forms/render-form.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { OfficePager } from "../OfficePager.js";
import { LoadError, PageLoading } from "../page-state.js";
import { searchableSelect } from "../select-search.js";
import { BOX_PAGE_SIZE, endsWithTail, packState, ssccTail } from "../shifts/shift-card.js";
import { civilDateLabel, recordLabel } from "../shifts/shift-list.js";
import { instantFormat } from "./CodeCard.js";
import { BoxLink, PackStateChip, PalletLinkOrOpen } from "./PackLinks.js";
import { RegistryTabs } from "./RegistryTabs.js";

/** Counts with the thousands apart by a no-break space: «1 200». */
const UNITS = new Intl.NumberFormat("ru");

/** A shift that has boxes to show: not planned, not a check of codes. */
function hasBoxes(shift: OfficeShift): boolean {
  return shift.status !== "planned" && shift.mode !== "validation";
}

/**
 * «Короба» (plan КРТ, the cloud's boxes list): one shift's boxes, as the
 * cloud asks for a shift first. The shift lives in the address
 * (`?shift=<id>`), so «Назад» from a box's card finds it again. A row opens
 * the box's card.
 */
export function BoxesTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const asked = params.get("shift") ?? "";
  const shiftId = isPackId(asked) ? asked : "";
  const [tail, setTail] = useState("");
  const [page, setPage] = useState(1);
  const shifts = useOfficeQuery(officeKeys.shiftList(null), (api, token) => api.listShifts(token));
  const products = useOfficeQuery(officeKeys.products, (api, token) => api.listProducts(token));
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const inList = shifts.data?.some((shift) => shift.id === shiftId) === true;
  // A shift from an old link is not in the host's own list: it is read by itself and added.
  const linked = useOfficeQuery(
    officeKeys.shift(shiftId),
    (api, token) => api.getShift(token, shiftId),
    { enabled: shiftId !== "" && shifts.isSuccess && !inList },
  );
  const options = useMemo(() => {
    const listed = (shifts.data ?? []).filter(hasBoxes);
    const all =
      linked.data !== undefined && !inList && hasBoxes(linked.data)
        ? [linked.data, ...listed]
        : listed;
    return [...all].sort(
      (a, b) =>
        (a.productionDate < b.productionDate ? 1 : a.productionDate > b.productionDate ? -1 : 0) ||
        (a.number < b.number ? 1 : a.number > b.number ? -1 : 0),
    );
  }, [shifts.data, linked.data, inList]);
  const shift = options.find((each) => each.id === shiftId);
  const boxes = useOfficeQuery(
    officeKeys.shiftBoxes(shiftId),
    (api, token) => api.listShiftBoxes(token, shiftId),
    { enabled: shiftId !== "" },
  );
  const pallets = useOfficeQuery(
    officeKeys.shiftPallets(shiftId),
    (api, token) => api.listShiftPallets(token, shiftId),
    { enabled: shiftId !== "" && shift?.palletsEnabled === true },
  );
  const palletById = useMemo(
    () => new Map((pallets.data ?? []).map((pallet) => [pallet.id, pallet])),
    [pallets.data],
  );
  const format = instantFormat(formTimeZone(org.data));
  const at = (instant: string | null) =>
    instant === null ? t("office.common.none") : format(instant);

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
    ...(shift?.palletsEnabled === true
      ? [
          {
            key: "pallet",
            title: t("office.shiftCard.boxes.pallet"),
            mono: true,
            render: (box: OfficeBox) => {
              if (box.palletId === null) return t("office.common.none");
              const pallet = palletById.get(box.palletId);
              if (pallets.isPending) return t("office.common.loading");
              if (pallet === undefined) return t("office.shiftCard.unknownPallet");
              return <PalletLinkOrOpen id={pallet.id} sscc={pallet.sscc} />;
            },
          },
        ]
      : []),
    {
      key: "operator",
      title: t("office.boxList.operator"),
      render: (box) => box.operatorName ?? t("office.common.none"),
    },
    {
      key: "state",
      title: t("office.shiftCard.boxes.state"),
      wrap: true,
      minWidth: 160,
      render: (box) => <PackStateChip state={packState(box)} kind="box" />,
    },
  ];

  const select = (id: string) => {
    setTail("");
    setPage(1);
    setParams(id === "" ? new URLSearchParams() : new URLSearchParams({ shift: id }));
  };

  const content = () => {
    if (shiftId === "") {
      return <EmptyState title={t("office.boxList.selectShift")} />;
    }
    if (boxes.isPending) return <PageLoading />;
    if (boxes.isError)
      return <LoadError error={boxes.error} onRetry={() => void boxes.refetch()} />;
    const kept = boxes.data.filter((box) => endsWithTail(box.sscc, tail));
    const pageCount = Math.max(1, Math.ceil(kept.length / BOX_PAGE_SIZE));
    const shown = Math.min(page, pageCount);
    return (
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
        <p className="office-note" aria-live="polite">
          {t("office.shiftCard.boxes.found", { shown: kept.length, total: boxes.data.length })}
        </p>
        <Table
          columns={columns}
          rows={kept.slice((shown - 1) * BOX_PAGE_SIZE, shown * BOX_PAGE_SIZE)}
          getRowKey={(box) => box.id}
          onRowClick={(box) => void navigate(`/codes/box/${box.id}`)}
          empty={t(boxes.data.length === 0 ? "office.boxList.empty" : "office.boxList.none")}
          scrollLabel={t("office.boxList.table")}
        />
        {pageCount > 1 && (
          <OfficePager
            label={t("office.boxList.pager")}
            page={shown}
            pageCount={pageCount}
            onPage={setPage}
          />
        )}
      </Card>
    );
  };

  return (
    <div className="office-stack">
      <PageHeader title={t("office.codeSearch.title")} />
      <RegistryTabs active="boxes" />
      <FilterBar label={t("office.boxList.shift")}>
        <Select
          {...searchableSelect(t)}
          searchLabel={t("office.boxList.shiftSearch")}
          label={t("office.boxList.shift")}
          placeholder={t("office.boxList.shiftPlaceholder")}
          options={options.map((each) => ({
            value: each.id,
            label: t("office.boxList.shiftOption", {
              number: each.number,
              date: civilDateLabel(each.productionDate),
              product: recordLabel("product", products.data, each.productId, t),
            }),
          }))}
          value={shiftId}
          onValueChange={select}
        />
      </FilterBar>
      {shift !== undefined && (
        <p className="office-note">
          {t("office.boxList.shiftLine", {
            line: recordLabel("line", lines.data, shift.lineId, t),
            status: t(`office.shifts.statuses.${shift.status}`),
          })}
        </p>
      )}
      {shifts.isError && <LoadError error={shifts.error} onRetry={() => void shifts.refetch()} />}
      {content()}
    </div>
  );
}
