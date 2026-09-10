import type { OfferPreview as Preview } from "@markiro/platform-contracts";
import { useMutation } from "@tanstack/react-query";
import { Alert, Button, Spinner } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import { previewOffer } from "./api.js";
import { offerErrorKey } from "./offerPresentation.js";

export function OfferPreview({
  offerId,
  onPreview,
  onInvalidate,
}: {
  offerId: string;
  onPreview: (preview: Preview) => void;
  onInvalidate: () => void;
}) {
  const { t } = useTranslation();
  const preview = useMutation({ mutationFn: () => previewOffer(offerId), onSuccess: onPreview });
  return (
    <section className="offer-section offer-preview" aria-labelledby="offer-preview-title">
      <header className="offer-section__header">
        <h2 id="offer-preview-title">{t("offerWorkspace.preview")}</h2>
        <Button
          variant="secondary"
          loading={preview.isPending}
          onClick={() => {
            onInvalidate();
            preview.mutate();
          }}
        >
          {t(
            preview.data || preview.error
              ? "offerWorkspace.refreshPreview"
              : "offerWorkspace.preview",
          )}
        </Button>
      </header>
      <p className="offer-muted">{t("offerWorkspace.previewHint")}</p>
      {preview.isPending ? <Spinner label={t("shell.routeLoading")} /> : null}
      {preview.error ? <Alert tone="error">{t(offerErrorKey(preview.error))}</Alert> : null}
      {preview.data ? (
        <>
          <Alert tone="info">{t("offerWorkspace.draftNotice")}</Alert>
          <p className="offer-muted" id="offer-preview-scroll-hint">
            {t("offerWorkspace.previewScrollHint")}
          </p>
          <iframe
            title={t("offerWorkspace.previewTitle")}
            aria-describedby="offer-preview-scroll-hint"
            sandbox=""
            srcDoc={preview.data.html}
          />
        </>
      ) : null}
    </section>
  );
}
