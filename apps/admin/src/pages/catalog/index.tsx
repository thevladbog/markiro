import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { SelectOption, TableColumn } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useCounterparties } from "../counterparties/api.js";
import { useLabelTemplates } from "../labels/api.js";
import { ProductForm, type ProductFormValues } from "./ProductForm.js";
import {
  useCreateProduct,
  useDeleteProduct,
  useProducts,
  useUpdateProduct,
  type CreateProductInput,
  type ProductDto,
  type ProductStatus,
} from "./api.js";

type FormModalState = { mode: "create" } | { mode: "edit"; product: ProductDto } | null;
type StatusFilter = "all" | ProductStatus;

/** Debounce delay (ms) between the last keystroke in the search box and the refetch. */
const SEARCH_DEBOUNCE_MS = 300;

/** Admin product catalog CRUD screen -- Plan 03 Task 12 (list/create/edit/delete + GTIN owner hint). */
export function CatalogPage() {
  const { t } = useTranslation();

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // Debounce the free-text search so typing doesn't refetch on every keystroke.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const { data, isPending, isError } = useProducts({
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
  });
  const { data: counterpartiesData } = useCounterparties();
  const { data: labelTemplatesData } = useLabelTemplates();
  const createMutation = useCreateProduct();
  const updateMutation = useUpdateProduct();
  const deleteMutation = useDeleteProduct();

  const [formState, setFormState] = useState<FormModalState>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProductDto | null>(null);

  const items = data ?? [];
  const counterparties = counterpartiesData ?? [];
  const labelTemplates = labelTemplatesData ?? [];

  const statusFilterOptions: SelectOption[] = [
    { value: "all", label: t("pages.catalog.statusFilter.all") },
    { value: "draft", label: t("pages.catalog.statusFilter.draft") },
    { value: "active", label: t("pages.catalog.statusFilter.active") },
  ];

  const columns: TableColumn<ProductDto>[] = useMemo(
    () => [
      { key: "gtin14", title: t("pages.catalog.table.gtin"), mono: true },
      { key: "name", title: t("pages.catalog.table.name") },
      {
        key: "productGroup",
        title: t("pages.catalog.table.productGroup"),
        render: (row) => row.productGroup ?? "—",
      },
      {
        key: "boxCapacity",
        title: t("pages.catalog.table.boxCapacity"),
        align: "right",
        mono: true,
        render: (row) => row.boxCapacity ?? "—",
      },
      {
        key: "palletCapacity",
        title: t("pages.catalog.table.palletCapacity"),
        align: "right",
        mono: true,
        render: (row) => row.palletCapacity ?? "—",
      },
      {
        key: "status",
        title: t("pages.catalog.table.status"),
        render: (row) => (
          <StatusChip
            status={row.status === "active" ? "ok" : "warn"}
            label={t(`pages.catalog.status.${row.status}`)}
          />
        ),
      },
      {
        key: "actions",
        title: t("pages.catalog.table.actions"),
        align: "right",
        render: (row) => (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button
              type="button"
              size="compact"
              variant="secondary"
              onClick={() => setFormState({ mode: "edit", product: row })}
            >
              {t("pages.catalog.edit")}
            </Button>
            <Button
              type="button"
              size="compact"
              variant="destructive"
              onClick={() => setDeleteTarget(row)}
            >
              {t("pages.catalog.delete")}
            </Button>
          </div>
        ),
      },
    ],
    [t],
  );

  const editingProduct = formState?.mode === "edit" ? formState.product : undefined;
  const initialValues: ProductFormValues | undefined = editingProduct
    ? {
        gtin: editingProduct.gtin14,
        name: editingProduct.name,
        productGroup: editingProduct.productGroup ?? "",
        boxCapacity: editingProduct.boxCapacity !== null ? String(editingProduct.boxCapacity) : "",
        palletCapacity:
          editingProduct.palletCapacity !== null ? String(editingProduct.palletCapacity) : "",
        unitPrice: editingProduct.unitPrice ?? "",
        egaisCode: editingProduct.egaisCode ?? "",
        defaultCounterpartyId: editingProduct.defaultCounterpartyId ?? "",
        defaultLabelTemplateId: editingProduct.defaultLabelTemplateId ?? "",
      }
    : undefined;

  const handleSubmit = async (input: CreateProductInput) => {
    const isEdit = formState?.mode === "edit";
    try {
      if (formState?.mode === "edit") {
        await updateMutation.mutateAsync({ id: formState.product.id, input });
        toast("ok", t("pages.catalog.toasts.updateSuccess"));
      } else {
        await createMutation.mutateAsync(input);
        toast("ok", t("pages.catalog.toasts.createSuccess"));
      }
      setFormState(null);
    } catch (error) {
      const fallback = isEdit
        ? t("pages.catalog.toasts.updateError")
        : t("pages.catalog.toasts.createError");
      toast("error", error instanceof ApiRequestError ? error.message : fallback);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      toast("ok", t("pages.catalog.toasts.deleteSuccess"));
      setDeleteTarget(null);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.catalog.toasts.deleteError"),
      );
    }
  };

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.catalog.title")}
        actions={
          <Button type="button" onClick={() => setFormState({ mode: "create" })}>
            {t("pages.catalog.addAction")}
          </Button>
        }
      />

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div style={{ flex: 1, maxWidth: 320 }}>
          <Input
            label={t("pages.catalog.searchLabel")}
            placeholder={t("pages.catalog.searchPlaceholder")}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        <div style={{ width: 200 }}>
          <Select
            label={t("pages.catalog.statusFilterLabel")}
            options={statusFilterOptions}
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as StatusFilter)}
          />
        </div>
      </div>

      {isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : items.length === 0 ? (
        <EmptyState
          title={t("pages.catalog.emptyTitle")}
          hint={t("pages.catalog.emptyHint")}
          action={
            <Button type="button" onClick={() => setFormState({ mode: "create" })}>
              {t("pages.catalog.addAction")}
            </Button>
          }
        />
      ) : (
        <Table columns={columns} rows={items} />
      )}

      <ProductForm
        open={formState !== null}
        mode={formState?.mode ?? "create"}
        {...(initialValues ? { initialValues } : {})}
        {...(editingProduct ? { productStatus: editingProduct.status } : {})}
        counterparties={counterparties}
        labelTemplates={labelTemplates}
        submitting={createMutation.isPending || updateMutation.isPending}
        onSubmit={handleSubmit}
        onClose={() => setFormState(null)}
      />

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        closeLabel={t("common.close")}
        title={t("pages.catalog.deleteConfirmTitle")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setDeleteTarget(null)}>
              {t("pages.catalog.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={deleteMutation.isPending}
              onClick={() => void handleDelete()}
            >
              {t("pages.catalog.deleteConfirmAction")}
            </Button>
          </>
        }
      >
        {deleteTarget && (
          <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
            {t("pages.catalog.deleteConfirmBody", { name: deleteTarget.name })}
          </p>
        )}
      </Modal>
    </div>
  );
}
