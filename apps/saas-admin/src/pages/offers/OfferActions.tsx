import type { OfferPreview, OfferWorkspaceV2 as OfferWorkspace } from "@markiro/platform-contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, ConfirmDialog, Input } from "@markiro/ui";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { ApiRequestError } from "../../api/client.js";
import { cancelOffer, payOffer, publishOffer, reviseOffer } from "./api.js";
import { offerErrorKey, offerMoney } from "./offerPresentation.js";

type Action = "publish" | "cancel" | "revise" | "pay";
const confirmKeys = {
  publish: "confirmPublish",
  cancel: "confirmCancel",
  revise: "confirmRevise",
  pay: "confirmPay",
} as const;
export function OfferActions({
  workspace,
  preview,
  onPreviewInvalid,
  onChanged,
  returnTo,
}: {
  workspace: OfferWorkspace;
  preview: OfferPreview | null;
  onPreviewInvalid: () => void;
  onChanged: () => Promise<unknown>;
  returnTo: string;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [action, setAction] = useState<Action | null>(null);
  const [reference, setReference] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [paymentLocked, setPaymentLocked] = useState(false);
  const paymentAttempt = useRef<{ key: string; amount: string; reference: string } | null>(null);
  const revisionKey = useRef<string | null>(null);
  // A refreshed workspace can forbid new payments after the first attempt committed.
  // Keep the existing attempt available for an exact idempotent retry.
  const actionAvailable = (selected: Action) =>
    workspace.actions[selected] || (selected === "pay" && paymentLocked);
  const actionBlocked = (selected: Action) =>
    !actionAvailable(selected) ||
    (paymentLocked && selected !== "pay") ||
    (selected === "publish" && preview === null);
  const mutation = useMutation({
    mutationFn: async (selected: Action) => {
      if (
        actionBlocked(selected) ||
        (paymentAttempt.current !== null && selected !== "pay") ||
        (selected === "pay" && !paymentAttempt.current && !reference.trim())
      )
        throw new Error("Action unavailable");
      const id = workspace.offer.id;
      if (selected === "publish") {
        if (!preview) throw new Error("Preview required");
        await publishOffer(id, preview.fingerprint);
      } else if (selected === "cancel") await cancelOffer(id);
      else if (selected === "revise") {
        revisionKey.current ??= crypto.randomUUID();
        return reviseOffer(id, revisionKey.current);
      } else {
        paymentAttempt.current ??= {
          key: crypto.randomUUID(),
          amount: workspace.offer.total,
          reference: reference.trim(),
        };
        setPaymentLocked(true);
        const attempt = paymentAttempt.current;
        await payOffer(id, attempt.amount, attempt.reference, attempt.key);
      }
      return null;
    },
    onSuccess: async (result) => {
      paymentAttempt.current = null;
      revisionKey.current = null;
      setPaymentLocked(false);
      setAction(null);
      await client.invalidateQueries({ queryKey: ["platform", "offers"] });
      await onChanged();
      if (result) void navigate(`/offers/${result.id}`, { state: { returnTo } });
    },
    onError: async (error) => {
      if (error instanceof ApiRequestError && error.code === "offer_preview_changed") {
        onPreviewInvalid();
        setAction(null);
      }
      if (error instanceof ApiRequestError && error.status === 403) {
        setForbidden(true);
        setAction(null);
        await client.invalidateQueries({ queryKey: ["platform", "me"] });
        await onChanged();
      }
    },
  });
  if (forbidden) return <Alert tone="error">{t("offerWorkspace.errors.forbidden")}</Alert>;
  return (
    <>
      {mutation.error && !action ? (
        <Alert tone="error">{t(offerErrorKey(mutation.error))}</Alert>
      ) : null}
      <div className="offer-action-bar">
        {(["publish", "pay", "revise", "cancel"] as const).filter(actionAvailable).map((key) => (
          <Button
            key={key}
            variant={
              key === "publish" ? "primary" : key === "cancel" ? "destructive-outline" : "secondary"
            }
            disabled={mutation.isPending || actionBlocked(key)}
            onClick={() => {
              if (mutation.isPending || actionBlocked(key)) return;
              mutation.reset();
              setAction(key);
            }}
          >
            {t(`offerWorkspace.${key}`)}
          </Button>
        ))}
        {workspace.actions.createInvoice ? (
          mutation.isPending || paymentLocked ? (
            <Button variant="secondary" disabled>
              {t("offerWorkspace.createInvoice")}
            </Button>
          ) : (
            <Link
              to="/invoices/new"
              onClick={(event) => {
                if (mutation.isPending || paymentAttempt.current !== null) event.preventDefault();
              }}
              state={
                workspace.request
                  ? { sourceOfferId: workspace.offer.id, sourceRequestId: workspace.request.id }
                  : { sourceOfferId: workspace.offer.id, sourceKind: "offer-workspace" }
              }
            >
              {t("offerWorkspace.createInvoice")}
            </Link>
          )
        ) : null}
      </div>
      <ConfirmDialog
        open={action !== null}
        title={action ? t(`offerWorkspace.${action}`) : ""}
        description={
          <>
            <p>{action ? t(`offerWorkspace.${action}Notice`) : ""}</p>
            {action === "pay" ? (
              <>
                <p className="offer-money">
                  {t("offerWorkspace.amount")}:{" "}
                  {offerMoney(
                    paymentAttempt.current?.amount ?? workspace.offer.total,
                    i18n.language,
                  )}
                </p>
                <Input
                  label={t("offerWorkspace.bankReference")}
                  value={reference}
                  disabled={mutation.isPending || paymentLocked}
                  maxLength={200}
                  onChange={(event) => setReference(event.target.value)}
                />
                {paymentLocked && mutation.error ? <p>{t("offerWorkspace.retryLocked")}</p> : null}
              </>
            ) : null}
          </>
        }
        confirmLabel={action ? t(`offerWorkspace.${confirmKeys[action]}`) : ""}
        cancelLabel={t("offerWorkspace.close")}
        busy={mutation.isPending}
        confirmDisabled={
          action === null || actionBlocked(action) || (action === "pay" && !reference.trim())
        }
        error={mutation.error ? t(offerErrorKey(mutation.error)) : undefined}
        tone={action === "cancel" ? "destructive" : "default"}
        onConfirm={() => {
          if (action && !mutation.isPending && !actionBlocked(action)) mutation.mutate(action);
        }}
        onCancel={() => setAction(null)}
      />
    </>
  );
}
