import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Checkbox, ConfirmDialog, Input } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { setCatalogOfflineAvailability, type CatalogVersionDto } from "./api.js";

/**
 * The «available to offline customers» switch of a plan or add-on (spec
 * 2026-10-16). The flag belongs to the item, so it is editable on a published
 * version too. Only a platform admin sees the switch; the server decides.
 */
export function CatalogOfflineAvailability({
  item,
  canEdit,
}: {
  item: CatalogVersionDto;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<boolean | null>(null);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (offlineAvailable: boolean) =>
      setCatalogOfflineAvailability(item.catalogItemCode, {
        offlineAvailable,
        reason: reason.trim(),
      }),
    onSuccess: async (answer) => {
      setNotice({
        tone: "ok",
        text: !answer.changed
          ? t("catalog.offline.unchanged")
          : answer.offlineAvailable
            ? t("catalog.offline.enabled")
            : t("catalog.offline.withdrawn", { count: answer.offlineTenantHolders }),
      });
      setFailure(null);
      setTarget(null);
      setReason("");
      await queryClient.invalidateQueries({ queryKey: ["platform", "catalog"] });
    },
    onError: (error) => {
      const code = error instanceof ApiRequestError ? error.code : null;
      setFailure(
        code
          ? t(`catalog.offline.errors.${code}`, {
              defaultValue: t("catalog.offline.errors.generic"),
            })
          : t("catalog.offline.errors.generic"),
      );
    },
  });
  if (item.kind === "service" || !canEdit) return null;
  const closeDialog = () => {
    setTarget(null);
    setReason("");
    setFailure(null);
  };
  return (
    <div className="catalog-offline-availability">
      <Checkbox
        label={t("catalog.offline.label")}
        hint={t("catalog.offline.hint")}
        checked={item.offlineAvailable}
        disabled={mutation.isPending}
        onCheckedChange={(checked) => {
          setNotice(null);
          setFailure(null);
          setTarget(checked);
        }}
      />
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      <ConfirmDialog
        open={target !== null}
        title={t(
          target ? "catalog.offline.confirmEnableTitle" : "catalog.offline.confirmWithdrawTitle",
        )}
        description={
          <>
            <p>
              {t(
                target
                  ? "catalog.offline.enableDescription"
                  : "catalog.offline.withdrawDescription",
              )}
            </p>
            <Input
              label={t("catalog.offline.reason")}
              value={reason}
              maxLength={1_000}
              onChange={(event) => setReason(event.target.value)}
            />
          </>
        }
        entity={item.catalogItemCode}
        confirmLabel={t("catalog.offline.confirm")}
        cancelLabel={t("catalog.cancel")}
        busy={mutation.isPending}
        confirmDisabled={reason.trim() === ""}
        {...(failure ? { error: failure } : {})}
        onCancel={closeDialog}
        onConfirm={() => {
          if (target !== null && reason.trim() !== "" && !mutation.isPending)
            mutation.mutate(target);
        }}
      />
    </div>
  );
}
