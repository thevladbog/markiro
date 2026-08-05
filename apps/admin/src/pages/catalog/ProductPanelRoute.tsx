import { Alert, Button, ConfirmDialog, SidePanel, Spinner } from "@markiro/ui";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router";

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

function PanelState({ children }: { children: ReactNode }) {
  const { t, context, loading, failed, close } = usePanelContext();
  if (loading)
    return (
      <SidePanel
        open
        title={t("pages.catalog.form.createTitle")}
        closeLabel={t("common.close")}
        onClose={close}
      >
        <Spinner label={t("common.loading")} />
      </SidePanel>
    );
  if (failed)
    return (
      <SidePanel
        open
        title={t("pages.catalog.form.createTitle")}
        closeLabel={t("common.close")}
        onClose={close}
      >
        <Alert tone="error">{t("common.loadError")}</Alert>
        <Button onClick={() => void context.retryPanelData()}>Повторить</Button>
      </SidePanel>
    );
  return children;
}

function useDirtyGuard(close: () => void, busy: boolean) {
  const [dirty, setDirty] = useState(false);
  const [pendingDismiss, setPendingDismiss] = useState(false);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setPendingDismiss(true);
    else close();
  };
  const cancel = () => {
    setPendingDismiss(false);
  };
  const discard = () => {
    setDirty(false);
    setPendingDismiss(false);
    close();
  };
  return { setDirty, requestClose, confirmOpen: dirty && pendingDismiss, cancel, discard };
}

function CreateProductPanel() {
  const { t, context, loading, failed, close } = usePanelContext();
  const mutation = useCreateProduct();
  const [error, setError] = useState<string | null>(null);
  const guard = useDirtyGuard(close, mutation.isPending);
  if (loading || failed)
    return (
      <PanelState>
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
            close();
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
          title="Отменить изменения?"
          description="Несохранённые изменения будут потеряны."
          cancelLabel="Продолжить редактирование"
          confirmLabel="Не сохранять"
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
  if (loading || failed)
    return (
      <PanelState>
        <></>
      </PanelState>
    );
  if (!product)
    return (
      <SidePanel
        open
        title={t("pages.catalog.form.editTitle")}
        closeLabel={t("common.close")}
        onClose={close}
      >
        <p>Продукт не найден.</p>
      </SidePanel>
    );
  const initialValues: ProductFormValues = {
    gtin: product.gtin14,
    name: product.name,
    productGroup: product.productGroup ?? "",
    boxCapacity: product.boxCapacity === null ? "" : String(product.boxCapacity),
    palletCapacity: product.palletCapacity === null ? "" : String(product.palletCapacity),
    unitPrice: product.unitPrice ?? "",
    egaisCode: product.egaisCode ?? "",
    defaultCounterpartyId: product.defaultCounterpartyId ?? "",
    defaultLabelTemplateId: product.defaultLabelTemplateId ?? "",
  };
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
            close();
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
          title="Отменить изменения?"
          description="Несохранённые изменения будут потеряны."
          cancelLabel="Продолжить редактирование"
          confirmLabel="Не сохранять"
          tone="destructive"
          onCancel={guard.cancel}
          onConfirm={guard.discard}
        />
      ) : null}
    </>
  );
}
