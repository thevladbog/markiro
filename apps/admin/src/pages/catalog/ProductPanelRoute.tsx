import { Alert, Button, ConfirmDialog, SidePanel, Spinner } from "@markiro/ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useRoutePanelGuard } from "../../lib/useRoutePanelGuard.js";
import type { CounterpartyDto } from "../counterparties/api.js";
import type { LabelTemplateSummaryDto } from "../labels/api.js";
import {
  useCreateProduct,
  useUpdateProduct,
  type CreateProductInput,
  type ProductDto,
} from "./api.js";
import { ProductForm, type ProductFormValues } from "./ProductForm.js";

export interface CatalogPanelContext {
  products: ProductDto[];
  productsPending: boolean;
  productsError: boolean;
  counterparties: CounterpartyDto[];
  counterpartiesPending: boolean;
  counterpartiesError: boolean;
  labelTemplates: LabelTemplateSummaryDto[];
  labelTemplatesPending: boolean;
  labelTemplatesError: boolean;
  retryPanelData: () => Promise<void>;
}

export type CatalogPanelLocationState = { catalogBackground: true };

export function closeCatalogPanel(
  location: ReturnType<typeof useLocation>,
  navigate: ReturnType<typeof useNavigate>,
) {
  if ((location.state as CatalogPanelLocationState | null)?.catalogBackground === true) {
    void navigate(-1);
  } else {
    void navigate("/catalog", { replace: true });
  }
}

export function ProductPanelRoute({ mode }: { mode: "create" | "edit" }) {
  return mode === "create" ? <CreateProductPanel /> : <EditProductPanel />;
}

function usePanelContext() {
  const { t } = useTranslation();
  const context = useOutletContext<CatalogPanelContext>();
  const location = useLocation();
  const navigate = useNavigate();
  const loading =
    context.productsPending || context.counterpartiesPending || context.labelTemplatesPending;
  const failed =
    context.productsError || context.counterpartiesError || context.labelTemplatesError;
  const close = () => closeCatalogPanel(location, navigate);
  return { t, context, loading, failed, close };
}

function PanelState({ mode }: { mode: "create" | "edit" }) {
  const { t, context, loading, failed, close } = usePanelContext();
  const title = t(`pages.catalog.form.${mode === "create" ? "createTitle" : "editTitle"}`);
  if (loading)
    return (
      <SidePanel open title={title} closeLabel={t("common.close")} onClose={close}>
        <Spinner label={t("common.loading")} />
      </SidePanel>
    );
  if (failed)
    return (
      <SidePanel open title={title} closeLabel={t("common.close")} onClose={close}>
        <Alert tone="error">{t("pages.catalog.form.loadError")}</Alert>
        <Button onClick={() => void context.retryPanelData()}>
          {t("pages.catalog.form.retry")}
        </Button>
      </SidePanel>
    );
  return null;
}

function CreateProductPanel() {
  const { t, context, loading, failed, close } = usePanelContext();
  const mutation = useCreateProduct();
  const [error, setError] = useState<string | null>(null);
  const guard = useRoutePanelGuard(close, mutation.isPending);
  if (loading || failed) return <PanelState mode="create" />;
  return (
    <>
      <ProductForm
        mode="create"
        counterparties={context.counterparties}
        labelTemplates={context.labelTemplates}
        submitting={mutation.isPending}
        submissionError={error}
        onDirtyChange={guard.setDirty}
        onClose={guard.requestClose}
        onSubmit={async (input) => {
          try {
            setError(null);
            await mutation.mutateAsync(input);
            toast("ok", t("pages.catalog.toasts.createSuccess"));
            guard.finish();
          } catch (cause) {
            setError(
              cause instanceof ApiRequestError
                ? cause.message
                : t("pages.catalog.toasts.createError"),
            );
          }
        }}
      />
      {guard.confirmOpen ? (
        <ConfirmDialog
          open
          title={t("pages.catalog.form.discardTitle")}
          description={t("pages.catalog.form.discardBody")}
          cancelLabel={t("pages.catalog.form.continueEditing")}
          confirmLabel={t("pages.catalog.form.discardAction")}
          tone="destructive"
          onCancel={guard.cancelDiscard}
          onConfirm={guard.confirmDiscard}
        />
      ) : null}
    </>
  );
}

function EditProductPanel() {
  const { productId } = useParams();
  const { t, context, loading, failed, close } = usePanelContext();
  const mutation = useUpdateProduct();
  const [error, setError] = useState<string | null>(null);
  const guard = useRoutePanelGuard(close, mutation.isPending);
  const product = context.products.find((item) => item.id === productId);
  const initialValues = useMemo<ProductFormValues | undefined>(
    () =>
      product
        ? {
            gtin: product.gtin14,
            name: product.name,
            productGroup: product.productGroup ?? "",
            boxCapacity: product.boxCapacity === null ? "" : String(product.boxCapacity),
            palletCapacity: product.palletCapacity === null ? "" : String(product.palletCapacity),
            unitPrice: product.unitPrice ?? "",
            egaisCode: product.egaisCode ?? "",
            defaultCounterpartyId: product.defaultCounterpartyId ?? "",
            defaultLabelTemplateId: product.defaultLabelTemplateId ?? "",
          }
        : undefined,
    // Exclude the product object itself: an external-link-only refetch must not reset dirty fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      product?.boxCapacity,
      product?.defaultCounterpartyId,
      product?.defaultLabelTemplateId,
      product?.egaisCode,
      product?.gtin14,
      product?.name,
      product?.palletCapacity,
      product?.productGroup,
      product?.unitPrice,
    ],
  );
  if (loading || failed) return <PanelState mode="edit" />;
  if (!product || !initialValues)
    return (
      <SidePanel
        open
        title={t("pages.catalog.form.editTitle")}
        closeLabel={t("common.close")}
        onClose={close}
      >
        <p>{t("pages.catalog.form.notFound")}</p>
      </SidePanel>
    );
  return (
    <>
      <ProductForm
        mode="edit"
        initialValues={initialValues}
        productStatus={product.status}
        productId={product.id}
        externalRef={product.externalRef}
        counterparties={context.counterparties}
        labelTemplates={context.labelTemplates}
        submitting={mutation.isPending}
        submissionError={error}
        onDirtyChange={guard.setDirty}
        onClose={guard.requestClose}
        onSubmit={async (input: CreateProductInput) => {
          try {
            setError(null);
            await mutation.mutateAsync({ id: product.id, input });
            toast("ok", t("pages.catalog.toasts.updateSuccess"));
            guard.finish();
          } catch (cause) {
            setError(
              cause instanceof ApiRequestError
                ? cause.message
                : t("pages.catalog.toasts.updateError"),
            );
          }
        }}
      />
      {guard.confirmOpen ? (
        <ConfirmDialog
          open
          title={t("pages.catalog.form.discardTitle")}
          description={t("pages.catalog.form.discardBody")}
          cancelLabel={t("pages.catalog.form.continueEditing")}
          confirmLabel={t("pages.catalog.form.discardAction")}
          tone="destructive"
          onCancel={guard.cancelDiscard}
          onConfirm={guard.confirmDiscard}
        />
      ) : null}
    </>
  );
}
