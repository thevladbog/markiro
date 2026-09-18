/**
 * Admin pallet card (06d) -- the read-only counterpart of `./BoxCard.tsx` one
 * aggregation level up, reached from a box card's «На паллете» link and from
 * the shift panel's pallet table. Shows the pallet's identity, its shift,
 * terminal and line, a COLLAPSED list of its member boxes (one row each,
 * linking on to that box's own card rather than inlining its codes -- a
 * pallet holds tens of boxes), and its own exception history.
 *
 * Deliberately the same PageHeader + DetailField grid + Table composition
 * `BoxCard` uses, down to the status-chip mapping, so the two cards read as
 * two levels of one thing rather than two screens.
 */
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";

import { CABINET_CAPABILITY, formatSsccHri } from "@markiro/domain";
import {
  Alert,
  Badge,
  Button,
  Card,
  Modal,
  PageHeader,
  RadioGroup,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { StatusChipStatus, TableColumn } from "@markiro/ui";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { formatCreatedAt, formatDate } from "../../lib/datetime.js";
import { toast } from "../../lib/toast.js";
import { useCreateDocument } from "../disaggregation/api.js";
import { lastRegistryHref } from "./registry-location.js";
import { PalletExportsSection } from "./PalletExportsSection.js";
import {
  usePalletCard,
  type PalletCardBoxDto,
  type PalletCardDto,
  type PalletCardRejectionDto,
  type PalletMembershipRejectionReason,
} from "./api.js";

// Identical mapping to the box card's: a pallet's three states mean the same
// three things -- still being stacked, closed and labelled, taken apart.
const STATUS_TO_CHIP: Record<PalletCardDto["status"], StatusChipStatus> = {
  open: "info",
  closed: "ok",
  disassembled: "neutral",
};

const REJECTION_REASONS: ReadonlySet<string> = new Set<PalletMembershipRejectionReason>([
  "already_on_pallet",
  "not_found",
  "not_closed",
  "disassembled",
  "pallet_closed",
  "product_mismatch",
]);

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>{label}</span>
      <span style={{ font: "var(--text-body)", color: "var(--fg-1)" }}>{value}</span>
    </div>
  );
}

