import { Fragment, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Alert, Button, Card, ConfirmDialog, EmptyState, Input, PageHeader } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { errorProp } from "../../lib/form-error.js";
import { toast } from "../../lib/toast.js";
import {
  useArchiveReason,
  useCreateReason,
  useDisaggregationReasons,
  useUpdateReason,
  type DisaggregationReasonDto,
} from "./api.js";

type ReasonDraft = { name: string; sortOrder: string };
type ReasonFieldErrors = Partial<Record<keyof ReasonDraft, string>>;

function draftFrom(reason: DisaggregationReasonDto): ReasonDraft {
  return { name: reason.name, sortOrder: String(reason.sortOrder) };
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

function clearFieldError(errors: ReasonFieldErrors, field: keyof ReasonDraft): ReasonFieldErrors {
  const next = { ...errors };
  delete next[field];
  return next;
}

function ReasonsTableHead(): ReactElement {
  const { t } = useTranslation();

  return (
    <>
      <caption className="mk-visually-hidden">{t("pages.disaggregation.reasons.title")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("pages.disaggregation.reasons.nameLabel")}</th>
          <th scope="col">{t("pages.disaggregation.reasons.sortOrderLabel")}</th>
          <th scope="col">{t("pages.disaggregation.reasons.actions")}</th>
        </tr>
      </thead>
    </>
  );
}

/** Route-backed disaggregation reasons view (`/disaggregation/reasons`), cloned from `pages/kiosks/ReasonsPage.tsx`. */
export function DisaggregationReasonsPage(): ReactElement {
  const { t } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const { data, isPending, isError, isRefetchError, refetch } = useDisaggregationReasons();
  const hasUsableData = data !== undefined;
  const items = data ?? [];

  const header = (
    <PageHeader
      title={t("pages.disaggregation.reasons.title")}
      actions={
        <Link to="/disaggregation" style={{ color: "var(--link)" }}>
          {t("pages.disaggregation.reasons.backLink")}
        </Link>
      }
    />
  );

  if (isPending && !hasUsableData) {
    return (
      <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
        {header}
      </div>
    );
  }

  if (isError && !hasUsableData) {
    return (
      <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
        {header}
        <Alert tone="error">{t("common.loadError")}</Alert>
        <div>
          <Button type="button" variant="secondary" onClick={() => void refetch()}>
            {t("pages.disaggregation.reasons.retry")}
          </Button>
        </div>
      </div>
    );
  }

  const showRefetchWarning = isRefetchError || (isError && hasUsableData);
  const retry = () => void refetch();

  if (canWrite) {
    return (
      <AuthorizedReasonsEditor
        items={items}
        showRefetchWarning={showRefetchWarning}
        onRetry={retry}
      />
    );
  }

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      {header}
      {showRefetchWarning ? <ReasonsRefetchWarning retry={retry} /> : null}
      <ReadOnlyReasons items={items} />
    </div>
  );
}

function ReasonsRefetchWarning({ retry }: { retry: () => void }): ReactElement {
  const { t } = useTranslation();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Alert tone="warn">{t("pages.disaggregation.reasons.refetchError")}</Alert>
      <div>
        <Button type="button" size="compact" variant="secondary" onClick={retry}>
          {t("pages.disaggregation.reasons.retry")}
        </Button>
      </div>
    </div>
  );
}

