import type { ImportResult as Result } from "@markiro/platform-contracts";
import { Alert, Button } from "@markiro/ui";
import { useTranslation } from "react-i18next";
export function ImportResult({
  result,
  canWrite,
  busy,
  retryBlocked,
  onRetry,
  onCancel,
  onOpenProduct,
}: {
  result: Result;
  canWrite: boolean;
  busy: boolean;
  retryBlocked: boolean;
  onRetry: (ids: string[]) => void;
  onCancel: () => void;
  onOpenProduct: (productId: string) => void;
}) {
  const { t } = useTranslation();
  const tr = (key: string) => t(`pages.catalog.import.${key}`);
  const running = result.state === "pending" || result.state === "running";
  return (
    <section aria-label={tr("result")}>
      <h2>{tr("result")}</h2>
      <p role="status">{tr(`operationStates.${result.state}`)}</p>
      {retryBlocked && <Alert>{tr("operationRunning")}</Alert>}
      {result.items.map((item, index) => (
        <article className="mk-nc-review-item" key={item.previewId}>
          {!item.productId && (
            <p>
              {t("pages.catalog.import.resultPosition", { position: index + 1 })}
              <br />
              <code>{item.previewId}</code>
            </p>
          )}
          <h3>
            {tr("product")}: {tr(`productOutcomes.${item.product}`)}
          </h3>
          {item.productId && (
            <Button
              variant="secondary"
              disabled={busy || (running && item.image === "pending")}
              onClick={() => item.productId && onOpenProduct(item.productId)}
            >
              {tr("openProduct")}
            </Button>
          )}
          {item.productId && running && item.image === "pending" && (
            <p role="status">{tr("waitForPhoto")}</p>
          )}
          {item.productReason && (
            <p>
              {t(`pages.catalog.import.reasons.${item.productReason}`, {
                defaultValue: tr("productFailed"),
              })}
            </p>
          )}
          <p>
            {tr("photo")}: {tr(`imageOutcomes.${item.image}`)}
          </p>
          {item.imageReason && (
            <p>
              {t(`pages.catalog.import.reasons.${item.imageReason}`, {
                defaultValue: tr("photoFailed"),
              })}
            </p>
          )}
          {item.product === "applied" && item.image === "failed" && (
            <Alert>{tr("imageFailed")}</Alert>
          )}
          {canWrite &&
            !running &&
            !retryBlocked &&
            (item.product === "failed" || item.image === "failed") && (
              <Button variant="secondary" disabled={busy} onClick={() => onRetry([item.previewId])}>
                {tr(item.product === "applied" ? "retryImage" : "retryProduct")}
              </Button>
            )}
        </article>
      ))}
      {canWrite && running && (
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {tr("cancel")}
        </Button>
      )}
    </section>
  );
}