export function PalletCardPage() {
  const { t, i18n } = useTranslation();
  const { palletId } = useParams();
  const navigate = useNavigate();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const createDocument = useCreateDocument();
  const [placardOpen, setPlacardOpen] = useState(false);
  const [placardFormat, setPlacardFormat] = useState<"a4" | "a5">("a4");

  const { data: pallet, isPending, isError } = usePalletCard(palletId);

  if (isPending) {
    return (
      <div style={{ padding: "28px 32px", display: "flex", justifyContent: "center" }}>
        <Spinner label={t("common.loading")} />
      </div>
    );
  }

  if (isError || !pallet) {
    return (
      <div style={{ padding: "28px 32px" }}>
        <Alert tone="error">{t("common.loadError")}</Alert>
      </div>
    );
  }

  const title = pallet.sscc ? formatSsccHri(pallet.sscc) : t("pages.codeSearch.palletCard.noSscc");

  // Taking a pallet apart in the cabinet IS a disaggregation document (spec
  // §4): the card only opens a fresh draft with this pallet's SSCC already in
  // the paste box. Only a closed, labelled pallet can be taken apart, and only
  // by someone allowed to write operations.
  const canDisassemble = canWrite && pallet.status === "closed" && pallet.sscc !== null;

  // A placard is a scannable SSCC on paper: only a closed (or disassembled,
  // for a historical reprint) pallet that has one gets the action -- the same
  // rule the server enforces with 409 PALLET_NOT_CLOSED.
  const canPlacard = pallet.sscc !== null && pallet.status !== "open";

  const openPlacard = () => {
    const query = new URLSearchParams({
      format: placardFormat,
      timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    window.open(`/api/code-search/pallets/${pallet.id}/placard?${query}`);
    setPlacardOpen(false);
  };

  const startDisassembly = () => {
    if (!pallet.sscc) return;
    const sscc = pallet.sscc;
    createDocument.mutate(undefined, {
      onSuccess: (doc) => {
        void navigate(`/disaggregation/${doc.id}?${new URLSearchParams({ sscc }).toString()}`);
      },
      onError: (error) =>
        toast(
          "error",
          error instanceof ApiRequestError
            ? error.message
            : t("pages.codeSearch.palletCard.disassembleError"),
        ),
    });
  };

  const boxColumns: TableColumn<PalletCardBoxDto>[] = [
    {
      key: "sscc",
      title: t("pages.codeSearch.palletCard.table.sscc"),
      mono: true,
      render: (row) => (
        <Link to={`/codes/box/${row.id}`}>
          {row.sscc ? formatSsccHri(row.sscc) : t("pages.codeSearch.boxCard.noSscc")}
        </Link>
      ),
    },
    {
      key: "shift",
      title: t("pages.codeSearch.palletCard.table.shift"),
      wrap: true,
      // A box's OWN shift, not the pallet's: on a warehouse pallet every row
      // may come from a different one, and the production date beside the
      // number is what tells the manager how old the stack really is.
      render: (row) => (
        <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
          <Link to={`/shifts/${row.shiftId}`}>{row.shiftNumber ?? row.shiftId}</Link>
          {row.productionDate ? (
            <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
              {formatDate(row.productionDate, i18n.language)}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "itemCount",
      title: t("pages.codeSearch.palletCard.table.itemCount"),
      align: "right",
      mono: true,
      render: (row) => new Intl.NumberFormat(i18n.language).format(row.itemCount),
    },
    {
      key: "closedAt",
      title: t("pages.codeSearch.palletCard.table.closedAt"),
      render: (row) => (row.closedAt ? formatCreatedAt(row.closedAt, i18n.language) : "—"),
    },
    {
      key: "state",
      title: t("pages.codeSearch.palletCard.table.state"),
      wrap: true,
      // A disassembled member box is kept on the list, never dropped: it is
      // the only evidence on screen that a closed, labelled pallet left the
      // line a box short. Badge text, not colour alone.
      render: (row) =>
        row.disassembledAt ? (
          <Badge tone="warn">{t("pages.codeSearch.palletCard.boxDisassembled")}</Badge>
        ) : null,
    },
  ];

  const rejectionColumns: TableColumn<PalletCardRejectionDto>[] = [
    {
      key: "boxSscc",
      title: t("pages.codeSearch.palletCard.rejections.table.sscc"),
      mono: true,
      render: (row) =>
        row.boxId ? (
          <Link to={`/codes/box/${row.boxId}`}>{formatSsccHri(row.boxSscc)}</Link>
        ) : (
          formatSsccHri(row.boxSscc)
        ),
    },
    {
      key: "reason",
      title: t("pages.codeSearch.palletCard.rejections.table.reason"),
      wrap: true,
      render: (row) =>
        REJECTION_REASONS.has(row.reason)
          ? t(`pages.codeSearch.palletCard.rejections.reason.${row.reason}`)
          : row.reason,
    },
    {
      key: "winningPalletSscc",
      title: t("pages.codeSearch.palletCard.rejections.table.winningPallet"),
      mono: true,
      render: (row) => (row.winningPalletSscc ? formatSsccHri(row.winningPalletSscc) : "—"),
    },
    {
      key: "addedAt",
      title: t("pages.codeSearch.palletCard.rejections.table.addedAt"),
      render: (row) => formatCreatedAt(row.addedAt, i18n.language),
    },
  ];

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <Link
        to={lastRegistryHref()}
        style={{ font: "var(--text-body)", color: "var(--fg-3)", textDecoration: "none" }}
      >
        {t("pages.codeSearch.backAction")}
      </Link>

      <PageHeader
        title={title}
        actions={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {canDisassemble ? (
              <Button
                type="button"
                variant="secondary"
                loading={createDocument.isPending}
                onClick={startDisassembly}
              >
                {t("pages.codeSearch.palletCard.disassembleAction")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                const query = new URLSearchParams({
                  timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
                window.open(`/api/code-search/pallets/${pallet.id}/report?${query}`);
              }}
            >
              {t("pages.codeSearch.palletCard.printAction")}
            </Button>
            {canPlacard ? (
              <Button type="button" variant="secondary" onClick={() => setPlacardOpen(true)}>
                {t("pages.codeSearch.palletCard.placard.action")}
              </Button>
            ) : null}
            <Badge tone={pallet.kind === "warehouse" ? "accent" : "neutral"}>
              {t(`pages.codeSearch.palletCard.kind.${pallet.kind}`)}
            </Badge>
            <StatusChip
              status={STATUS_TO_CHIP[pallet.status]}
              label={t(`pages.codeSearch.palletCard.status.${pallet.status}`)}
            />
          </div>
        }
      />

      <Card>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 16,
          }}
        >
          <DetailField
            label={t("pages.codeSearch.palletCard.productLabel")}
            value={pallet.productName ?? "—"}
          />
          <DetailField
            label={t("pages.codeSearch.palletCard.shiftLabel")}
            value={
              pallet.shiftId ? (
                <Link to={`/shifts/${pallet.shiftId}`}>
                  {pallet.shiftNumber ?? t("pages.codeSearch.palletCard.shiftLabel")}
                </Link>
              ) : (
                // A warehouse pallet belongs to no shift: say so rather than
                // linking to a shift that does not exist.
                t("pages.codeSearch.palletCard.noShift")
              )
            }
          />
          <DetailField
            label={t("pages.codeSearch.palletCard.lineLabel")}
            value={pallet.lineName ?? "—"}
          />
          <DetailField
            label={t("pages.codeSearch.palletCard.openedAtLabel")}
            value={formatCreatedAt(pallet.openedAt, i18n.language)}
          />
          <DetailField
            label={t("pages.codeSearch.palletCard.closedAtLabel")}
            value={pallet.closedAt ? formatCreatedAt(pallet.closedAt, i18n.language) : "—"}
          />
          <DetailField
            label={t("pages.codeSearch.palletCard.disassembledAtLabel")}
            value={
              pallet.disassembledAt ? formatCreatedAt(pallet.disassembledAt, i18n.language) : "—"
            }
          />
        </div>
      </Card>

      <Card title={t("pages.codeSearch.palletCard.boxesTitle")}>
        <Table
          columns={boxColumns}
          rows={pallet.boxes}
          getRowKey={(row) => row.id}
          empty={t("pages.codeSearch.palletCard.boxesEmpty")}
          scrollLabel={t("pages.codeSearch.palletCard.boxesTitle")}
        />
      </Card>

      {pallet.kind === "warehouse" ? (
        <Card title={t("pages.codeSearch.palletCard.rejections.title")}>
          <Table
            columns={rejectionColumns}
            rows={pallet.rejections}
            getRowKey={(row) => `${row.boxSscc}:${row.recordedAt}`}
            empty={t("pages.codeSearch.palletCard.rejections.empty")}
            scrollLabel={t("pages.codeSearch.palletCard.rejections.title")}
          />
        </Card>
      ) : null}

      <Card title={t("pages.codeSearch.palletCard.exceptionsTitle")}>
        {pallet.exceptions.length === 0 ? (
          <span style={{ font: "var(--text-body)", color: "var(--fg-3)" }}>
            {t("pages.codeSearch.palletCard.exceptionsEmpty")}
          </span>
        ) : (
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {pallet.exceptions.map((exception, index) => (
              <li
                key={`${exception.kind}:${exception.occurredAt}:${index}`}
                style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}
              >
                <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
                  {formatCreatedAt(exception.occurredAt, i18n.language)}
                </span>
                <span style={{ font: "var(--text-body)", color: "var(--fg-1)" }}>
                  {t(`pages.codeSearch.palletCard.exceptionKind.${exception.kind}`)}
                </span>
                <span style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
                  {exception.reason}
                </span>
                {exception.disaggregationDocumentId && exception.disaggregationDocNo ? (
                  <Link to={`/disaggregation/${exception.disaggregationDocumentId}`}>
                    {exception.disaggregationDocNo}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <section role="region" aria-label={t("pages.codeSearch.palletCard.exports.title")}>
        <Card title={t("pages.codeSearch.palletCard.exports.title")}>
          <PalletExportsSection pallet={pallet} />
        </Card>
      </section>

      <Modal
        open={placardOpen}
        title={t("pages.codeSearch.palletCard.placard.title")}
        closeLabel={t("common.close")}
        onClose={() => setPlacardOpen(false)}
        width={420}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setPlacardOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={openPlacard}>
              {t("pages.codeSearch.palletCard.placard.open")}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <RadioGroup
            label={t("pages.codeSearch.palletCard.placard.formatLabel")}
            name="pallet-placard-format"
            value={placardFormat}
            onValueChange={(value) => setPlacardFormat(value === "a5" ? "a5" : "a4")}
            options={[
              { value: "a4", label: t("pages.codeSearch.palletCard.placard.format.a4") },
              { value: "a5", label: t("pages.codeSearch.palletCard.placard.format.a5") },
            ]}
          />
          <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
            {t("pages.codeSearch.palletCard.placard.hint")}
          </span>
        </div>
      </Modal>
    </div>
  );
}
