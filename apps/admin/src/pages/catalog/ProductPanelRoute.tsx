import { Alert, Button, ConfirmDialog, SidePanel, Spinner } from "@markiro/ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useRoutePanelGuard } from "../../lib/useRoutePanelGuard.js";
import type { CounterpartyDto } from "../counterparties/api.js";
import {
  useCreateProduct,
  useUpdateProduct,
  useUploadProductImage,
  useDeleteProductImage,
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
  const loading = context.productsPending || context.counterpartiesPending;
  const failed = context.productsError || context.counterpartiesError;
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
  const imageMutation = useUploadProductImage();
  const [error, setError] = useState<string | null>(null);
  const [createdProduct, setCreatedProduct] = useState<ProductDto | null>(null);
  const guard = useRoutePanelGuard(close, mutation.isPending || imageMutation.isPending);
  const createdInitialValues = useMemo<ProductFormValues | undefined>(
    () =>
      createdProduct
        ? {
            gtin: createdProduct.gtin14,
            name: createdProduct.name,
            printName: createdProduct.printName ?? "",
            productGroup: createdProduct.productGroup ?? "",
            boxCapacity:
              createdProduct.boxCapacity === null ? "" : String(createdProduct.boxCapacity),
            palletCapacity:
              createdProduct.palletCapacity === null ? "" : String(createdProduct.palletCapacity),
            unitPrice: createdProduct.unitPrice ?? "",
            egaisCode: createdProduct.egaisCode ?? "",
            shelfLifeDays:
              createdProduct.shelfLifeDays === null ? "" : String(createdProduct.shelfLifeDays),
            defaultCounterpartyId: createdProduct.defaultCounterpartyId ?? "",
          }
        : undefined,
    [createdProduct],
  );
  if (loading || failed) return <PanelState mode="create" />;
  return (
    <>
      <ProductForm
        mode={createdProduct ? "edit" : "create"}
        {...(createdInitialValues ? { initialValues: createdInitialValues } : {})}
        {...(createdProduct
          ? { productId: createdProduct.id, imageAltName: createdProduct.name }
          : {})}
        counterparties={context.counterparties}
        submitting={mutation.isPending || imageMutation.isPending}
        submissionError={error}
        onDirtyChange={guard.setDirty}
        onClose={guard.requestClose}
        onSubmit={async (input, image) => {
          try {
            setError(null);
            const created = createdProduct ?? (await mutation.mutateAsync(input));
            if (image) {
              try {
                await imageMutation.mutateAsync({ id: created.id, file: image });
              } catch (cause) {
                setCreatedProduct(created);
                setError(t("pages.catalog.form.imageError"));
                throw cause;
              }
            }
            toast("ok", t("pages.catalog.toasts.createSuccess"));
            guard.finish();
          } catch (cause) {
            if (!createdProduct) {
              setError(
                cause instanceof ApiRequestError
                  ? cause.message
                  : t("pages.catalog.toasts.createError"),
              );
            }
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
  const imageMutation = useUploadProductImage();
  const deleteImageMutation = useDeleteProductImage();
  const [error, setError] = useState<string | null>(null);
  const guard = useRoutePanelGuard(
    close,
    mutation.isPending || imageMutation.isPending || deleteImageMutation.isPending,
  );
  const product = context.products.find((item) => item.id === productId);
  const initialValues = useMemo<ProductFormValues | undefined>(
    () =>
      product
        ? {
            gtin: product.gtin14,
            name: product.name,
            printName: product.printName ?? "",
            productGroup: product.productGroup ?? "",
            boxCapacity: product.boxCapacity === null ? "" : String(product.boxCapacity),
            palletCapacity: product.palletCapacity === null ? "" : String(product.palletCapacity),
            unitPrice: product.unitPrice ?? "",
            egaisCode: product.egaisCode ?? "",
            shelfLifeDays: product.shelfLifeDays === null ? "" : String(product.shelfLifeDays),
            defaultCounterpartyId: product.defaultCounterpartyId ?? "",
          }
        : undefined,
    // Exclude the product object itself: an external-link-only refetch must not reset dirty fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      product?.boxCapacity,
      product?.defaultCounterpartyId,
      product?.egaisCode,
      product?.gtin14,
      product?.name,
      product?.printName,
      product?.palletCapacity,
      product?.productGroup,
      product?.shelfLifeDays,
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
        submitting={mutation.isPending || imageMutation.isPending}
        {...(product.image ? { image: product.image } : {})}
        imageAltName={product.name}
        imageBusy={deleteImageMutation.isPending}
        onDeleteImage={async () => {
          try {
            setError(null);
            await deleteImageMutation.mutateAsync(product.id);
            toast("ok", t("pages.catalog.form.imageRemoveSuccess"));
          } catch (cause) {
            setError(
              cause instanceof ApiRequestError ? cause.message : t("pages.catalog.form.imageError"),
            );
          }
        }}
        submissionError={error}
        onDirtyChange={guard.setDirty}
        onClose={guard.requestClose}
        onSubmit={async (input: CreateProductInput, image) => {
          try {
            setError(null);
            await mutation.mutateAsync({ id: product.id, input });
            if (image) await imageMutation.mutateAsync({ id: product.id, file: image });
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
