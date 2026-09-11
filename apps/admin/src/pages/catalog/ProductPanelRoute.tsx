import { CABINET_CAPABILITY } from "@markiro/domain";
import { useCan } from "../../access/context.js";
import { Alert, Button, ConfirmDialog, SidePanel, Spinner } from "@markiro/ui";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { ProductRegulatorySections } from "./regulatory/ProductRegulatorySections.js";

export interface CatalogPanelContext {
  products: ProductDto[];
  productsPending: boolean;
  productsError: boolean;
  productsAvailable: boolean;
  counterparties: CounterpartyDto[];
  counterpartiesPending: boolean;
  counterpartiesError: boolean;
  counterpartiesAvailable: boolean;
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
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  return mode === "create" ? (
    <CreateProductPanel />
  ) : canWrite ? (
    <EditProductPanel />
  ) : (
    <ReadProductPanel />
  );
}

function usePanelContext() {
  const { t } = useTranslation();
  const context = useOutletContext<CatalogPanelContext>();
  const location = useLocation();
  const navigate = useNavigate();
  const loading = context.productsPending || context.counterpartiesPending;
  const failed =
    (context.productsError && !context.productsAvailable) ||
    (context.counterpartiesError && !context.counterpartiesAvailable);
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
  const navigate = useNavigate();
  const destination = useRef<string | null>(null);
  const guard = useRoutePanelGuard(() => {
    if (destination.current) void navigate(destination.current, { replace: true });
    else close();
  }, mutation.isPending || imageMutation.isPending);
  const createdInitialValues = useMemo<ProductFormValues | undefined>(
    () =>
      createdProduct
        ? {
            gtin: createdProduct.gtin14,
            name: createdProduct.name,
            printName: createdProduct.printName ?? "",
            chzProductGroupCode: String(createdProduct.chzProductGroupCode ?? ""),
            boxCapacity:
              createdProduct.boxCapacity === null ? "" : String(createdProduct.boxCapacity),
            palletCapacity:
              createdProduct.palletCapacity === null ? "" : String(createdProduct.palletCapacity),
            unitPrice: createdProduct.unitPrice ?? "",
            egaisCode: createdProduct.egaisCode ?? "",
            shelfLifeDays:
              createdProduct.shelfLifeDays === null ? "" : String(createdProduct.shelfLifeDays),
            defaultCounterpartyId: createdProduct.defaultCounterpartyId ?? "",
            // `?? false` guards a rolling deploy where the API predates the field.
            archived: createdProduct.archived ?? false,
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
            destination.current = `/catalog/${encodeURIComponent(created.id)}/edit`;
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
  const [gtinError, setGtinError] = useState<string | null>(null);
  const [baseDirty, setBaseDirty] = useState(false);
  const [regulatoryDirty, setRegulatoryDirty] = useState(false);
  const [regulatoryBusy, setRegulatoryBusy] = useState(false);
  const [profileBound, setProfileBound] = useState(true);
  const guard = useRoutePanelGuard(
    close,
    mutation.isPending ||
      imageMutation.isPending ||
      deleteImageMutation.isPending ||
      regulatoryBusy,
  );
  const setGuardDirty = guard.setDirty;
  useEffect(
    () => setGuardDirty(baseDirty || regulatoryDirty),
    [baseDirty, regulatoryDirty, setGuardDirty],
  );
  const product = context.products.find((item) => item.id === productId);
  const initialValues = useMemo<ProductFormValues | undefined>(
    () =>
      product
        ? {
            gtin: product.gtin14,
            name: product.name,
            printName: product.printName ?? "",
            chzProductGroupCode: String(product.chzProductGroupCode ?? ""),
            boxCapacity: product.boxCapacity === null ? "" : String(product.boxCapacity),
            palletCapacity: product.palletCapacity === null ? "" : String(product.palletCapacity),
            unitPrice: product.unitPrice ?? "",
            egaisCode: product.egaisCode ?? "",
            shelfLifeDays: product.shelfLifeDays === null ? "" : String(product.shelfLifeDays),
            defaultCounterpartyId: product.defaultCounterpartyId ?? "",
            // `?? false` guards a rolling deploy where the API predates the field.
            archived: product.archived ?? false,
          }
        : undefined,
    // Exclude the product object itself: an external-link-only refetch must not reset dirty fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      product?.archived,
      product?.boxCapacity,
      product?.chzProductGroupCode,
      product?.defaultCounterpartyId,
      product?.egaisCode,
      product?.gtin14,
      product?.name,
      product?.printName,
      product?.palletCapacity,
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
        regulatoryDirty={regulatoryDirty}
        regulatoryBusy={regulatoryBusy}
        profileBound={profileBound}
        regulatoryContent={
          <>
            {(context.productsError || context.counterpartiesError) && (
              <Alert
                tone="warn"
                action={
                  <Button onClick={() => void context.retryPanelData()}>
                    {t("pages.catalog.form.retry")}
                  </Button>
                }
              >
                {t("pages.catalog.regulatory.cachedDataError")}
              </Alert>
            )}
            <ProductRegulatorySections
              key={product.id}
              product={product}
              disabled={
                baseDirty ||
                mutation.isPending ||
                imageMutation.isPending ||
                deleteImageMutation.isPending
              }
              onDirtyChange={setRegulatoryDirty}
              onBusyChange={setRegulatoryBusy}
              onProfileBoundChange={setProfileBound}
            />
          </>
        }
        productId={product.id}
        externalRef={product.externalRef}
        {...(product.chz ? { chzSummary: product.chz } : {})}
        gtinSubmissionError={gtinError}
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
        onDirtyChange={setBaseDirty}
        onClose={guard.requestClose}
        onSubmit={async (input: CreateProductInput, image, detach) => {
          setError(null);
          setGtinError(null);
          try {
            await mutation.mutateAsync({
              id: product.id,
              input: { ...input, ...(detach ? { chzLinkChange: detach } : {}) },
            });
          } catch (cause) {
            if (
              cause instanceof ApiRequestError &&
              cause.status === 409 &&
              ["CHZ_LINK_REQUIRES_DETACH", "link_changed"].includes(cause.code ?? cause.message)
            ) {
              setGtinError(t("pages.catalog.chz.gtinConflict"));
            } else {
              setError(
                cause instanceof ApiRequestError
                  ? cause.message
                  : t("pages.catalog.toasts.updateError"),
              );
            }
            return;
          }
          if (image) {
            try {
              await imageMutation.mutateAsync({ id: product.id, file: image });
            } catch (cause) {
              setError(
                cause instanceof ApiRequestError
                  ? cause.message
                  : t("pages.catalog.form.imageError"),
              );
              return;
            }
          }
          toast("ok", t("pages.catalog.toasts.updateSuccess"));
          guard.finish();
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

const ignoreDirty = () => {};
function ReadProductPanel() {
  const { productId } = useParams();
  const { t, context, loading, failed, close } = usePanelContext();
  if (loading || failed) return <PanelState mode="edit" />;
  const product = context.products.find((item) => item.id === productId);
  return (
    <SidePanel
      open
      title={t("pages.catalog.regulatory.viewTitle")}
      closeLabel={t("common.close")}
      onClose={close}
    >
      {product ? (
        <>
          <section className="mk-catalog-panel-section">
            <h3>{product.name}</h3>
            <dl className="mk-regulatory-binding">
              <dt>{t("pages.catalog.form.gtinLabel")}</dt>
              <dd>{product.gtin14}</dd>
              <dt>{t("pages.catalog.table.productGroup")}</dt>
              <dd>{product.productGroup ?? "—"}</dd>
              <dt>{t("pages.catalog.table.boxCapacity")}</dt>
              <dd>{product.boxCapacity ?? "—"}</dd>
            </dl>
          </section>
          <ProductRegulatorySections product={product} onDirtyChange={ignoreDirty} />
        </>
      ) : (
        <p>{t("pages.catalog.form.notFound")}</p>
      )}
    </SidePanel>
  );
}
