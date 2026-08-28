import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Spinner,
  Table,
  Textarea,
} from "@markiro/ui";
import type { CabinetCapability } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { formatBillingDate, formatMoney } from "./format.js";
import {
  acceptOffer,
  downloadOfferDocument,
  requestOfferChanges,
  type OfferDecision,
  useOffer,
} from "./api.js";

// Kept as the domain capability value so the tenant action boundary remains
// explicit even when this worktree's linked declaration build is stale.
const BILLING_REQUEST_CAPABILITY: CabinetCapability = "billing.request";

function offerStatusLabel(status: string): string {
  return (
    {
      draft: "Черновик",
      published: "Действует",
      superseded: "Заменено новой версией",
      paid: "Принято и оплачено",
      cancelled: "Отменено",
      expired: "Срок действия истёк",
      accepted: "Принято",
      changes_requested: "Изменения запрошены",
    }[status] ?? status
  );
}

export function OfferDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const canRequest = useCan(BILLING_REQUEST_CAPABILITY);
  const { data: offer, isPending, isError } = useOffer(id);
  const keys = useRef<Partial<Record<OfferDecision["decision"], string>>>({});
  const [confirmAccept, setConfirmAccept] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<OfferDecision["decision"] | null>(null);
  const [completed, setCompleted] = useState<OfferDecision["decision"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null);

  const returnToHistory = () =>
    navigate(offer?.request ? `/billing/requests/${offer.request.id}` : "/billing/documents");
  const submit = (decision: OfferDecision["decision"], retry = false) =>
    void (async () => {
      if (!offer || pending) return;
      const trimmed = message.trim();
      if (decision === "changes_requested" && (trimmed.length < 1 || trimmed.length > 2000)) {
        setError("Опишите изменения: от 1 до 2000 символов.");
        return;
      }
      const idempotencyKey = keys.current[decision] ?? crypto.randomUUID();
      keys.current[decision] = idempotencyKey;
      setPending(decision);
      setError(null);
      try {
        const result =
          decision === "accepted"
            ? await acceptOffer(offer.id, idempotencyKey)
            : await requestOfferChanges(offer.id, trimmed, idempotencyKey);
        delete keys.current[decision];
        setCompleted(result.decision);
        setConfirmAccept(false);
        setChangeOpen(false);
        if (!retry) void returnToHistory();
      } catch {
        setError("Не удалось отправить решение. Введённые данные сохранены; повторите попытку.");
      } finally {
        setPending(null);
      }
    })();
  const retry = () => {
    if (pending || !error) return;
    void submit(keys.current.accepted ? "accepted" : "changes_requested", true);
  };
  const download = (documentId: string) =>
    void (async () => {
      if (!offer) return;
      setDownloadBusy(documentId);
      setDownloadError(null);
      try {
        const result = await downloadOfferDocument(offer.id, documentId);
        window.open(result.url, "_blank", "noopener,noreferrer");
      } catch {
        setDownloadError("Не удалось скачать документ. Повторите попытку позже.");
      } finally {
        setDownloadBusy(null);
      }
    })();

  if (isPending) return <Spinner label="Загрузка предложения" />;
  if (isError || !offer) return <EmptyState title="Предложение не найдено" />;
  const actionable = offer.status === "published" && completed === null;
  return (
    <section aria-labelledby="billing-offer-heading" className="mk-billing-offer-detail">
      <div className="mk-billing-section-intro">
        <div>
          <h2 className="mk-billing-section-heading" id="billing-offer-heading">
            Предложение {offer.number ?? "без номера"}
          </h2>
          <p>{offerStatusLabel(completed ?? offer.status)}</p>
        </div>
        {offer.request ? (
          <Button variant="secondary" onClick={() => void returnToHistory()}>
            Открыть заявку {offer.request.number}
          </Button>
        ) : null}
      </div>
      {error ? (
        <Alert tone="error">
          {error}{" "}
          <Button variant="secondary" onClick={retry}>
            Повторить
          </Button>
        </Alert>
      ) : null}
      <Card title="Условия" titleAs="h3">
        <dl className="mk-billing-definition-list">
          <div>
            <dt>Статус</dt>
            <dd>{offerStatusLabel(completed ?? offer.status)}</dd>
          </div>
          <div>
            <dt>Действует до</dt>
            <dd>{formatBillingDate(offer.expiresAt, "ru-RU")}</dd>
          </div>
          <div>
            <dt>Опубликовано</dt>
            <dd>{formatBillingDate(offer.publishedAt, "ru-RU")}</dd>
          </div>
          <div>
            <dt>Сумма</dt>
            <dd className="mk-billing-money">{formatMoney(offer.total, "RUB", "ru-RU")}</dd>
          </div>
        </dl>
        {offer.termsMarkdown ? (
          <p className="mk-billing-offer-terms">{offer.termsMarkdown}</p>
        ) : null}
      </Card>
      <Card title="Позиции" titleAs="h3">
        <div className="mk-billing-table-wrap">
          <Table
            scrollLabel="Позиции предложения"
            columns={[
              { key: "position", title: "№", mono: true },
              { key: "nameRu", title: "Позиция", wrap: true },
              { key: "quantity", title: "Количество", mono: true },
              {
                key: "lineTotal",
                title: "Сумма",
                mono: true,
                align: "right",
                render: (row) => formatMoney(row.lineTotal, "RUB", "ru-RU"),
              },
            ]}
            rows={offer.lines}
          />
        </div>
      </Card>
      <Card title="Документы" titleAs="h3">
        {downloadError ? <Alert tone="error">{downloadError}</Alert> : null}
        {offer.documents.map((document) => (
          <div className="mk-billing-invoice-document" key={document.id}>
            <span>
              {document.format.toUpperCase()} · ревизия {document.revision} ·{" "}
              {document.status === "ready"
                ? "Готов"
                : document.status === "pending"
                  ? "Подготавливается"
                  : "Не удалось подготовить"}
            </span>
            {document.status === "ready" ? (
              <Button
                disabled={downloadBusy === document.id}
                loading={downloadBusy === document.id}
                onClick={() => download(document.id)}
              >
                Скачать
              </Button>
            ) : null}
          </div>
        ))}
      </Card>
      {canRequest && actionable ? (
        <Card title="Ваше решение" titleAs="h3">
          <div className="mk-billing-offer-actions">
            <Button disabled={pending !== null} onClick={() => setConfirmAccept(true)}>
              Принять
            </Button>
            <Button
              variant="secondary"
              disabled={pending !== null}
              onClick={() => setChangeOpen((open) => !open)}
            >
              Запросить изменения
            </Button>
          </div>
          {changeOpen ? (
            <form
              className="mk-billing-change-form"
              onSubmit={(event) => {
                event.preventDefault();
                submit("changes_requested");
              }}
            >
              <Textarea
                label="Что нужно изменить"
                value={message}
                maxLength={2000}
                onChange={(event) => setMessage(event.target.value)}
                aria-describedby="offer-change-help"
              />
              <p id="offer-change-help">От 1 до 2000 символов.</p>
              <Button
                type="submit"
                disabled={pending !== null}
                loading={pending === "changes_requested"}
              >
                Отправить запрос
              </Button>
            </form>
          ) : null}
        </Card>
      ) : null}
      <ConfirmDialog
        open={confirmAccept}
        title="Принять предложение?"
        description="Markiro получит подтверждение. Отменить это действие в кабинете нельзя."
        confirmLabel="Подтвердить принятие"
        cancelLabel="Отмена"
        busy={pending === "accepted"}
        onConfirm={() => submit("accepted")}
        onCancel={() => setConfirmAccept(false)}
      />
    </section>
  );
}
