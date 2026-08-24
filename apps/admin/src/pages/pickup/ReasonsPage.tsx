import { Fragment, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { Alert, Button, Card, ConfirmDialog, EmptyState, Input } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { errorProp } from "../../lib/form-error.js";
import { toast } from "../../lib/toast.js";
import {
  useArchiveReason,
  useCreateReason,
  usePickupReasons,
  useUpdateReason,
  type ReasonDto,
} from "../kiosks/api.js";
import "../kiosks/kiosks.css";
import { PickupViewLayout, type PickupViewPath } from "./PickupViewNav.js";

type ReasonDraft = { name: string; sortOrder: string };
type ReasonFieldErrors = Partial<Record<keyof ReasonDraft, string>>;
type LocalAction =
  | { kind: "edit"; reasonId: string }
  | { kind: "create" }
  | { kind: "navigate"; to: PickupViewPath };

function draftFrom(reason: ReasonDto): ReasonDraft {
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
      <caption className="mk-visually-hidden">{t("pages.kiosks.reasons.title")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("pages.kiosks.reasons.nameLabel")}</th>
          <th scope="col">{t("pages.kiosks.reasons.sortOrderLabel")}</th>
          <th scope="col">{t("pages.kiosks.table.actions")}</th>
        </tr>
      </thead>
    </>
  );
}