function ReadOnlyReasons({ items }: { items: DisaggregationReasonDto[] }): ReactElement {
  const { t } = useTranslation();
  return items.length === 0 ? (
    <EmptyState
      title={t("pages.disaggregation.reasons.emptyTitle")}
      hint={t("pages.disaggregation.reasons.emptyHint")}
    />
  ) : (
    <Card title={t("pages.disaggregation.reasons.title")}>
      <div style={{ overflowX: "auto" }}>
        <table className="mk-kiosks-reasons__table">
          <ReasonsTableHead />
          <tbody>
            {items.map((reason) => (
              <tr key={reason.id}>
                <td>{reason.name}</td>
                <td>{reason.sortOrder}</td>
                <td>
                  <span aria-hidden="true">—</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Owns reason mutations so read-only users do not mount mutation hooks. */
function AuthorizedReasonsEditor({
  items,
  showRefetchWarning,
  onRetry,
}: {
  items: DisaggregationReasonDto[];
  showRefetchWarning: boolean;
  onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const createMutation = useCreateReason();
  const updateMutation = useUpdateReason();
  const archiveMutation = useArchiveReason();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ReasonDraft | null>(null);
  const [createNameError, setCreateNameError] = useState<string | null>(null);
  const [editFieldErrors, setEditFieldErrors] = useState<ReasonFieldErrors>({});
  const [createError, setCreateError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DisaggregationReasonDto | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const editingReason = useMemo(
    () => items.find((reason) => reason.id === editId) ?? null,
    [editId, items],
  );
  const busy = createMutation.isPending || updateMutation.isPending || archiveMutation.isPending;

  const startEditing = (reasonId: string) => {
    const reason = items.find((item) => item.id === reasonId);
    if (!reason) return;
    setCreateOpen(false);
    setNewName("");
    setCreateNameError(null);
    setCreateError(null);
    setEditId(reason.id);
    setEditDraft(draftFrom(reason));
    setEditFieldErrors({});
    setEditError(null);
  };

  const startCreating = () => {
    setEditId(null);
    setEditDraft(null);
    setEditFieldErrors({});
    setEditError(null);
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) {
      setCreateNameError(t("pages.disaggregation.reasons.errors.nameRequired"));
      setCreateError(null);
      return;
    }
    setCreateNameError(null);
    setCreateError(null);
    try {
      await createMutation.mutateAsync({ name });
      setCreateOpen(false);
      setNewName("");
      toast("ok", t("pages.disaggregation.reasons.toasts.createSuccess"));
    } catch (error) {
      setCreateError(getErrorMessage(error, t("pages.disaggregation.reasons.errors.createFailed")));
    }
  };

  const handleSave = async () => {
    if (!editingReason || !editDraft) return;
    const name = editDraft.name.trim();
    const sortOrderText = editDraft.sortOrder.trim();
    const parsedSortOrder = Number(sortOrderText);
    const fieldErrors: ReasonFieldErrors = {};
    if (!name) {
      fieldErrors.name = t("pages.disaggregation.reasons.errors.nameRequired");
    }
    if (
      sortOrderText === "" ||
      !Number.isFinite(parsedSortOrder) ||
      !Number.isInteger(parsedSortOrder)
    ) {
      fieldErrors.sortOrder = t("pages.disaggregation.reasons.errors.sortOrderInvalid");
    }
    setEditFieldErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) {
      setEditError(null);
      return;
    }
    setEditError(null);
    try {
      await updateMutation.mutateAsync({
        id: editingReason.id,
        input: { name, sortOrder: parsedSortOrder },
      });
      setEditId(null);
      setEditDraft(null);
      setEditFieldErrors({});
      toast("ok", t("pages.disaggregation.reasons.toasts.updateSuccess"));
    } catch (error) {
      setEditError(getErrorMessage(error, t("pages.disaggregation.reasons.errors.updateFailed")));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteError(null);
    try {
      await archiveMutation.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
      toast("ok", t("pages.disaggregation.reasons.toasts.archiveSuccess"));
    } catch (error) {
      setDeleteError(
        getErrorMessage(error, t("pages.disaggregation.reasons.errors.archiveFailed")),
      );
    }
  };

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.disaggregation.reasons.title")}
        actions={
          <>
            <Link to="/disaggregation" style={{ color: "var(--link)" }}>
              {t("pages.disaggregation.reasons.backLink")}
            </Link>
            <Button type="button" disabled={busy} onClick={startCreating}>
              {t("pages.disaggregation.reasons.addAction")}
            </Button>
          </>
        }
      />
      {showRefetchWarning ? <ReasonsRefetchWarning retry={onRetry} /> : null}
      <Card title={t("pages.disaggregation.reasons.title")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {items.length === 0 && !createOpen ? (
            <EmptyState
              title={t("pages.disaggregation.reasons.emptyTitle")}
              hint={t("pages.disaggregation.reasons.emptyHint")}
            />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="mk-kiosks-reasons__table">
                <ReasonsTableHead />
                <tbody>
                  {createOpen ? (
                    <>
                      <tr>
                        <td>
                          <Input
                            label={t("pages.disaggregation.reasons.nameLabel")}
                            value={newName}
                            disabled={busy}
                            {...errorProp(createNameError ?? undefined)}
                            onChange={(event) => {
                              setNewName(event.target.value);
                              setCreateNameError(null);
                              setCreateError(null);
                            }}
                          />
                        </td>
                        <td>
                          <span aria-hidden="true">—</span>
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: 8 }}>
                            <Button
                              type="button"
                              loading={createMutation.isPending}
                              onClick={() => void handleCreate()}
                            >
                              {t("pages.disaggregation.reasons.createAction")}
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => {
                                setCreateOpen(false);
                                setNewName("");
                                setCreateNameError(null);
                                setCreateError(null);
                              }}
                            >
                              {t("pages.disaggregation.reasons.cancelAction")}
                            </Button>
                          </div>
                        </td>
                      </tr>
                      {createError ? (
                        <tr>
                          <td colSpan={3}>
                            <Alert tone="error">{createError}</Alert>
                          </td>
                        </tr>
                      ) : null}
                    </>
                  ) : null}
                  {items.map((reason) => {
                    const editing = editId === reason.id && editDraft !== null;
                    return (
                      <Fragment key={reason.id}>
                        <tr>
                          {editing ? (
                            <>
                              <td>
                                <Input
                                  label={t("pages.disaggregation.reasons.nameLabel")}
                                  value={editDraft.name}
                                  disabled={busy}
                                  {...errorProp(editFieldErrors.name)}
                                  onChange={(event) => {
                                    setEditDraft((draft) =>
                                      draft ? { ...draft, name: event.target.value } : draft,
                                    );
                                    setEditFieldErrors((current) =>
                                      clearFieldError(current, "name"),
                                    );
                                    setEditError(null);
                                  }}
                                />
                              </td>
                              <td>
                                <Input
                                  label={t("pages.disaggregation.reasons.sortOrderLabel")}
                                  mono
                                  inputMode="numeric"
                                  value={editDraft.sortOrder}
                                  disabled={busy}
                                  {...errorProp(editFieldErrors.sortOrder)}
                                  onChange={(event) => {
                                    setEditDraft((draft) =>
                                      draft ? { ...draft, sortOrder: event.target.value } : draft,
                                    );
                                    setEditFieldErrors((current) =>
                                      clearFieldError(current, "sortOrder"),
                                    );
                                    setEditError(null);
                                  }}
                                />
                              </td>
                              <td>
                                <div style={{ display: "flex", gap: 8 }}>
                                  <Button
                                    type="button"
                                    size="compact"
                                    loading={updateMutation.isPending}
                                    onClick={() => void handleSave()}
                                  >
                                    {t("pages.disaggregation.reasons.saveAction")}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="compact"
                                    variant="secondary"
                                    disabled={busy}
                                    onClick={() => {
                                      setEditId(null);
                                      setEditDraft(null);
                                      setEditFieldErrors({});
                                      setEditError(null);
                                    }}
                                  >
                                    {t("pages.disaggregation.reasons.cancelAction")}
                                  </Button>
                                </div>
                              </td>
                            </>
                          ) : (
                            <>
                              <td>{reason.name}</td>
                              <td>{reason.sortOrder}</td>
                              <td>
                                <div style={{ display: "flex", gap: 8 }}>
                                  <Button
                                    type="button"
                                    size="compact"
                                    variant="secondary"
                                    disabled={busy}
                                    onClick={() => startEditing(reason.id)}
                                  >
                                    {t("pages.disaggregation.reasons.edit")}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="compact"
                                    variant="destructive"
                                    disabled={busy}
                                    onClick={() => {
                                      setDeleteError(null);
                                      setDeleteTarget(reason);
                                    }}
                                  >
                                    {t("pages.disaggregation.reasons.archiveAction")}
                                  </Button>
                                </div>
                              </td>
                            </>
                          )}
                        </tr>
                        {editing && editError ? (
                          <tr>
                            <td colSpan={3}>
                              <Alert tone="error">{editError}</Alert>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t("pages.disaggregation.reasons.archiveConfirmTitle")}
        description={t("pages.disaggregation.reasons.archiveConfirmBody", {
          name: deleteTarget?.name,
        })}
        entity={deleteTarget?.name}
        error={deleteError}
        cancelLabel={t("pages.disaggregation.reasons.cancelAction")}
        confirmLabel={t("pages.disaggregation.reasons.archiveConfirmAction")}
        tone="destructive"
        busy={archiveMutation.isPending}
        onCancel={() => {
          if (archiveMutation.isPending) return;
          setDeleteTarget(null);
          setDeleteError(null);
        }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
