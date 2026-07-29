import { useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { isValidGtin } from "@markiro/domain";
import { Alert, Button, Card, EmptyState, Input, Modal, Select, Spinner, Table } from "@markiro/ui";
import type { SelectOption, TableColumn } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useCreateProduct, useProducts, type ProductDto } from "../catalog/api.js";
import {
  useCandidates,
  useHideCandidate,
  useLinkCandidate,
  useUnhideCandidate,
  type CandidateDto,
} from "./api.js";

interface CreateFormValues {
  gtin: string;
  name: string;
}

/**
 * Manual "link to an existing product" modal -- the only way to resolve a
 * candidate with no suggestion (Task 10 suppresses ambiguous suggestions on
 * purpose, so "no suggestion" is a real, expected state, not a gap to route
 * around) and also how to override a suggestion the operator disagrees
 * with. A 409 on confirm means the chosen product already carries a
 * different external link -- `CandidatesQueue` below surfaces the server's
 * own message for that, not a generic failure.
 */
function LinkModal({
  candidate,
  products,
  linking,
  onConfirm,
  onClose,
  t,
}: {
  candidate: CandidateDto;
  products: ProductDto[];
  linking: boolean;
  onConfirm: (productId: string) => void;
  onClose: () => void;
  t: TFunction;
}) {
  const [productId, setProductId] = useState("");
  const options: SelectOption[] = [
    { value: "", label: t("pages.integrations.channel.candidates.link.choosePlaceholder") },
    ...products.map((p) => ({ value: p.id, label: `${p.name} (${p.gtin14})` })),
  ];

  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t("common.close")}
      title={t("pages.integrations.channel.candidates.link.title", { name: candidate.name })}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("pages.catalog.cancel")}
          </Button>
          <Button
            type="button"
            loading={linking}
            disabled={!productId}
            onClick={() => onConfirm(productId)}
          >
            {t("pages.integrations.channel.candidates.link.confirmAction")}
          </Button>
        </>
      }
    >
      <Select
        label={t("pages.integrations.channel.candidates.link.productLabel")}
        options={options}
        value={productId}
        onChange={setProductId}
      />
    </Modal>
  );
}

/**
 * "Create a card from it" -- the queue's own lightweight create form.
 * Deliberately narrower than the Catalogue's full `ProductForm`: this modal
 * exists only to supply the one field 1С never sends (a GTIN) for a name
 * already known from the exchange, not to duplicate the catalogue's entire
 * create flow. It always still ends in the same atomic `linkCandidate` call
 * the manual-link modal above uses (never a bare product create with
 * `externalRef` set by hand), so a candidate this modal resolves is removed
 * from the queue exactly the way a manually-linked one is -- see
 * `integrations.service.ts`'s `linkCandidate` for why that atomicity matters
 * under concurrent use.
 */
function CreateModal({
  candidate,
  submitting,
  onConfirm,
  onClose,
  t,
}: {
  candidate: CandidateDto;
  submitting: boolean;
  onConfirm: (values: CreateFormValues) => void;
  onClose: () => void;
  t: TFunction;
}) {
  const [gtin, setGtin] = useState("");
  const [name, setName] = useState(candidate.name);
  const [gtinError, setGtinError] = useState<string | null>(null);

  const submit = () => {
    const trimmedGtin = gtin.trim();
    if (!isValidGtin(trimmedGtin)) {
      setGtinError(t("pages.catalog.form.errors.gtinInvalid"));
      return;
    }
    setGtinError(null);
    onConfirm({ gtin: trimmedGtin, name: name.trim() });
  };

  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t("common.close")}
      title={t("pages.integrations.channel.candidates.create.title")}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("pages.catalog.cancel")}
          </Button>
          <Button type="button" loading={submitting} onClick={submit}>
            {t("pages.integrations.channel.candidates.create.confirmAction")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Input
          label={t("pages.catalog.form.gtinLabel")}
          mono
          value={gtin}
          onChange={(event) => setGtin(event.target.value)}
          {...(gtinError ? { error: gtinError } : {})}
        />
        <Input
          label={t("pages.catalog.form.nameLabel")}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
    </Modal>
  );
}

/**
 * The channel page's candidates queue -- Task 14. A sibling area to
 * `JournalList`, not fused with it: brief 08's "the queue itself lives with
 * the channel, next to the journal that explains where the items came
 * from". Self-contained (fetches its own candidates, its own product list
 * for linking, its own mutations) for the same reason `JournalList` is.
 *
 * Three actions per row, always -- link, create, hide/show -- never just
 * "create": the first exchange puts the tenant's entire existing catalogue
 * in this queue (nothing in it carries an external id yet), so a queue that
 * only offers "create" would have the operator duplicate their whole
 * catalogue on day one (brief 08). The bulk "confirm all suggestions"
 * action above the table is what actually gets a tenant through that first
 * exchange in one pass rather than one row at a time.
 */
