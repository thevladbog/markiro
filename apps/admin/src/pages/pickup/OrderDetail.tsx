import { lazy, Suspense, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import {
  Alert,
  Button,
  Card,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { SelectOption, StatusChipStatus, TableColumn } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { formatCreatedAt } from "../../lib/datetime.js";
import { toast } from "../../lib/toast.js";
import { usePickupReasons } from "../kiosks/api.js";
import {
  useCancelOrder,
  usePickupOrder,
  useResolveOrder,
  type PickupOrderItemDto,
  type PickupOrderStatus,
} from "./api.js";

const STATUS_TO_CHIP: Record<PickupOrderStatus, StatusChipStatus> = {
  pending: "warn",
  punched: "ok",
  writtenoff: "neutral",
  cancelled: "error",
};

type ModalKind = "punch" | "writeoff" | "cancel" | null;

/**
 * Lazily loaded so bwip-js (reached through `@markiro/domain`'s DataMatrix
 * renderer) stays out of the main admin bundle and is fetched only when an
 * order-detail view actually renders codes. See `./ItemCode.tsx`.
 */
const ItemCode = lazy(() => import("./ItemCode.js"));

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>{label}</span>
      <span style={{ font: "var(--text-body)", color: "var(--fg-1)" }}>{value}</span>
    </div>
  );
}

/**
 * Admin pickup-order detail card -- Plan A Task 15. Shows the order header
 * (employee/kiosk/reason/total/status), the per-item DataMatrix + raw KM
 * table, and the resolve/cancel/print action bar. Actions are only enabled
 * while the order is `pending` -- `punched`/`writtenoff`/`cancelled` orders
 * are read-only. Reached from `pages/pickup/index.tsx`'s `orderNo` link.
 */