function ReasonsTableSkeleton(): ReactElement {
  const { t } = useTranslation();

  return (
    <Card title={t("pages.kiosks.reasons.title")}>
      <div
        className="mk-kiosks-reasons__table-scroll mk-kiosks-reasons__loading"
        role="status"
        aria-label={t("common.loading")}
        aria-busy="true"
      >
        <table className="mk-kiosks-reasons__table">
          <ReasonsTableHead />
          <tbody aria-hidden="true">
            {["first", "second", "third"].map((row) => (
              <tr key={row}>
                <td>
                  <span />
                </td>
                <td>
                  <span />
                </td>
                <td>
                  <span />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ReasonsRefetchWarning({ retry }: { retry: () => void }): ReactElement {
  const { t } = useTranslation();

  return (
    <div className="mk-kiosks-reasons__refetch-warning">
      <Alert tone="warn">{t("pages.kiosks.reasons.refetchError")}</Alert>
      <div>
        <Button type="button" size="compact" variant="secondary" onClick={retry}>
          {t("pages.kiosks.retry")}
        </Button>
      </div>
    </div>
  );
}

/** Route-backed write-off reasons view. It never mounts on the kiosk list route. */
export function ReasonsPage(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const { data, isPending, isError, isRefetchError, refetch } = usePickupReasons();
  const hasUsableData = data !== undefined;
  const items = data ?? [];

  if (isPending && !hasUsableData) {
    return (
      <PickupViewLayout>
        <ReasonsTableSkeleton />
      </PickupViewLayout>
    );
  }

  if (isError && !hasUsableData) {
    return (
      <PickupViewLayout>
        <div className="mk-kiosks-section-state">
          <Alert tone="error">{t("common.loadError")}</Alert>
          <div>
            <Button type="button" variant="secondary" onClick={() => void refetch()}>
              {t("pages.kiosks.retry")}
            </Button>
          </div>
        </div>
      </PickupViewLayout>
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
        onNavigate={(to) => void navigate(to)}
      />
    );
  }

  return (
    <PickupViewLayout>
      {showRefetchWarning ? <ReasonsRefetchWarning retry={retry} /> : null}
      <ReadOnlyReasons items={items} />
    </PickupViewLayout>
  );
}

function ReadOnlyReasons({ items }: { items: ReasonDto[] }): ReactElement {
  const { t } = useTranslation();
  return items.length === 0 ? (
    <EmptyState
      title={t("pages.kiosks.reasons.emptyTitle")}
      hint={t("pages.kiosks.reasons.emptyHint")}
    />
  ) : (
    <Card title={t("pages.kiosks.reasons.title")}>
      <div className="mk-kiosks-reasons__table-scroll">
        <table className="mk-kiosks-reasons__table">
          <ReasonsTableHead />
          <tbody>
            {items.map((reason) => (
              <tr key={reason.id} className="mk-kiosks-reason-row">
                <td>{reason.name}</td>
                <td className="mk-kiosks-reason-row__order">{reason.sortOrder}</td>
                <td className="mk-kiosks-reason-row__actions">
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
  onNavigate,
}: {
  items: ReasonDto[];
  showRefetchWarning: boolean;
  onRetry: () => void;
  onNavigate: (to: PickupViewPath) => void;
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
  const [deleteTarget, setDeleteTarget] = useState<ReasonDto | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<LocalAction | null>(null);

  const editingReason = useMemo(
    () => items.find((reason) => reason.id === editId) ?? null,
    [editId, items],
  );
  const editBaseline = editingReason ? draftFrom(editingReason) : null;
  const hasDirtyDraft =
    newName.trim() !== "" ||
    (editDraft !== null &&
      editBaseline !== null &&
      (editDraft.name !== editBaseline.name || editDraft.sortOrder !== editBaseline.sortOrder));
  const busy = createMutation.isPending || updateMutation.isPending || archiveMutation.isPending;

  const clearDrafts = () => {
    setCreateOpen(false);
    setNewName("");
    setCreateNameError(null);
    setCreateError(null);
    setEditId(null);
    setEditDraft(null);
    setEditFieldErrors({});
    setEditError(null);
  };

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

  const performAction = (action: LocalAction) => {
    if (action.kind === "edit") startEditing(action.reasonId);
    else if (action.kind === "create") startCreating();
    else onNavigate(action.to);
  };

  const requestAction = (action: LocalAction) => {
    if (busy) return;
    if (hasDirtyDraft) {
      setPendingAction(action);
      return;
    }
    performAction(action);
  };

  const confirmDiscard = () => {
    const action = pendingAction;
    clearDrafts();
    setPendingAction(null);
    if (!action) return;
    performAction(action);
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) {
      setCreateNameError(t("pages.kiosks.reasons.errors.nameRequired"));
      setCreateError(null);
      return;
    }
    setCreateNameError(null);
    setCreateError(null);
    try {
      await createMutation.mutateAsync({ name });
      setCreateOpen(false);
      setNewName("");
      toast("ok", t("pages.kiosks.toasts.reasonCreateSuccess"));
    } catch (error) {
      setCreateError(getErrorMessage(error, t("pages.kiosks.reasons.errors.createFailed")));
    }
  };

  const handleSave = async () => {
    if (!editingReason || !editDraft) return;
    const name = editDraft.name.trim();
    const sortOrderText = editDraft.sortOrder.trim();
    const parsedSortOrder = Number(sortOrderText);
    const fieldErrors: ReasonFieldErrors = {};
    if (!name) {
      fieldErrors.name = t("pages.kiosks.reasons.errors.nameRequired");
    }
    if (
      sortOrderText === "" ||
      !Number.isFinite(parsedSortOrder) ||
      !Number.isInteger(parsedSortOrder)
    ) {
      fieldErrors.sortOrder = t("pages.kiosks.reasons.errors.sortOrderInvalid");
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
      toast("ok", t("pages.kiosks.toasts.reasonUpdateSuccess"));
    } catch (error) {
      setEditError(getErrorMessage(error, t("pages.kiosks.reasons.errors.updateFailed")));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteError(null);
    try {
      await archiveMutation.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
      toast("ok", t("pages.kiosks.toasts.reasonArchiveSuccess"));
    } catch (error) {
      setDeleteError(getErrorMessage(error, t("pages.kiosks.reasons.errors.archiveFailed")));
    }
  };

  return (
    <PickupViewLayout
      actions={
        <Button type="button" disabled={busy} onClick={() => requestAction({ kind: "create" })}>
          {t("pages.kiosks.reasons.addAction")}
        </Button>
      }
      navigationBusy={busy}
      onViewNavigate={(to) => requestAction({ kind: "navigate", to })}
    >
      {showRefetchWarning ? <ReasonsRefetchWarning retry={onRetry} /> : null}
      <Card title={t("pages.kiosks.reasons.title")}>
        <div className="mk-kiosks-reasons">
          {items.length === 0 && !createOpen ? (
            <EmptyState
              title={t("pages.kiosks.reasons.emptyTitle")}
              hint={t("pages.kiosks.reasons.emptyHint")}
            />
          ) : (
            <div className="mk-kiosks-reasons__table-scroll">
              <table className="mk-kiosks-reasons__table">
                <ReasonsTableHead />
                <tbody>
                  {createOpen ? (
                    <>
                      <tr className="mk-kiosks-reasons__create">
                        <td>
                          <Input
                            label={t("pages.kiosks.reasons.nameLabel")}
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
                        <td className="mk-kiosks-reason-row__order">
                          <span aria-hidden="true">—</span>
                        </td>
                        <td className="mk-kiosks-reason-row__actions">
                          <div>
                            <Button
                              type="button"
                              loading={createMutation.isPending}
                              onClick={() => void handleCreate()}
                            >
                              {t("pages.kiosks.reasons.createAction")}
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
                              {t("pages.kiosks.reasons.cancelAction")}
                            </Button>
                          </div>
                        </td>
                      </tr>
                      {createError ? (
                        <tr className="mk-kiosks-reason-row__error">
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
                        <tr className="mk-kiosks-reason-row">
                          {editing ? (
                            <>
                              <td>
                                <Input
                                  label={t("pages.kiosks.reasons.nameLabel")}
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
                                  label={t("pages.kiosks.reasons.sortOrderLabel")}
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
                              <td className="mk-kiosks-reason-row__actions">
                                <div>
                                  <Button
                                    type="button"
                                    size="compact"
                                    loading={updateMutation.isPending}
                                    onClick={() => void handleSave()}
                                  >
                                    {t("pages.kiosks.reasons.saveAction")}
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
                                    {t("pages.kiosks.reasons.cancelAction")}
                                  </Button>
                                </div>
                              </td>
                            </>
                          ) : (
                            <>
                              <td>{reason.name}</td>
                              <td className="mk-kiosks-reason-row__order">{reason.sortOrder}</td>
                              <td className="mk-kiosks-reason-row__actions">
                                <div>
                                  <Button
                                    type="button"
                                    size="compact"
                                    variant="secondary"
                                    disabled={busy}
                                    onClick={() =>
                                      requestAction({ kind: "edit", reasonId: reason.id })
                                    }
                                  >
                                    {t("pages.kiosks.edit")}
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
                                    {t("pages.kiosks.reasons.archiveAction")}
                                  </Button>
                                </div>
                              </td>
                            </>
                          )}
                        </tr>
                        {editing && editError ? (
                          <tr className="mk-kiosks-reason-row__error">
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
        open={pendingAction !== null}
        title={t("pages.kiosks.reasons.discardConfirmTitle")}
        description={t("pages.kiosks.reasons.discardConfirmBody")}
        cancelLabel={t("pages.kiosks.reasons.continueEditing")}
        confirmLabel={t("pages.kiosks.reasons.discardConfirmAction")}
        tone="destructive"
        onCancel={() => setPendingAction(null)}
        onConfirm={confirmDiscard}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t("pages.kiosks.reasons.archiveConfirmTitle")}
        description={t("pages.kiosks.reasons.archiveConfirmBody", { name: deleteTarget?.name })}
        entity={deleteTarget?.name}
        error={deleteError}
        cancelLabel={t("pages.kiosks.cancel")}
        confirmLabel={t("pages.kiosks.reasons.archiveConfirmAction")}
        tone="destructive"
        busy={archiveMutation.isPending}
        onCancel={() => {
          if (archiveMutation.isPending) return;
          setDeleteTarget(null);
          setDeleteError(null);
        }}
        onConfirm={() => void confirmDelete()}
      />
    </PickupViewLayout>
  );
}
