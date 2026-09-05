import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button, Drawer, Input, Select, StatusChip, Table, type TableColumn } from "@markiro/ui";
import type {
  CreateUsProductInput,
  UpdateUsProductInput,
  UsProduct,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError } from "../client.js";
import {
  Pager,
  type ArchiveFilter,
  type MasterDataViewProps,
} from "../master-data/workspace-shared.js";
import { ProductForm, type ProductSaveResult } from "./product-form.js";
import { ProductProfileView, type ProductProfileContext } from "./profile-view.js";

type Detail = { state: "loading" | "error" } | { state: "ready"; product: UsProduct };

export function ProductsView({
  client,
  canWrite,
  mutationPending,
  beginMutation,
  onDirtyChange,
  onNotice,
  onForbidden,
  onClientFailure,
  onSessionLost,
  accessRecovery,
  canManageQa,
  profileCode,
  timeZone,
}: MasterDataViewProps & ProductProfileContext) {
  const { t } = useTranslation();
  const alive = useRef(true);
  const listRun = useRef(0);
  const detailRun = useRef(0);
  const mutating = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusAfterMutation = useRef(false);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState<ArchiveFilter>("false");
  const [offset, setOffset] = useState(0);
  const [products, setProducts] = useState<UsProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [editor, setEditor] = useState<"new" | UsProduct | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [profileProduct, setProfileProduct] = useState<UsProduct | null>(null);

  useEffect(() => {
    if (!mutationPending && focusAfterMutation.current) {
      focusAfterMutation.current = false;
      heading.current?.focus();
    }
  }, [mutationPending, profileProduct]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      listRun.current += 1;
      detailRun.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    const run = ++listRun.current;
    setLoading(true);
    setError(false);
    try {
      const result = await client.listProducts({
        archived,
        limit: 50,
        offset,
        ...(search ? { search } : {}),
      });
      if (alive.current && run === listRun.current) setProducts(result.items);
    } catch (cause) {
      if (!alive.current || run !== listRun.current) return;
      setError(true);
      if (cause instanceof UsClientError && cause.code === "forbidden") {
        setProducts([]);
        await onForbidden();
      } else if (cause instanceof UsClientError && cause.code === "session_required")
        onSessionLost();
    } finally {
      if (alive.current && run === listRun.current) setLoading(false);
    }
  }, [archived, client, offset, onForbidden, onSessionLost, search]);
  useEffect(() => {
    void load();
    return () => {
      listRun.current += 1;
    };
  }, [load]);

  const openProduct = useCallback(
    async (product: UsProduct) => {
      const run = ++detailRun.current;
      setDetail({ state: "loading" });
      setArchiveError(null);
      try {
        const fresh = await client.getProduct(product.id);
        if (alive.current && run === detailRun.current)
          setDetail({ state: "ready", product: fresh });
      } catch (cause) {
        if (!alive.current || run !== detailRun.current) return;
        setDetail({ state: "error" });
        if (cause instanceof UsClientError && cause.code === "forbidden") await onForbidden();
        else onClientFailure(cause, "catalog.detailsError");
      }
    },
    [client, onClientFailure, onForbidden],
  );

  async function save(
    value: CreateUsProductInput | UpdateUsProductInput,
  ): Promise<ProductSaveResult> {
    try {
      if (editor === "new") await client.createProduct(value);
      else if (editor) await client.updateProduct(editor.id, value);
      else return "failed";
      focusAfterMutation.current = true;
      setEditor(null);
      onDirtyChange(false);
      onNotice("status", "catalog.saved");
      await load();
      return "saved";
    } catch (cause) {
      if (cause instanceof UsClientError) {
        if (cause.code === "session_required") onSessionLost();
        if (cause.code === "forbidden") {
          await onForbidden();
          return "forbidden";
        }
        if (cause.code === "product_gtin_locked" || cause.code === "product_gtin_taken")
          return cause.code;
      }
      return "failed";
    }
  }

  async function changeArchive(product: UsProduct) {
    if (mutating.current || mutationPending || !canWrite) return;
    if (!window.confirm(t(product.archived ? "catalog.restoreConfirm" : "catalog.archiveConfirm")))
      return;
    mutating.current = true;
    const release = beginMutation();
    setArchiveError(null);
    try {
      await client.updateProduct(product.id, { archived: !product.archived });
      focusAfterMutation.current = true;
      setDetail(null);
      onNotice("status", product.archived ? "catalog.restored" : "catalog.archived");
      await load();
    } catch (cause) {
      if (cause instanceof UsClientError && cause.code === "forbidden") await onForbidden();
      else if (cause instanceof UsClientError && cause.code === "session_required") onSessionLost();
      else
        setArchiveError(
          cause instanceof UsClientError && cause.code === "product_gtin_taken"
            ? "product_gtin_taken"
            : "archiveFailed",
        );
    } finally {
      mutating.current = false;
      release();
    }
  }

  const columns = useMemo<TableColumn<UsProduct>[]>(
    () => [
      {
        key: "name",
        title: t("catalog.name"),
        render: (product) => (
          <Button
            className="us-md-link"
            variant="secondary"
            size="compact"
            disabled={mutationPending || loading}
            onClick={() => void openProduct(product)}
          >
            {product.name}
          </Button>
        ),
      },
      {
        key: "gtin14",
        title: t("catalog.gtinColumn"),
        render: (product) =>
          product.gtin14 ? (
            <span className="us-catalog-identifier">{product.gtin14}</span>
          ) : (
            <StatusChip status="neutral" label={t("catalog.noGtin")} />
          ),
      },
      {
        key: "archived",
        title: t("md.status"),
        render: (product) => (
          <StatusChip
            status={product.archived ? "neutral" : "ok"}
            label={t(product.archived ? "catalog.archivedStatus" : "catalog.activeStatus")}
          />
        ),
      },
    ],
    [loading, mutationPending, openProduct, t],
  );

  if (profileProduct)
    return (
      <ProductProfileView
        product={profileProduct}
        client={client}
        canWrite={canWrite}
        canManageQa={canManageQa}
        profileCode={profileCode}
        timeZone={timeZone}
        mutationPending={mutationPending}
        beginMutation={beginMutation}
        onDirtyChange={onDirtyChange}
        onNotice={onNotice}
        onForbidden={onForbidden}
        onClientFailure={onClientFailure}
        onSessionLost={onSessionLost}
        onBack={() => {
          focusAfterMutation.current = true;
          onDirtyChange(false);
          setProfileProduct(null);
        }}
      />
    );

  return (
    <>
      <header className="us-md-page-header">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            {t("catalog.products")}
          </h1>
          <p>{t("catalog.intro")}</p>
        </div>
        {canWrite ? (
          <Button disabled={mutationPending} onClick={() => setEditor("new")}>
            {t("catalog.add")}
          </Button>
        ) : null}
      </header>
      <form
        className="us-md-filters"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          setOffset(0);
          setSearch(draft.trim());
        }}
      >
        <Input
          label={t("catalog.search")}
          value={draft}
          maxLength={200}
          disabled={mutationPending}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Select
          native
          label={t("md.status")}
          value={archived}
          disabled={mutationPending}
          onValueChange={(value) => {
            setOffset(0);
            setArchived(value);
          }}
          options={[
            { value: "false", label: t("catalog.activeFilter") },
            { value: "true", label: t("catalog.archivedFilter") },
            { value: "all", label: t("catalog.allFilter") },
          ]}
        />
        <Button type="submit" variant="secondary" disabled={mutationPending}>
          {t("md.search")}
        </Button>
      </form>
      {error ? (
        <div className="us-md-list-state" role="alert">
          <p>{t("catalog.loadError")}</p>
          <Button variant="secondary" onClick={() => void load()} disabled={mutationPending}>
            {t("md.retry")}
          </Button>
        </div>
      ) : (
        <>
          {loading ? (
            <p role="status">{t(products.length ? "catalog.refreshing" : "catalog.loading")}</p>
          ) : null}
          {!loading || products.length ? (
            <Table
              columns={columns}
              rows={products}
              empty={t("catalog.empty")}
              scrollLabel={t("catalog.products")}
            />
          ) : null}
        </>
      )}
      <Pager
        page={offset / 50 + 1}
        hasPrevious={offset > 0}
        hasNext={products.length === 50 && offset < 100000}
        disabled={loading || error || mutationPending}
        onPrevious={() => setOffset((value) => Math.max(0, value - 50))}
        onNext={() => setOffset((value) => value + 50)}
      />
      {editor ? (
        <ProductForm
          key={editor === "new" ? "new" : editor.id}
          {...(editor === "new" ? {} : { product: editor })}
          canWrite={canWrite}
          {...(accessRecovery ? { accessRecovery } : {})}
          onSave={save}
          onClose={() => {
            setEditor(null);
            onDirtyChange(false);
          }}
          beginMutation={beginMutation}
          onDirtyChange={onDirtyChange}
        />
      ) : null}
      {detail ? (
        <Drawer
          open
          className="us-md-drawer"
          title={detail.state === "ready" ? detail.product.name : t("catalog.products")}
          closeLabel={t("catalog.closeDetails")}
          onClose={() => {
            if (!mutating.current) {
              detailRun.current += 1;
              setDetail(null);
            }
          }}
          footer={
            detail.state === "ready" && canWrite ? (
              <>
                <Button
                  variant="secondary"
                  disabled={mutationPending}
                  onClick={() => {
                    setEditor(detail.product);
                    setDetail(null);
                  }}
                >
                  {t("catalog.edit")}
                </Button>
                <Button
                  variant={detail.product.archived ? "secondary" : "destructive-outline"}
                  disabled={mutationPending}
                  onClick={() => void changeArchive(detail.product)}
                >
                  {t(detail.product.archived ? "catalog.restore" : "catalog.archive")}
                </Button>
              </>
            ) : undefined
          }
        >
          {detail.state !== "ready" ? (
            <p role={detail.state === "error" ? "alert" : "status"}>
              {t(detail.state === "error" ? "catalog.detailsError" : "catalog.detailsLoading")}
            </p>
          ) : (
            <>
              {archiveError ? (
                <p role="alert" className="us-md-field-error">
                  {t(`catalog.${archiveError}`)}
                </p>
              ) : null}
              <dl className="us-md-detail-list">
                <dt>{t("catalog.gtinColumn")}</dt>
                <dd className="us-catalog-identifier">
                  {detail.product.gtin14 ?? t("catalog.noGtin")}
                </dd>
                <dt>{t("md.status")}</dt>
                <dd>
                  {t(detail.product.archived ? "catalog.archivedStatus" : "catalog.activeStatus")}
                </dd>
                <dt>{t("catalog.identity")}</dt>
                <dd className="us-catalog-identifier">{detail.product.id}</dd>
              </dl>
              <p>{t("catalog.gtinHint")}</p>
              <Button
                disabled={mutationPending}
                onClick={() => {
                  setProfileProduct(detail.product);
                  setDetail(null);
                }}
              >
                {t("productProfile.open")}
              </Button>
            </>
          )}
        </Drawer>
      ) : null}
    </>
  );
}
