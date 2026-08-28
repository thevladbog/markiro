import { useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";

import { isValidGtin } from "@markiro/domain";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
} from "@markiro/ui";
import type { SelectOption, TableColumn } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useCreateProduct, useProducts, type ProductDto } from "../catalog/api.js";
import {
  linkCandidateRequest,
  useCandidates,
  useHideCandidate,
  useLinkCandidate,
  useUnhideCandidate,
  type CandidateDto,
} from "./api.js";

/**
 * How many "confirm all suggestions" link requests run at once (Task 14
 * follow-up, review). The first exchange can queue the tenant's entire
 * catalogue as candidates -- firing every link request simultaneously meant
 * hundreds of concurrent POSTs. A small worker pool keeps the browser (and
 * the server) from being hit with the whole batch at once while still
 * running well ahead of one-at-a-time.
 */
const CONFIRM_ALL_CONCURRENCY = 5;

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
        onValueChange={setProductId}
      />
    </Modal>
  );
}

/**
 * "Create a card from it" -- the queue's own lightweight create form.
 * Deliberately narrower than the Catalogue's full `ProductForm`: this modal
 * exists only to supply the one field 1С never sends (a GTIN) for a name
 * already known from the exchange, not to duplicate the catalogue's entire
 * create flow. It always still ends in the same `linkCandidate` call the
 * manual-link modal above uses (never a bare product create with
 * `externalRef` set by hand), so a candidate this modal resolves is removed
 * from the queue exactly the way a manually-linked one is -- see
 * `integrations.service.ts`'s `linkCandidate` for why ITS OWN atomicity
 * (a single `UPDATE ... WHERE external_ref IS NULL`) matters under
 * concurrent use.
 *
 * Accepted limitation (final review, Fix 9): `handleCreateConfirm` below is
 * two independent requests, `createProduct` then `linkCandidate` -- NOT one
 * atomic operation, and there is no rollback between them. If the create
 * succeeds and the link fails (a dropped connection, a 409 from some other
 * concurrent change), the operator is left with a real, unlinked product and
 * this candidate still sitting in the queue -- recoverable by hand (link the
 * new product from the queue, or delete it), but not undone automatically.
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
  const queryClient = useQueryClient();
  const [hidden, setHidden] = useState(false);
  const [linkTarget, setLinkTarget] = useState<CandidateDto | null>(null);
  const [createTarget, setCreateTarget] = useState<CandidateDto | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);

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
      toast("ok", t("pages.integrations.channel.candidates.hideSuccess"));
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
      toast("ok", t("pages.integrations.channel.candidates.unhideSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.integrations.channel.candidates.unhideError"),
      );
    }
  };

  /**
   * Fix (review, Task 14 follow-up): this used to fan the batch out through
   * `Promise.all` and show one binary toast. `Promise.all` rejects on the
   * *first* rejection -- one candidate hitting the server's atomic
   * `UPDATE ... WHERE external_ref IS NULL` 409 (a real, expected outcome
   * under concurrent use, not a bug) meant the operator saw a single
   * nondeterministic error toast with no idea the other 49 out of 50 had
   * actually gone through. That is exactly the "confidently wrong" answer
   * this whole plan exists to avoid. Every candidate now resolves
   * independently (via a bounded worker pool, see `CONFIRM_ALL_CONCURRENCY`
   * above) and the toast reports the true tally -- always both numbers,
   * never a message that implies total success or total failure when the
   * real outcome was mixed.
   *
   * Fix (review, further follow-up): the pool calls `linkCandidateRequest`
   * directly rather than `linkCandidate.mutateAsync` -- the mutation's own
   * `onSuccess` invalidates the candidates list on *every* call, which with
   * hundreds of candidates in flight turned into a refetch storm layered on
   * top of the writes themselves. The list is invalidated exactly once here,
   * after the whole batch has settled.
   *
   * The button is also locked to `confirmingAll` for the duration (not to
   * `linkCandidate.isPending`, which reflects only the single most recent
   * dispatch on that separate mutation object and would under-report while N
   * calls are in flight at once) -- a second click mid-batch would otherwise
   * re-link everything already-linked and manufacture a fresh wave of 409s.
   */
  const handleConfirmAllSuggestions = async () => {
    setConfirmingAll(true);
    try {
      const queue = [...suggestedCandidates];
      const results: Array<"fulfilled" | "rejected"> = [];

      const worker = async () => {
        for (let candidate = queue.shift(); candidate; candidate = queue.shift()) {
          try {
            await linkCandidateRequest(type, {
              candidateId: candidate.id,
              productId: candidate.suggestedProductId!,
            });
            results.push("fulfilled");
          } catch {
            results.push("rejected");
          }
        }
      };

      const workerCount = Math.min(CONFIRM_ALL_CONCURRENCY, queue.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      const linked = results.filter((status) => status === "fulfilled").length;
      const failed = results.length - linked;
      toast(
        failed === 0 ? "ok" : linked === 0 ? "error" : "warn",
        t("pages.integrations.channel.candidates.confirmAllResult", { linked, failed }),
      );
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["integrations", type, "candidates"] });
      setConfirmingAll(false);
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
        key: "gtin",
        title: t("pages.integrations.channel.candidates.table.gtin"),
        mono: true,
        render: (row) => row.gtin ?? "—",
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
          <Checkbox
            label={t("pages.integrations.channel.candidates.showHiddenLabel")}
            checked={hidden}
            onCheckedChange={setHidden}
          />

          {!hidden && suggestedCandidates.length > 0 && (
            <Button
              type="button"
              variant="secondary"
              loading={confirmingAll}
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