export function OrderDetailPage() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const orderId = id ?? "";

  const { data: order, isPending, isError } = usePickupOrder(orderId);
  const { data: reasonsData } = usePickupReasons();
  const resolveMutation = useResolveOrder();
  const cancelMutation = useCancelOrder();

  const [activeModal, setActiveModal] = useState<ModalKind>(null);
  const [receiptNo, setReceiptNo] = useState("");
  const [actNo, setActNo] = useState("");
  const [writeoffReasonId, setWriteoffReasonId] = useState("");

  const reasons = reasonsData ?? [];

  const closeModal = () => setActiveModal(null);

  const handlePunch = async () => {
    try {
      await resolveMutation.mutateAsync({
        id: orderId,
        input: { action: "punch", receiptNo: receiptNo.trim() },
      });
      toast("ok", t("pages.pickup.toasts.resolveSuccess"));
      closeModal();
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.pickup.toasts.resolveError"),
      );
    }
  };

  const handleWriteoff = async () => {
    try {
      await resolveMutation.mutateAsync({
        id: orderId,
        input: { action: "writeoff", actNo: actNo.trim(), writeoffReasonId },
      });
      toast("ok", t("pages.pickup.toasts.resolveSuccess"));
      closeModal();
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.pickup.toasts.resolveError"),
      );
    }
  };

  const handleCancel = async () => {
    try {
      await cancelMutation.mutateAsync(orderId);
      toast("ok", t("pages.pickup.toasts.cancelSuccess"));
      closeModal();
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.pickup.toasts.cancelError"),
      );
    }
  };

  if (isPending) {
    return (
      <div style={{ padding: "28px 32px", display: "flex", justifyContent: "center" }}>
        <Spinner label={t("common.loading")} />
      </div>
    );
  }

  if (isError || !order) {
    return (
      <div style={{ padding: "28px 32px" }}>
        <Alert tone="error">{t("pages.pickup.detail.loadError")}</Alert>
      </div>
    );
  }

  const isPendingOrder = order.status === "pending";
  const reasonText = `${t(`pages.pickup.reason.${order.reason}`)}${
    order.writeoffReasonName ? ` · ${order.writeoffReasonName}` : ""
  }`;

  const reasonOptions: SelectOption[] =
    reasons.length === 0
      ? [
          {
            value: "",
            label: t("pages.pickup.detail.writeoffModal.noReasonsHint"),
            disabled: true,
          },
        ]
      : reasons.map((reason) => ({ value: reason.id, label: reason.name }));

  const itemColumns: TableColumn<PickupOrderItemDto>[] = [
    {
      key: "code",
      title: t("pages.pickup.detail.table.code"),
      render: (item) => (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Suspense
            fallback={
              <span style={{ width: 64, height: 64, flexShrink: 0, display: "inline-block" }} />
            }
          >
            <ItemCode rawKm={item.rawKm} fallbackLabel={t("pages.pickup.detail.codeUnavailable")} />
          </Suspense>
          <span
            className="font-mono"
            style={{ font: "var(--text-code)", color: "var(--fg-2)", overflowWrap: "anywhere" }}
          >
            {item.rawKm}
          </span>
        </div>
      ),
    },
    { key: "productName", title: t("pages.pickup.detail.table.productName") },
    {
      key: "unitPrice",
      title: t("pages.pickup.detail.table.unitPrice"),
      align: "right",
      mono: true,
      render: (item) => item.unitPrice ?? "—",
    },
    {
      key: "status",
      title: t("pages.pickup.detail.table.status"),
      render: () => t("pages.pickup.detail.inCirculation"),
    },
  ];

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <style>{".mk-pickup-dm svg{width:100%;height:100%;display:block}"}</style>

      <Link
        to="/pickup"
        style={{ font: "var(--text-body)", color: "var(--fg-3)", textDecoration: "none" }}
      >
        {t("pages.pickup.detail.backAction")}
      </Link>

      <PageHeader
        title={order.orderNo}
        actions={
          <StatusChip
            status={STATUS_TO_CHIP[order.status]}
            label={t(`pages.pickup.status.${order.status}`)}
          />
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
          <DetailField label={t("pages.pickup.detail.employeeLabel")} value={order.employeeName} />
          <DetailField label={t("pages.pickup.detail.kioskLabel")} value={order.kioskName} />
          <DetailField label={t("pages.pickup.detail.reasonLabel")} value={reasonText} />
          <DetailField
            label={t("pages.pickup.detail.createdAtLabel")}
            value={formatCreatedAt(order.createdAt, i18n.language)}
          />
          <DetailField
            label={t("pages.pickup.detail.totalLabel")}
            value={order.totalPrice ?? "—"}
          />
        </div>
      </Card>

      <Card title={t("pages.pickup.detail.itemsTitle")}>
        <Table columns={itemColumns} rows={order.items} />
      </Card>

      <div style={{ display: "flex", gap: 8 }}>
        <Button
          type="button"
          variant="primary"
          disabled={!isPendingOrder}
          onClick={() => {
            setReceiptNo("");
            setActiveModal("punch");
          }}
        >
          {t("pages.pickup.detail.actions.punch")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!isPendingOrder}
          onClick={() => {
            setActNo("");
            setWriteoffReasonId(reasons[0]?.id ?? "");
            setActiveModal("writeoff");
          }}
        >
          {t("pages.pickup.detail.actions.writeoff")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!isPendingOrder}
          onClick={() => {
            window.open(`/api/pickup-orders/${orderId}/slip`);
          }}
        >
          {t("pages.pickup.detail.actions.print")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={!isPendingOrder}
          onClick={() => setActiveModal("cancel")}
        >
          {t("pages.pickup.detail.actions.cancel")}
        </Button>
      </div>

      <Modal
        open={activeModal === "punch"}
        onClose={closeModal}
        closeLabel={t("common.close")}
        title={t("pages.pickup.detail.punchModal.title")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={closeModal}>
              {t("pages.pickup.detail.dismissAction")}
            </Button>
            <Button
              type="button"
              loading={resolveMutation.isPending}
              disabled={receiptNo.trim().length === 0}
              onClick={() => void handlePunch()}
            >
              {t("pages.pickup.detail.punchModal.submit")}
            </Button>
          </>
        }
      >
        <Input
          label={t("pages.pickup.detail.punchModal.receiptNoLabel")}
          value={receiptNo}
          onChange={(event) => setReceiptNo(event.target.value)}
        />
      </Modal>

      <Modal
        open={activeModal === "writeoff"}
        onClose={closeModal}
        closeLabel={t("common.close")}
        title={t("pages.pickup.detail.writeoffModal.title")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={closeModal}>
              {t("pages.pickup.detail.dismissAction")}
            </Button>
            <Button
              type="button"
              loading={resolveMutation.isPending}
              disabled={actNo.trim().length === 0 || writeoffReasonId.length === 0}
              onClick={() => void handleWriteoff()}
            >
              {t("pages.pickup.detail.writeoffModal.submit")}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Input
            label={t("pages.pickup.detail.writeoffModal.actNoLabel")}
            value={actNo}
            onChange={(event) => setActNo(event.target.value)}
          />
          <Select
            label={t("pages.pickup.detail.writeoffModal.reasonLabel")}
            options={reasonOptions}
            value={writeoffReasonId}
            onChange={setWriteoffReasonId}
          />
        </div>
      </Modal>

      <Modal
        open={activeModal === "cancel"}
        onClose={closeModal}
        closeLabel={t("common.close")}
        title={t("pages.pickup.detail.cancelModal.title")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={closeModal}>
              {t("pages.pickup.detail.dismissAction")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={cancelMutation.isPending}
              onClick={() => void handleCancel()}
            >
              {t("pages.pickup.detail.cancelModal.confirmAction")}
            </Button>
          </>
        }
      >
        <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
          {t("pages.pickup.detail.cancelModal.body")}
        </p>
      </Modal>
    </div>
  );
}
