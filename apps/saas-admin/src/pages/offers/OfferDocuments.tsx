import type { OfferWorkspaceV2 as OfferWorkspace } from "@markiro/platform-contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, Button, ConfirmDialog, Spinner, StatusChip } from "@markiro/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { downloadOfferDocument, listOfferDocuments, renderOfferDocuments } from "./api.js";
import { offerErrorKey } from "./offerPresentation.js";

export function OfferDocuments({
  workspace,
  canWrite,
}: {
  workspace: OfferWorkspace;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const [confirmSigned, setConfirmSigned] = useState(false);
  const [pollUntil, setPollUntil] = useState(() => Date.now() + 30_000);
  const documents = useQuery({
    queryKey: ["platform", "offers", workspace.offer.id, "documents"],
    queryFn: () => listOfferDocuments(workspace.offer.id),
    initialData: workspace.documents,
    refetchInterval: (query) =>
      Date.now() < pollUntil && query.state.data?.some((item) => item.status === "pending")
        ? 2_000
        : false,
  });
  const generate = useMutation({
    mutationFn: (variant: "clean" | "signed") => renderOfferDocuments(workspace.offer.id, variant),
    onSuccess: async () => {
      setConfirmSigned(false);
      setPollUntil(Date.now() + 30_000);
      await documents.refetch();
    },
  });
  const download = useMutation({
    mutationFn: (id: string) => downloadOfferDocument(workspace.offer.id, id),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  return (
    <section className="offer-section" aria-labelledby="offer-documents-title">
      <header className="offer-section__header">
        <h2 id="offer-documents-title">{t("offerWorkspace.documents")}</h2>
        <Button
          variant="secondary"
          onClick={() => {
            setPollUntil(Date.now() + 30_000);
            void documents.refetch();
          }}
        >
          {t("offerWorkspace.refreshDocuments")}
        </Button>
      </header>
      {documents.isFetching ? <Spinner label={t("shell.routeLoading")} /> : null}
      {documents.error || generate.error || download.error ? (
        <Alert tone="error">
          {t(offerErrorKey(documents.error ?? generate.error ?? download.error))}
        </Alert>
      ) : null}
      {!documents.data.length ? (
        <p className="offer-muted">{t("offerWorkspace.noDocuments")}</p>
      ) : null}
      {(["clean", "signed"] as const).map((variant) => {
        const items = documents.data.filter((item) => item.printVariant === variant);
        if (!items.length) return null;
        return (
          <section
            className="offer-document-variant"
            key={variant}
            aria-label={t(`offerWorkspace.${variant}`)}
          >
            <h3>{t(`offerWorkspace.${variant}`)}</h3>
            {items.map((item) => (
              <div className="offer-document-row" key={item.id}>
                <span className="offer-money">{item.format.toUpperCase()}</span>
                <StatusChip
                  status={
                    item.status === "ready" ? "ok" : item.status === "failed" ? "error" : "info"
                  }
                  label={t(`offerWorkspace.fileState.${item.status}`)}
                />
                {item.status === "ready" ? (
                  <Button
                    variant="secondary"
                    loading={download.isPending && download.variables === item.id}
                    disabled={download.isPending}
                    onClick={() => download.mutate(item.id)}
                  >
                    {t(
                      item.format === "html"
                        ? "offerWorkspace.openHtml"
                        : "offerWorkspace.downloadPdf",
                    )}
                  </Button>
                ) : null}
              </div>
            ))}
            {canWrite &&
            items.some((item) => item.status !== "ready") &&
            (variant === "clean" || workspace.actions.addSignedVariant) ? (
              <Button
                variant="secondary"
                loading={generate.isPending}
                onClick={() =>
                  variant === "signed" ? setConfirmSigned(true) : generate.mutate(variant)
                }
              >
                {t("offerWorkspace.retryDocuments")}
              </Button>
            ) : null}
          </section>
        );
      })}
      <p className="offer-muted">{t("offerWorkspace.htmlHint")}</p>
      {documents.data.some((item) => item.status === "pending") ? (
        <p role="status">{t("offerWorkspace.pendingRecovery")}</p>
      ) : null}
      <div className="offer-action-bar">
        {canWrite &&
        workspace.offer.number &&
        !documents.data.some((item) => item.printVariant === "clean") ? (
          <Button
            variant="secondary"
            loading={generate.isPending}
            onClick={() => generate.mutate("clean")}
          >
            {t("offerWorkspace.renderClean")}
          </Button>
        ) : null}
        {canWrite &&
        workspace.actions.addSignedVariant &&
        !documents.data.some((item) => item.printVariant === "signed") ? (
          <Button variant="secondary" onClick={() => setConfirmSigned(true)}>
            {t("offerWorkspace.addSigned")}
          </Button>
        ) : null}
      </div>
      {canWrite &&
      workspace.offer.number &&
      !workspace.actions.addSignedVariant &&
      !documents.data.some((item) => item.printVariant === "signed") ? (
        <p className="offer-muted">{t("offerWorkspace.signedUnavailable")}</p>
      ) : null}
      <ConfirmDialog
        open={confirmSigned}
        title={t("offerWorkspace.signed")}
        description={t("offerWorkspace.signedNotice")}
        confirmLabel={t("offerWorkspace.confirmSigned")}
        cancelLabel={t("offerWorkspace.close")}
        busy={generate.isPending}
        error={generate.error ? t(offerErrorKey(generate.error)) : undefined}
        onConfirm={() => generate.mutate("signed")}
        onCancel={() => setConfirmSigned(false)}
      />
    </section>
  );
}
