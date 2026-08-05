import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

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

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useCounterparties, type CounterpartyDto } from "../counterparties/api.js";
import { useCandidates } from "../integrations/api.js";
import { useLabelTemplates, type LabelTemplateSummaryDto } from "../labels/api.js";
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

/**
 * The channel this plaque points into. Hardcoded rather than looped over
 * every channel: `commerceml` is the only channel that produces
 * `integration_candidates` rows today (see
 * `apps/api/src/modules/integrations/integrations.service.ts`'s
 * `unlinkProduct` doc comment, which hardcodes the same assumption on the
 * server side) -- there is exactly one queue to point at, not several to
 * pick from.
 */
const CANDIDATES_CHANNEL_TYPE = "commerceml";

type StatusFilter = "all" | ProductStatus;

/** Debounce delay (ms) between the last keystroke in the search box and the refetch. */
const SEARCH_DEBOUNCE_MS = 300;

interface CatalogFormOptions {
  counterparties: CounterpartyDto[];
  labelTemplates: LabelTemplateSummaryDto[];
}

function AuthorizedCreateProductAction({ counterparties, labelTemplates }: CatalogFormOptions) {
  const { t } = useTranslation();
  const createMutation = useCreateProduct();
  const [open, setOpen] = useState(false);

  const handleSubmit = async (input: CreateProductInput) => {
    try {
      await createMutation.mutateAsync(input);
      toast("ok", t("pages.catalog.toasts.createSuccess"));
      setOpen(false);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.catalog.toasts.createError"),
      );
    }
  };

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {t("pages.catalog.addAction")}
      </Button>
      {open ? (
        <ProductForm
          open
          mode="create"
          counterparties={counterparties}
          labelTemplates={labelTemplates}
          submitting={createMutation.isPending}
          onSubmit={handleSubmit}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * Keeps the integrations-only candidates query out of the catalog route for
 * operators who can read products but not integrations. This must remain a
 * child rather than an `enabled` option on the parent hook: cached candidate
 * data must not be read into the catalog render tree before the capability
 * check succeeds.
 */
function AuthorizedCandidatesPlaque() {
  const { t } = useTranslation();
  const { data: candidatesData } = useCandidates(CANDIDATES_CHANNEL_TYPE, false);
  const candidatesCount = candidatesData?.length ?? 0;

  if (candidatesCount === 0) return null;

  return (
    <Alert
      tone="info"
      action={
        <Link
          to={`/integrations/${CANDIDATES_CHANNEL_TYPE}`}
          style={{ font: "600 13px/18px var(--font-ui)", color: "var(--info-fg)" }}
        >
          {t("pages.catalog.candidatesPlaque.action")}
        </Link>
      }
    >
      {t("pages.catalog.candidatesPlaque.text", { count: candidatesCount })}
    </Alert>
  );
}

function AuthorizedProductRowActions({
  product,
  counterparties,
  labelTemplates,
}: CatalogFormOptions & { product: ProductDto }) {
  const { t } = useTranslation();
  const updateMutation = useUpdateProduct();
  const deleteMutation = useDeleteProduct();
  const [editingProduct, setEditingProduct] = useState<ProductDto | null>(null);
  const [deleting, setDeleting] = useState(false);

  const initialValues: ProductFormValues | undefined = useMemo(
    () =>
      editingProduct
        ? {
            gtin: editingProduct.gtin14,
            name: editingProduct.name,
            productGroup: editingProduct.productGroup ?? "",
            boxCapacity:
              editingProduct.boxCapacity !== null ? String(editingProduct.boxCapacity) : "",
            palletCapacity:
              editingProduct.palletCapacity !== null ? String(editingProduct.palletCapacity) : "",
            unitPrice: editingProduct.unitPrice ?? "",
            egaisCode: editingProduct.egaisCode ?? "",
            defaultCounterpartyId: editingProduct.defaultCounterpartyId ?? "",
            defaultLabelTemplateId: editingProduct.defaultLabelTemplateId ?? "",
          }
        : undefined,
    [editingProduct],
  );

  const handleUpdate = async (input: CreateProductInput) => {
    if (!editingProduct) return;
    try {
      await updateMutation.mutateAsync({ id: editingProduct.id, input });
      toast("ok", t("pages.catalog.toasts.updateSuccess"));
      setEditingProduct(null);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.catalog.toasts.updateError"),
      );
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(product.id);
      toast("ok", t("pages.catalog.toasts.deleteSuccess"));
      setDeleting(false);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.catalog.toasts.deleteError"),
      );
    }
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Button
          type="button"
          size="compact"
          variant="secondary"
          onClick={() => setEditingProduct(product)}
        >
          {t("pages.catalog.edit")}
        </Button>
        <Button
          type="button"
          size="compact"
          variant="destructive"
          onClick={() => setDeleting(true)}
        >
          {t("pages.catalog.delete")}
        </Button>
      </div>
      {editingProduct && initialValues ? (
        <ProductForm
          open
          mode="edit"
          initialValues={initialValues}
          productStatus={editingProduct.status}
          productId={editingProduct.id}
          externalRef={editingProduct.externalRef}
          counterparties={counterparties}
          labelTemplates={labelTemplates}
          submitting={updateMutation.isPending}
          onSubmit={handleUpdate}
          onClose={() => setEditingProduct(null)}
        />
      ) : null}
      <Modal
        open={deleting}
        onClose={() => setDeleting(false)}
        closeLabel={t("common.close")}
        title={t("pages.catalog.deleteConfirmTitle")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setDeleting(false)}>
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
        <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
          {t("pages.catalog.deleteConfirmBody", { name: product.name })}
        </p>
      </Modal>
    </>
  );
}

/** Admin product catalog CRUD screen -- Plan 03 Task 12 (list/create/edit/delete + GTIN owner hint). */
export function CatalogPage() {
  const { t } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const canReadIntegrations = useCan(CABINET_CAPABILITY.INTEGRATIONS_READ);

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
  const items = data ?? [];
  const counterparties = useMemo(() => counterpartiesData ?? [], [counterpartiesData]);
  const labelTemplates = useMemo(() => labelTemplatesData ?? [], [labelTemplatesData]);

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
        render: (row) =>
          canWrite ? (
            <AuthorizedProductRowActions
              product={row}
              counterparties={counterparties}
              labelTemplates={labelTemplates}
            />
          ) : null,
      },
    ],
    [t, canWrite, counterparties, labelTemplates],
  );

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.catalog.title")}
        actions={
          canWrite ? (
            <AuthorizedCreateProductAction
              counterparties={counterparties}
              labelTemplates={labelTemplates}
            />
          ) : null
        }
      />

      {canReadIntegrations ? <AuthorizedCandidatesPlaque /> : null}

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
            onValueChange={(value) => setStatusFilter(value as StatusFilter)}
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
            canWrite ? (
              <AuthorizedCreateProductAction
                counterparties={counterparties}
                labelTemplates={labelTemplates}
              />
            ) : null
          }
        />
      ) : (
        <Table columns={columns} rows={items} />
      )}
    </div>
  );
}
