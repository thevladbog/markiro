import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { Alert, Button, Card, ConfirmDialog, EmptyState, Input, Spinner } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import {
  useArchiveReason,
  useCreateReason,
  usePickupReasons,
  useUpdateReason,
  type ReasonDto,
} from "./api.js";
import { KiosksLayout } from "./KiosksLayout.js";

type ReasonDraft = { name: string; sortOrder: string };
type LocalAction =
  { kind: "edit"; reasonId: string } | { kind: "navigate"; to: "/kiosks" | "/kiosks/reasons" };

function draftFrom(reason: ReasonDto): ReasonDraft {
  return { name: reason.name, sortOrder: String(reason.sortOrder) };
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

/** Route-backed write-off reasons view. It never mounts on the kiosk list route. */
export function ReasonsPage(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const { data, isPending, isError, refetch } = usePickupReasons();
  const items = data ?? [];

  if (isPending) {
    return (
      <KiosksLayout>
        <Card title={t("pages.kiosks.reasons.title")}>
          <div className="mk-kiosks-reasons__loading">
            <Spinner label={t("common.loading")} />
          </div>
        </Card>
      </KiosksLayout>
    );
  }

  if (isError) {
    return (
      <KiosksLayout>
        <div className="mk-kiosks-section-state">
          <Alert tone="error">{t("common.loadError")}</Alert>
          <div>
            <Button type="button" variant="secondary" onClick={() => void refetch()}>
              {t("pages.kiosks.retry")}
            </Button>
          </div>
        </div>
      </KiosksLayout>
    );
  }

  if (canWrite) {
    return <AuthorizedReasonsEditor items={items} onNavigate={(to) => void navigate(to)} />;
  }

  return (
    <KiosksLayout>
      <ReadOnlyReasons items={items} />
    </KiosksLayout>
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
      <ul className="mk-kiosks-reasons__list">
        {items.map((reason) => (
          <li key={reason.id} className="mk-kiosks-reason-row">
            <span>{reason.name}</span>
            <span className="mk-kiosks-reason-row__order">{reason.sortOrder}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Owns reason mutations so read-only users do not mount mutation hooks. */
function AuthorizedReasonsEditor({
  items,
  onNavigate,
}: {
  items: ReasonDto[];
  onNavigate: (to: "/kiosks" | "/kiosks/reasons") => void;
}): ReactElement {
  const { t } = useTranslation();
  const createMutation = useCreateReason();
  const updateMutation = useUpdateReason();
  const archiveMutation = useArchiveReason();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ReasonDraft | null>(null);
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
    setCreateError(null);
    setEditId(null);
    setEditDraft(null);
    setEditError(null);
  };

  const startEditing = (reasonId: string) => {
    const reason = items.find((item) => item.id === reasonId);
    if (!reason) return;
    setCreateOpen(false);
    setNewName("");
    setCreateError(null);
    setEditId(reason.id);
    setEditDraft(draftFrom(reason));
    setEditError(null);
  };

  const requestAction = (action: LocalAction) => {
    if (busy) return;
    if (hasDirtyDraft) {
      setPendingAction(action);
      return;
    }
    if (action.kind === "edit") startEditing(action.reasonId);
    else onNavigate(action.to);
  };

  const confirmDiscard = () => {
    const action = pendingAction;
    clearDrafts();
    setPendingAction(null);
    if (!action) return;
    if (action.kind === "edit") startEditing(action.reasonId);
    else onNavigate(action.to);
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) {
      setCreateError(t("pages.kiosks.reasons.errors.nameRequired"));
      return;
    }
    setCreateError(null);
    try {
      await createMutation.mutateAsync({ name });
      setCreateOpen(false);
      setNewName("");
    } catch (error) {
      setCreateError(getErrorMessage(error, t("pages.kiosks.reasons.errors.createFailed")));
    }
  };

  const handleSave = async () => {
    if (!editingReason || !editDraft) return;
    const name = editDraft.name.trim();
    const parsedSortOrder = Number(editDraft.sortOrder.trim());
    if (!name) {
      setEditError(t("pages.kiosks.reasons.errors.nameRequired"));
      return;
    }
    if (!Number.isFinite(parsedSortOrder) || !Number.isInteger(parsedSortOrder)) {
      setEditError(t("pages.kiosks.reasons.errors.sortOrderInvalid"));
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
    } catch (error) {
      setDeleteError(getErrorMessage(error, t("pages.kiosks.reasons.errors.archiveFailed")));
    }
  };

  return (
    <KiosksLayout
      actions={
        <Button type="button" disabled={busy} onClick={() => setCreateOpen(true)}>
          {t("pages.kiosks.reasons.addAction")}
        </Button>
      }
      onViewNavigate={(to) => requestAction({ kind: "navigate", to })}
    >
      <Card title={t("pages.kiosks.reasons.title")}>
        <div className="mk-kiosks-reasons">
          {items.length === 0 ? (
            <p className="mk-kiosks-reasons__empty">{t("pages.kiosks.reasons.emptyHint")}</p>
          ) : (
            <ul className="mk-kiosks-reasons__list">
              {items.map((reason) => {
                const editing = editId === reason.id && editDraft !== null;
                return (
                  <li key={reason.id} className="mk-kiosks-reason-row">
                    {editing ? (
                      <div className="mk-kiosks-reason-row__editor">
                        <Input
                          label={t("pages.kiosks.reasons.nameLabel")}
                          value={editDraft.name}
                          disabled={busy}
                          onChange={(event) => {
                            setEditDraft((draft) =>
                              draft ? { ...draft, name: event.target.value } : draft,
                            );
                            setEditError(null);
                          }}
                        />
                        <Input
                          label={t("pages.kiosks.reasons.sortOrderLabel")}
                          mono
                          inputMode="numeric"
                          value={editDraft.sortOrder}
                          disabled={busy}
                          onChange={(event) => {
                            setEditDraft((draft) =>
                              draft ? { ...draft, sortOrder: event.target.value } : draft,
                            );
                            setEditError(null);
                          }}
                        />
                        <div className="mk-kiosks-reason-row__actions">
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
                              setEditError(null);
                            }}
                          >
                            {t("pages.kiosks.reasons.cancelAction")}
                          </Button>
                        </div>
                        {editError ? <Alert tone="error">{editError}</Alert> : null}
                      </div>
                    ) : (
                      <>
                        <span>{reason.name}</span>
                        <span className="mk-kiosks-reason-row__order">{reason.sortOrder}</span>
                        <div className="mk-kiosks-reason-row__actions">
                          <Button
                            type="button"
                            size="compact"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => requestAction({ kind: "edit", reasonId: reason.id })}
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
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {createOpen ? (
            <div className="mk-kiosks-reasons__create">
              <Input
                label={t("pages.kiosks.reasons.nameLabel")}
                value={newName}
                disabled={busy}
                onChange={(event) => {
                  setNewName(event.target.value);
                  setCreateError(null);
                }}
              />
              <div className="mk-kiosks-reason-row__actions">
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
                    setCreateError(null);
                  }}
                >
                  {t("pages.kiosks.reasons.cancelAction")}
                </Button>
              </div>
              {createError ? <Alert tone="error">{createError}</Alert> : null}
            </div>
          ) : null}
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
    </KiosksLayout>
  );
}
