import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { Alert, Button, Card, ConfirmDialog, EmptyState, Spinner, Textarea } from "@markiro/ui";
import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import {
  acceptOffer,
  downloadOfferDocument,
  invalidateTenantBilling,
  requestOfferChanges,
  type OfferDecision,
  useOffer,
} from "./api.js";

type Attempt = { decision: OfferDecision["decision"]; message: string; key: string };

function statusLabel(status: string, decision: OfferDecision["decision"] | undefined) {
  if (decision === "accepted") return "Принято";
  if (decision === "changes_requested") return "Изменения запрошены";
  return (
    {
      published: "Действует",
      expired: "Срок действия истёк",
      superseded: "Заменено новой версией",
      paid: "Оплачено",
      cancelled: "Отменено",
      draft: "Черновик",
    }[status] ?? status
  );
}

export function OfferDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const canRequest = useCan(CABINET_CAPABILITY.BILLING_REQUEST);
  const query = useOffer(id);
  const attempt = useRef<Attempt | null>(null);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<OfferDecision["decision"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const offer = query.data;

  const submit = (decision: OfferDecision["decision"], retry = false) =>
    void (async () => {
      if (!offer || pending) return;
      const next = retry
        ? attempt.current
        : { decision, message: message.trim(), key: crypto.randomUUID() };
      if (!next || next.decision !== decision) return;
      if (
        decision === "changes_requested" &&
        (next.message.length < 1 || next.message.length > 2000)
      ) {
        setError("Опишите изменения: от 1 до 2000 символов.");
        return;
      }
      if (!retry) attempt.current = next;
      setPending(decision);
      setError(null);
      try {
        if (decision === "accepted") await acceptOffer(offer.id, next.key);
        else await requestOfferChanges(offer.id, next.message, next.key);
        await invalidateTenantBilling(client);
        attempt.current = null;
        setAcceptOpen(false);
        setChangeOpen(false);
        navigate("/billing/documents");
      } catch {
        setError("Не удалось отправить решение. Введённые данные сохранены; повторите попытку.");
      } finally {
        setPending(null);
      }
    })();

  if (query.isPending) return <Spinner label="Загрузка предложения" />;
  if (query.isError) {
    const status = query.error instanceof ApiRequestError ? query.error.status : 0;
    return (
      <EmptyState
        title={
          status === 404
            ? "Предложение не найдено"
            : status === 403
              ? "Нет доступа к предложению"
              : "Не удалось загрузить предложение"
        }
      />
    );
  }
  if (!offer) return <EmptyState title="Предложение не найдено" />;
  const retry = () => {
    if (attempt.current && !pending) submit(attempt.current.decision, true);
  };
  const download = (documentId: string) =>
    void (async () => {
      try {
        setDownloadError(null);
        const result = await downloadOfferDocument(offer.id, documentId);
        window.open(result.url, "_blank", "noopener,noreferrer");
      } catch {
        setDownloadError("Не удалось скачать документ. Повторите попытку позже.");
      }
    })();
  return (
    <section aria-labelledby="billing-offer-heading" className="mk-billing-offer-detail">
      <h2 className="mk-billing-section-heading" id="billing-offer-heading">
        Предложение {offer.number ?? "без номера"}
      </h2>
      <Card title="Условия" titleAs="h3">
        <p>{statusLabel(offer.status, offer.latestDecision?.decision)}</p>
        <p className="mk-billing-money">{offer.total} RUB</p>
        {offer.latestDecision?.message ? <p>{offer.latestDecision.message}</p> : null}
      </Card>
      {error ? (
        <Alert tone="error">
          {error}{" "}
          <Button variant="secondary" onClick={retry}>
            Повторить
          </Button>
        </Alert>
      ) : null}
      {downloadError ? <Alert tone="error">{downloadError}</Alert> : null}
      <Card title="Документы" titleAs="h3">
        {offer.documents.map((document) => (
          <div className="mk-billing-invoice-document" key={document.id}>
            <span>
              {document.format.toUpperCase()} ·{" "}
              {document.status === "ready"
                ? "Готов"
                : document.status === "pending"
                  ? "Подготавливается"
                  : "Не удалось подготовить"}
            </span>
            {document.status === "ready" ? (
              <Button onClick={() => download(document.id)}>Скачать</Button>
            ) : null}
          </div>
        ))}
      </Card>
      {canRequest && offer.actionable ? (
        <Card title="Ваше решение" titleAs="h3">
          <Button disabled={pending !== null} onClick={() => setAcceptOpen(true)}>
            Принять
          </Button>
          <Button
            variant="secondary"
            disabled={pending !== null}
            onClick={() => setChangeOpen(true)}
          >
            Запросить изменения
          </Button>
          {changeOpen ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                submit("changes_requested");
              }}
            >
              <Textarea
                label="Что нужно изменить"
                value={message}
                maxLength={2000}
                onChange={(event) => {
                  setMessage(event.target.value);
                  attempt.current = null;
                }}
              />
              <Button type="submit" disabled={pending !== null}>
                Отправить запрос
              </Button>
            </form>
          ) : null}
        </Card>
      ) : null}
      <ConfirmDialog
        open={acceptOpen}
        title="Принять предложение?"
        description="Markiro получит подтверждение."
        confirmLabel="Подтвердить принятие"
        cancelLabel="Отмена"
        busy={pending === "accepted"}
        onConfirm={() => submit("accepted")}
        onCancel={() => setAcceptOpen(false)}
      />
    </section>
  );
}
