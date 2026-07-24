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

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useProducts } from "../catalog/api.js";
import { KioskForm, type KioskFormValues } from "./KioskForm.js";
import { ReasonsEditor } from "./ReasonsEditor.js";
import {
  useArchiveKiosk,
  useCreateKiosk,
  useEnrollKiosk,
  useKiosks,
  useSetKioskProducts,
  useUpdateKiosk,
  type CreateKioskInput,
  type KioskDto,
  type UpdateKioskInput,
} from "./api.js";

type FormModalState = { mode: "create" } | { mode: "edit"; kiosk: KioskDto } | null;

/** A kiosk is considered "online" if it has phoned home within this window. */
const ONLINE_THRESHOLD_MS = 2 * 60 * 1000;

function isKioskOnline(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() <= ONLINE_THRESHOLD_MS;
}

/**
 * Admin kiosk settings screen -- Plan A Task 17
 * (list/create/edit/archive/enroll + product allowlist + embedded write-off
 * reasons editor). Mirrors `../employees/index.tsx`'s active/archived +
 * confirm-modal pattern (Task 16) for the kiosk lifecycle, and
 * `../shifts/ShiftForm.tsx`'s "pass the already-fetched catalog list down as
 * a prop" convention for the allowlist's product candidates.
 */
export function KiosksPage() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useKiosks();
  const { data: productsData } = useProducts({ status: "active" });

  const createMutation = useCreateKiosk();
  const updateMutation = useUpdateKiosk();
  const archiveMutation = useArchiveKiosk();
  const setProductsMutation = useSetKioskProducts();
  const enrollMutation = useEnrollKiosk();

  const [formState, setFormState] = useState<FormModalState>(null);
  const [archiveTarget, setArchiveTarget] = useState<KioskDto | null>(null);
  const [tokenModal, setTokenModal] = useState<{ token: string } | null>(null);

  const items = data ?? [];
  const activeProducts = productsData ?? [];

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
            <Button
              type="button"
              size="compact"
              variant="secondary"
              onClick={() => setFormState({ mode: "edit", kiosk: row })}
            >
              {t("pages.kiosks.edit")}
            </Button>
            {row.status === "active" && (
              <Button
                type="button"
                size="compact"
                variant="secondary"
                onClick={() => void handleEnroll(row)}
              >
                {t("pages.kiosks.enroll.action")}
              </Button>
            )}
            {row.status === "active" && (
              <Button
                type="button"
                size="compact"
                variant="destructive"
                onClick={() => setArchiveTarget(row)}
              >
                {t("pages.kiosks.archive")}
              </Button>
            )}
          </div>
        ),
      },
    ],
    [t],
  );

  const editingKiosk = formState?.mode === "edit" ? formState.kiosk : undefined;
  const initialValues: KioskFormValues | undefined = editingKiosk
    ? {
        name: editingKiosk.name,
        location: editingKiosk.location ?? "",
        dayLimitPerEmployee: String(editingKiosk.dayLimitPerEmployee),
        showPrices: editingKiosk.showPrices,
      }
    : undefined;

  const handleSubmit = async (input: CreateKioskInput | UpdateKioskInput) => {
    const isEdit = formState?.mode === "edit";
    try {
      if (formState?.mode === "edit") {
        await updateMutation.mutateAsync({ id: formState.kiosk.id, input });
        toast("ok", t("pages.kiosks.toasts.updateSuccess"));
      } else {
        await createMutation.mutateAsync(input as CreateKioskInput);
        toast("ok", t("pages.kiosks.toasts.createSuccess"));
      }
      setFormState(null);
    } catch (error) {
      const fallback = isEdit
        ? t("pages.kiosks.toasts.updateError")
        : t("pages.kiosks.toasts.createError");
      toast("error", error instanceof ApiRequestError ? error.message : fallback);
    }
  };

  const handleSaveProducts = async (productIds: string[]) => {
    if (formState?.mode !== "edit") return;
    try {
      await setProductsMutation.mutateAsync({ id: formState.kiosk.id, productIds });
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
    if (!archiveTarget) return;
    try {
      await archiveMutation.mutateAsync(archiveTarget.id);
      toast("ok", t("pages.kiosks.toasts.archiveSuccess"));
      setArchiveTarget(null);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.kiosks.toasts.archiveError"),
      );
    }
  };

  const handleEnroll = async (kiosk: KioskDto) => {
    try {
      const result = await enrollMutation.mutateAsync(kiosk.id);
      setTokenModal({ token: result.token });
      toast("ok", t("pages.kiosks.toasts.enrollSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.kiosks.toasts.enrollError"),
      );
    }
  };

  const handleCopyToken = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
    } catch {
      toast("error", t("pages.kiosks.enroll.copyError"));
    }
  };

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.kiosks.title")}
        actions={
          <Button type="button" onClick={() => setFormState({ mode: "create" })}>
            {t("pages.kiosks.addAction")}
          </Button>
        }
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
          action={
            <Button type="button" onClick={() => setFormState({ mode: "create" })}>
              {t("pages.kiosks.addAction")}
            </Button>
          }
        />
      ) : (
        <Table columns={columns} rows={items} />
      )}

      <ReasonsEditor />

      <KioskForm
        open={formState !== null}
        mode={formState?.mode ?? "create"}
        {...(editingKiosk ? { kiosk: editingKiosk } : {})}
        {...(initialValues ? { initialValues } : {})}
        products={activeProducts}
        submitting={createMutation.isPending || updateMutation.isPending}
        savingProducts={setProductsMutation.isPending}
        onSubmit={handleSubmit}
        onSaveProducts={handleSaveProducts}
        onClose={() => setFormState(null)}
      />

      <Modal
        open={archiveTarget !== null}
        onClose={() => setArchiveTarget(null)}
        closeLabel={t("common.close")}
        title={t("pages.kiosks.archiveConfirmTitle")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setArchiveTarget(null)}>
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
        {archiveTarget && (
          <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
            {t("pages.kiosks.archiveConfirmBody", { name: archiveTarget.name })}
          </p>
        )}
      </Modal>

      <Modal
        open={tokenModal !== null}
        onClose={() => setTokenModal(null)}
        closeLabel={t("common.close")}
        title={t("pages.kiosks.enroll.modalTitle")}
        footer={
          <Button type="button" onClick={() => setTokenModal(null)}>
            {t("common.close")}
          </Button>
        }
      >
        {tokenModal && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
              {t("pages.kiosks.enroll.hint")}
            </p>
            <p
              style={{
                font: "var(--text-code)",
                color: "var(--fg-1)",
                wordBreak: "break-all",
                padding: "8px 12px",
                background: "var(--surface-panel)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r-2)",
              }}
            >
              {tokenModal.token}
            </p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleCopyToken(tokenModal.token)}
            >
              {t("pages.kiosks.enroll.copyAction")}
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
