import { Alert, Button, ConfirmDialog, SidePanel, Spinner } from "@markiro/ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useBlocker, useLocation, useNavigate, useOutletContext, useParams } from "react-router";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
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

function PanelState({ mode, children }: { mode: "create" | "edit"; children: ReactNode }) {
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
  return children;
}

function useDirtyGuard(close: () => void, busy: boolean) {
  const [dirty, setDirty] = useState(false);
  const [pendingDismiss, setPendingDismiss] = useState(false);
  const allowNavigationRef = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !allowNavigationRef.current &&
      (dirty || busy) &&
      currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (busy) blocker.reset();
    else setPendingDismiss(true);
  }, [blocker, busy]);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setPendingDismiss(true);
    else close();
  };
  const cancel = () => {
    setPendingDismiss(false);
    if (blocker.state === "blocked") blocker.reset();
  };
  const discard = () => {
    allowNavigationRef.current = true;
    setDirty(false);
    setPendingDismiss(false);
    if (blocker.state === "blocked") blocker.proceed();
    else close();
  };
  const finish = () => {
    allowNavigationRef.current = true;
    setDirty(false);
    close();
  };
  return { setDirty, requestClose, confirmOpen: dirty && pendingDismiss, cancel, discard, finish };
}

function CreateProductPanel() {
  const { t, context, loading, failed, close } = usePanelContext();
  const mutation = useCreateProduct();
  const [error, setError] = useState<string | null>(null);
  const guard = useDirtyGuard(close, mutation.isPending);
  if (loading || failed)
    return (
      <PanelState mode="create">
        <></>
      </PanelState>
    );
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
          onCancel={guard.cancel}
          onConfirm={guard.discard}
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
  const guard = useDirtyGuard(close, mutation.isPending);
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
  if (loading || failed)
    return (
      <PanelState mode="edit">
        <></>
      </PanelState>
    );
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
          onCancel={guard.cancel}
          onConfirm={guard.discard}
        />
      ) : null}
    </>
  );
}
