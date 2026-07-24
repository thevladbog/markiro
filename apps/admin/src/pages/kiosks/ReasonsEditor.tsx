import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Input, Spinner } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import {
  useArchiveReason,
  useCreateReason,
  usePickupReasons,
  useUpdateReason,
  type ReasonDto,
} from "./api.js";

interface ReasonDraft {
  name: string;
  sortOrder: string;
}

function draftFrom(reason: ReasonDto): ReasonDraft {
  return { name: reason.name, sortOrder: String(reason.sortOrder) };
}

/**
 * Inline CRUD editor for write-off pickup reasons -- Task 17. Embedded below
 * the kiosks table on the same «Настройки → Киоски» screen (rather than a
 * standalone page/route) per the task brief, since there's no dedicated
 * "reasons" page in the plan.
 *
 * Rename and reorder are both folded into a single per-row "save" action
 * (one `useUpdateReason` call with both `name` and `sortOrder`) rather than
 * two separate controls, since the API's `UpdateReasonInput` already accepts
 * both fields together and the plan allows either a dedicated up/down
 * control or a numeric `sortOrder` input -- this uses the latter.
 */
export function ReasonsEditor() {
  const { t } = useTranslation();
  const { data, isPending, isError } = usePickupReasons();
  const createMutation = useCreateReason();
  const updateMutation = useUpdateReason();
  const archiveMutation = useArchiveReason();

  const [newName, setNewName] = useState("");
  const [drafts, setDrafts] = useState<Record<string, ReasonDraft>>({});

  const items = data ?? [];

  // Re-seed the per-row drafts whenever the list refetches (e.g. after a
  // successful create/update/archive invalidates the query) -- keeps the
  // numeric sortOrder inputs showing the server's current values instead of
  // stale local edits.
  useEffect(() => {
    const next: Record<string, ReasonDraft> = {};
    for (const reason of items) {
      next[reason.id] = draftFrom(reason);
    }
    setDrafts(next);
  }, [data]);

  const handleAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      await createMutation.mutateAsync({ name });
      setNewName("");
      toast("ok", t("pages.kiosks.toasts.reasonCreateSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.kiosks.toasts.reasonCreateError"),
      );
    }
  };

  const handleSave = async (reason: ReasonDto) => {
    const draft = drafts[reason.id] ?? draftFrom(reason);
    const name = draft.name.trim();
    if (!name) return;
    const sortOrder = Number(draft.sortOrder);
    try {
      await updateMutation.mutateAsync({
        id: reason.id,
        input: { name, sortOrder: Number.isFinite(sortOrder) ? sortOrder : reason.sortOrder },
      });
      toast("ok", t("pages.kiosks.toasts.reasonUpdateSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.kiosks.toasts.reasonUpdateError"),
      );
    }
  };

  const handleArchive = async (id: string) => {
    try {
      await archiveMutation.mutateAsync(id);
      toast("ok", t("pages.kiosks.toasts.reasonArchiveSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.kiosks.toasts.reasonArchiveError"),
      );
    }
  };

  return (
    <Card title={t("pages.kiosks.reasons.title")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {isPending ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
            <Spinner label={t("common.loading")} />
          </div>
        ) : isError ? (
          <Alert tone="error">{t("common.loadError")}</Alert>
        ) : (
          <>
            {items.length === 0 && (
              <p style={{ font: "var(--text-body)", color: "var(--fg-3)" }}>
                {t("pages.kiosks.reasons.emptyHint")}
              </p>
            )}
            {items.map((reason) => {
              const draft = drafts[reason.id] ?? draftFrom(reason);
              return (
                <div key={reason.id} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <div style={{ flex: 1 }}>
                    <Input
                      label={t("pages.kiosks.reasons.nameLabel")}
                      value={draft.name}
                      onChange={(event) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [reason.id]: { ...draft, name: event.target.value },
                        }))
                      }
                    />
                  </div>
                  <div style={{ width: 100 }}>
                    <Input
                      label={t("pages.kiosks.reasons.sortOrderLabel")}
                      mono
                      inputMode="numeric"
                      value={draft.sortOrder}
                      onChange={(event) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [reason.id]: { ...draft, sortOrder: event.target.value },
                        }))
                      }
                    />
                  </div>
                  <Button
                    type="button"
                    size="compact"
                    variant="secondary"
                    loading={updateMutation.isPending}
                    onClick={() => void handleSave(reason)}
                  >
                    {t("pages.kiosks.reasons.saveAction")}
                  </Button>
                  <Button
                    type="button"
                    size="compact"
                    variant="destructive"
                    onClick={() => void handleArchive(reason.id)}
                  >
                    {t("pages.kiosks.reasons.archiveAction")}
                  </Button>
                </div>
              );
            })}
          </>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <Input
              label={t("pages.kiosks.reasons.nameLabel")}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
          </div>
          <Button type="button" loading={createMutation.isPending} onClick={() => void handleAdd()}>
            {t("pages.kiosks.reasons.addAction")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