export function CandidatesQueue({ type }: { type: string }) {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState(false);
  const [linkTarget, setLinkTarget] = useState<CandidateDto | null>(null);
  const [createTarget, setCreateTarget] = useState<CandidateDto | null>(null);

  const { data, isPending, isError } = useCandidates(type, hidden);
  const candidates = useMemo(() => data ?? [], [data]);
  const { data: productsData } = useProducts();
  const products = useMemo(() => productsData ?? [], [productsData]);
  const productNameById = useMemo(
    () => new Map(products.map((p) => [p.id, p.name] as const)),
    [products],
  );

  const linkCandidate = useLinkCandidate(type);
  const hideCandidate = useHideCandidate(type);
  const unhideCandidate = useUnhideCandidate(type);
  const createProduct = useCreateProduct();

  const suggestedCandidates = useMemo(
    () => candidates.filter((c) => c.suggestedProductId !== null),
    [candidates],
  );

  const handleLinkConfirm = async (productId: string) => {
    if (!linkTarget) return;
    try {
      await linkCandidate.mutateAsync({ candidateId: linkTarget.id, productId });
      toast("ok", t("pages.integrations.channel.candidates.link.success"));
      setLinkTarget(null);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.integrations.channel.candidates.link.error"),
      );
    }
  };

  const handleCreateConfirm = async (values: CreateFormValues) => {
    if (!createTarget) return;
    try {
      const product = await createProduct.mutateAsync({ gtin: values.gtin, name: values.name });
      await linkCandidate.mutateAsync({ candidateId: createTarget.id, productId: product.id });
      toast("ok", t("pages.integrations.channel.candidates.create.success"));
      setCreateTarget(null);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.integrations.channel.candidates.create.error"),
      );
    }
  };

  const handleHide = async (candidateId: string) => {
    try {
      await hideCandidate.mutateAsync(candidateId);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.integrations.channel.candidates.hideError"),
      );
    }
  };

  const handleUnhide = async (candidateId: string) => {
    try {
      await unhideCandidate.mutateAsync(candidateId);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.integrations.channel.candidates.unhideError"),
      );
    }
  };

  const handleConfirmAllSuggestions = async () => {
    try {
      await Promise.all(
        suggestedCandidates.map((c) =>
          linkCandidate.mutateAsync({ candidateId: c.id, productId: c.suggestedProductId! }),
        ),
      );
      toast("ok", t("pages.integrations.channel.candidates.confirmAllSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.integrations.channel.candidates.confirmAllError"),
      );
    }
  };

  const columns: TableColumn<CandidateDto>[] = useMemo(
    () => [
      {
        key: "name",
        title: t("pages.integrations.channel.candidates.table.name"),
        render: (row) => (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span>{row.name}</span>
            {row.suggestedProductId && (
              <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
                {t("pages.integrations.channel.candidates.table.suggestion", {
                  name: productNameById.get(row.suggestedProductId) ?? row.suggestedProductId,
                })}
              </span>
            )}
          </div>
        ),
      },
      {
        key: "article",
        title: t("pages.integrations.channel.candidates.table.article"),
        render: (row) => row.article ?? "—",
      },
      {
        key: "externalRef",
        title: t("pages.integrations.channel.candidates.table.externalRef"),
        mono: true,
      },
      {
        key: "actions",
        title: t("pages.integrations.channel.candidates.table.actions"),
        align: "right",
        render: (row) => (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button
              type="button"
              size="compact"
              variant="secondary"
              onClick={() => setLinkTarget(row)}
            >
              {t("pages.integrations.channel.candidates.linkAction")}
            </Button>
            <Button
              type="button"
              size="compact"
              variant="secondary"
              onClick={() => setCreateTarget(row)}
            >
              {t("pages.integrations.channel.candidates.createAction")}
            </Button>
            {hidden ? (
              <Button
                type="button"
                size="compact"
                variant="secondary"
                onClick={() => void handleUnhide(row.id)}
              >
                {t("pages.integrations.channel.candidates.unhideAction")}
              </Button>
            ) : (
              <Button
                type="button"
                size="compact"
                variant="secondary"
                onClick={() => void handleHide(row.id)}
              >
                {t("pages.integrations.channel.candidates.hideAction")}
              </Button>
            )}
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers close over stable mutation objects re-created each render; listing them would invalidate this memo every render for no behavioral difference.
    [t, hidden, productNameById],
  );

  return (
    <Card title={t("pages.integrations.channel.candidates.title")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <label
            style={{ display: "flex", alignItems: "center", gap: 8, font: "var(--text-body)" }}
          >
            <input
              type="checkbox"
              checked={hidden}
              onChange={(event) => setHidden(event.target.checked)}
            />
            {t("pages.integrations.channel.candidates.showHiddenLabel")}
          </label>

          {!hidden && suggestedCandidates.length > 0 && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleConfirmAllSuggestions()}
            >
              {t("pages.integrations.channel.candidates.confirmAllAction")}
            </Button>
          )}
        </div>

        {isPending ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
            <Spinner label={t("common.loading")} />
          </div>
        ) : isError ? (
          <Alert tone="error">{t("pages.integrations.channel.candidates.loadError")}</Alert>
        ) : candidates.length === 0 ? (
          <EmptyState
            title={t("pages.integrations.channel.candidates.emptyTitle")}
            hint={t("pages.integrations.channel.candidates.emptyHint")}
          />
        ) : (
          <Table columns={columns} rows={candidates} />
        )}
      </div>

      {linkTarget && (
        <LinkModal
          candidate={linkTarget}
          products={products}
          linking={linkCandidate.isPending}
          onConfirm={(productId) => void handleLinkConfirm(productId)}
          onClose={() => setLinkTarget(null)}
          t={t}
        />
      )}

      {createTarget && (
        <CreateModal
          candidate={createTarget}
          submitting={createProduct.isPending || linkCandidate.isPending}
          onConfirm={(values) => void handleCreateConfirm(values)}
          onClose={() => setCreateTarget(null)}
          t={t}
        />
      )}
    </Card>
  );
}
