import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  EmptyState,
  Modal,
  PageHeader,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { TableColumn } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useProducts, type ProductDto } from "../catalog/api.js";
import { KioskForm, type KioskFormValues } from "./KioskForm.js";
import { PairingCodeModal } from "./PairingCodeModal.js";
import { ReasonsEditor } from "./ReasonsEditor.js";
import {
  useArchiveKiosk,
  useCreateKiosk,
  useIssueKioskPairingCode,
  useKiosks,
  useSetKioskProducts,
  useUpdateKiosk,
  type CreateKioskInput,
  type KioskDto,
  type UpdateKioskInput,
} from "./api.js";

/**
 * The live pairing reveal. Holds the plaintext code, which the server returns
 * exactly once and stores only as a hash -- dropping this state is what makes
 * the reveal one-time, so nothing else may cache it.
 */
type PairingState = { kiosk: KioskDto; code: string; expiresAt: string } | null;

/** A kiosk is considered "online" if it has phoned home within this window. */
const ONLINE_THRESHOLD_MS = 2 * 60 * 1000;

function isKioskOnline(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() <= ONLINE_THRESHOLD_MS;
}

function AuthorizedCreateKioskAction({ products }: { products: ProductDto[] }) {
  const { t } = useTranslation();
  const createMutation = useCreateKiosk();
  const [open, setOpen] = useState(false);

  const handleSubmit = async (input: CreateKioskInput | UpdateKioskInput) => {
    try {
      await createMutation.mutateAsync(input as CreateKioskInput);
      toast("ok", t("pages.kiosks.toasts.createSuccess"));
      setOpen(false);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.kiosks.toasts.createError"),
      );
    }
  };

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {t("pages.kiosks.addAction")}
      </Button>
      {open ? (
        <KioskForm
          open
          mode="create"
          products={products}
          submitting={createMutation.isPending}
          onSubmit={handleSubmit}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function AuthorizedKioskRowActions({
  kiosk,
  products,
}: {
  kiosk: KioskDto;
  products: ProductDto[];
}) {
  const { t } = useTranslation();
  const updateMutation = useUpdateKiosk();
  const archiveMutation = useArchiveKiosk();
  const setProductsMutation = useSetKioskProducts();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const initialValues: KioskFormValues = {
    name: kiosk.name,
    location: kiosk.location ?? "",
    dayLimitPerEmployee: String(kiosk.dayLimitPerEmployee),
    showPrices: kiosk.showPrices,
  };

  const handleUpdate = async (input: CreateKioskInput | UpdateKioskInput) => {
    try {
      await updateMutation.mutateAsync({ id: kiosk.id, input });
      toast("ok", t("pages.kiosks.toasts.updateSuccess"));
      setEditing(false);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.kiosks.toasts.updateError"),
      );
    }
  };

  const handleSaveProducts = async (productIds: string[]) => {
    try {
      await setProductsMutation.mutateAsync({ id: kiosk.id, productIds });
      toast("ok", t("pages.kiosks.toasts.setProductsSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.kiosks.toasts.setProductsError"),
      );
    }
  };

  const handleArchive = async () => {
    try {
      await archiveMutation.mutateAsync(kiosk.id);
      toast("ok", t("pages.kiosks.toasts.archiveSuccess"));
      setArchiving(false);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.kiosks.toasts.archiveError"),
      );
    }
  };

  return (
    <>
      <Button type="button" size="compact" variant="secondary" onClick={() => setEditing(true)}>
        {t("pages.kiosks.edit")}
      </Button>
      {kiosk.status === "active" ? (
        <Button
          type="button"
          size="compact"
          variant="destructive"
          onClick={() => setArchiving(true)}
        >
          {t("pages.kiosks.archive")}
        </Button>
      ) : null}
      {editing ? (
        <KioskForm
          open
          mode="edit"
          kiosk={kiosk}
          initialValues={initialValues}
          products={products}
          submitting={updateMutation.isPending}
          savingProducts={setProductsMutation.isPending}
          onSubmit={handleUpdate}
          onSaveProducts={handleSaveProducts}
          onClose={() => setEditing(false)}
        />
      ) : null}
      <Modal
        open={archiving}
        onClose={() => setArchiving(false)}
        closeLabel={t("common.close")}
        title={t("pages.kiosks.archiveConfirmTitle")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setArchiving(false)}>
              {t("pages.kiosks.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={archiveMutation.isPending}
              onClick={() => void handleArchive()}
            >
              {t("pages.kiosks.archiveConfirmAction")}
            </Button>
          </>
        }
      >
        <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
          {t("pages.kiosks.archiveConfirmBody", { name: kiosk.name })}
        </p>
      </Modal>
    </>
  );
}

/**
 * Admin kiosk settings screen -- Plan A Task 17
 * (list/create/edit/pair/archive + product allowlist + embedded write-off
 * reasons editor). Mirrors `../employees/index.tsx`'s active/archived +
 * confirm-modal pattern (Task 16) for the kiosk lifecycle, and
 * `../shifts/ShiftForm.tsx`'s "pass the already-fetched catalog list down as
 * a prop" convention for the allowlist's product candidates.
 */
export function KiosksPage() {
  const { t } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const canManageCredentials = useCan(CABINET_CAPABILITY.CREDENTIALS_MANAGE);
  const { data, isPending, isError } = useKiosks();
  const { data: productsData } = useProducts({ status: "active" });

  const items = data ?? [];
  const activeProducts = useMemo(() => productsData ?? [], [productsData]);

  const columns: TableColumn<KioskDto>[] = useMemo(
    () => [
      { key: "name", title: t("pages.kiosks.table.name") },
      {
        key: "location",
        title: t("pages.kiosks.table.location"),
        render: (row) => row.location ?? "—",
      },
      {
        key: "online",
        title: t("pages.kiosks.table.online"),
        render: (row) => {
          const online = isKioskOnline(row.lastSeenAt);
          return (
            <StatusChip
              status={online ? "ok" : "neutral"}
              label={t(
                online ? "pages.kiosks.onlineStatus.online" : "pages.kiosks.onlineStatus.offline",
              )}
            />
          );
        },
      },
      {
        key: "dayLimitPerEmployee",
        title: t("pages.kiosks.table.dayLimit"),
        align: "right",
        mono: true,
      },
      {
        key: "showPrices",
        title: t("pages.kiosks.table.showPrices"),
        render: (row) => (row.showPrices ? t("common.yes") : t("common.no")),
      },
      {
        key: "actions",
        title: t("pages.kiosks.table.actions"),
        align: "right",
        render: (row) => (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {canWrite ? <AuthorizedKioskRowActions kiosk={row} products={activeProducts} /> : null}
            {row.status === "active" && canManageCredentials ? (
              <KioskPairingAction kiosk={row} />
            ) : null}
          </div>
        ),
      },
    ],
    [t, canWrite, canManageCredentials, activeProducts],
  );

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.kiosks.title")}
        actions={canWrite ? <AuthorizedCreateKioskAction products={activeProducts} /> : null}
      />

      {isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : items.length === 0 ? (
        <EmptyState
          title={t("pages.kiosks.emptyTitle")}
          hint={t("pages.kiosks.emptyHint")}
          action={canWrite ? <AuthorizedCreateKioskAction products={activeProducts} /> : null}
        />
      ) : (
        <Table columns={columns} rows={items} />
      )}

      <ReasonsEditor />
    </div>
  );
}

/** Owns the credential mutation so it never mounts for an unauthorized manager. */
function KioskPairingAction({ kiosk }: { kiosk: KioskDto }) {
  const { t } = useTranslation();
  const pairingMutation = useIssueKioskPairingCode();
  const [pairing, setPairing] = useState<PairingState>(null);

  const handleIssuePairingCode = async () => {
    try {
      const result = await pairingMutation.mutateAsync(kiosk.id);
      setPairing({ kiosk, code: result.code, expiresAt: result.expiresAt });
      toast("ok", t("pages.kiosks.toasts.pairingSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.kiosks.toasts.pairingError"),
      );
    }
  };

  return (
    <>
      <Button
        type="button"
        size="compact"
        variant="secondary"
        onClick={() => void handleIssuePairingCode()}
      >
        {t("pages.kiosks.pairing.action")}
      </Button>
      {pairing ? (
        <PairingCodeModal
          kioskName={pairing.kiosk.name}
          code={pairing.code}
          expiresAt={pairing.expiresAt}
          regenerating={pairingMutation.isPending}
          onRegenerate={() => void handleIssuePairingCode()}
          onClose={() => setPairing(null)}
        />
      ) : null}
    </>
  );
}
