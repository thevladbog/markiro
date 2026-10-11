import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { Alert, Button, Card, Input, Spinner, Textarea } from "@markiro/ui";
import type { SupportEpisodeView } from "@markiro/platform-contracts";
import { ApiRequestError } from "../../api/client.js";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { getSupportEpisode, proposeSupportRequest, retrySupportSync } from "./api.js";
import "./support.css";

function Episode({ userId, episodeId }: { userId: string; episodeId: string }) {
  const { t, i18n } = useTranslation();
  const principal = usePlatformPrincipal();
  const client = useQueryClient();
  const canRead = principal.capabilities.includes("billing.read");
  const canWrite = principal.capabilities.includes("billing.write");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const proposalIntent = useRef<{ title: string; summary: string; key: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      void client.cancelQueries({ queryKey: ["platform", "support", userId, episodeId] });
      client.removeQueries({ queryKey: ["platform", "support", userId, episodeId] });
    };
  }, [client, userId, episodeId]);
  const key = ["platform", "support", principal.userId, episodeId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => getSupportEpisode(episodeId),
    enabled: canRead && Boolean(episodeId) && !denied,
    retry: false,
  });
  async function loadOlder() {
    const cursor = query.data?.nextCursor;
    if (!cursor || olderBusy || denied) return;
    setOlderBusy(true);
    setOlderError(false);
    try {
      const page = await getSupportEpisode(episodeId, cursor);
      if (!alive.current) return;
      client.setQueryData<SupportEpisodeView>(key, (old) => {
        if (!old) return page;
        const messages = Array.from(
          new Map([...page.messages, ...old.messages].map((item) => [item.id, item])).values(),
        ).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
        return { ...old, messages, nextCursor: page.nextCursor };
      });
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof ApiRequestError && cause.status === 403) {
        setDenied(true);
        void client.cancelQueries({ queryKey: key });
        client.removeQueries({ queryKey: key });
      } else {
        setOlderError(true);
      }
    } finally {
      if (alive.current) setOlderBusy(false);
    }
  }
  async function propose() {
    if (!canWrite || !title.trim() || !summary.trim() || busy) return;
    const intent =
      proposalIntent.current?.title === title && proposalIntent.current.summary === summary
        ? proposalIntent.current
        : { title, summary, key: crypto.randomUUID() };
    proposalIntent.current = intent;
    setBusy(true);
    setError(false);
    try {
      const proposal = await proposeSupportRequest(episodeId, {
        title: intent.title,
        summary: intent.summary,
        idempotencyKey: intent.key,
      });
      if (!alive.current) return;
      client.setQueryData<SupportEpisodeView>(key, (old) => (old ? { ...old, proposal } : old));
      proposalIntent.current = null;
    } catch {
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function retry() {
    if (!canWrite || busy) return;
    setBusy(true);
    setError(false);
    try {
      const result = await retrySupportSync(episodeId);
      if (alive.current) client.setQueryData(key, result);
    } catch {
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  if (!canRead || denied || (query.error instanceof ApiRequestError && query.error.status === 403))
    return <Alert tone="error">{t("support.forbidden")}</Alert>;
  return (
    <section className="catalog-page platform-support-page">
      <Link to="/support">{t("support.back")}</Link>
      <h1>{t("support.episode")}</h1>
      {query.isPending ? <Spinner label={t("support.loading")} /> : null}
      {query.isError ? (
        <Alert tone="error">
          {t("support.loadError")}{" "}
          <Button onClick={() => void query.refetch()}>{t("support.retry")}</Button>
        </Alert>
      ) : null}
      {query.data && !query.isError ? (
        <>
          <Card title={t("support.history")} titleAs="h2">
            <ol>
              {query.data.messages.map((message) => (
                <li key={message.id} style={{ overflowWrap: "anywhere" }}>
                  <strong>{t(`support.side.${message.direction}`)}</strong>{" "}
                  <time dateTime={message.occurredAt}>
                    {new Date(message.occurredAt).toLocaleString(i18n.language)}
                  </time>
                  <p>{message.text}</p>
                </li>
              ))}
            </ol>
            {query.data.nextCursor ? (
              <Button variant="secondary" disabled={olderBusy} onClick={() => void loadOlder()}>
                {t("support.older")}
              </Button>
            ) : null}
            {olderError ? (
              <Alert tone="error">
                {t("support.olderError")}{" "}
                <Button onClick={() => void loadOlder()}>{t("support.retryOlder")}</Button>
              </Alert>
            ) : null}
          </Card>
          {query.data.request ? (
            <p>
              {t("support.request")}:{" "}
              <Link to={`/billing-requests/${query.data.request.id}`}>
                {query.data.request.number}
              </Link>{" "}
              · {t(`billingRequests.status.${query.data.request.status}`)}
            </p>
          ) : null}
          {query.data.sync.state !== "healthy" ? (
            <Alert tone={query.data.sync.state === "error" ? "error" : "warn"}>
              {t(
                query.data.sync.errorCode === "consent_notice_unknown"
                  ? "support.noticeReview"
                  : query.data.sync.state === "error"
                    ? "support.syncError"
                    : "support.syncPending",
              )}
            </Alert>
          ) : null}
          {query.data.sync.state === "error" &&
          canWrite &&
          query.data.sync.errorCode !== "consent_notice_unknown" ? (
            <Button disabled={busy} onClick={() => void retry()}>
              {t("support.retrySync")}
            </Button>
          ) : null}
          {query.data.proposal ? (
            <Card title={query.data.proposal.title} titleAs="h2">
              <p style={{ overflowWrap: "anywhere" }}>{query.data.proposal.summary}</p>
              <p>{t(`support.proposal.${query.data.proposal.state}`)}</p>
            </Card>
          ) : null}
          {query.data.proposal?.state !== "accepted" && canWrite && !query.data.request ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void propose();
              }}
            >
              <h2>{t("support.propose")}</h2>
              <Input
                label={t("support.proposalTitle")}
                maxLength={200}
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  proposalIntent.current = null;
                }}
              />
              <Textarea
                label={t("support.proposalSummary")}
                maxLength={4_000}
                value={summary}
                onChange={(event) => {
                  setSummary(event.target.value);
                  proposalIntent.current = null;
                }}
              />
              <Button disabled={busy || !title.trim() || !summary.trim()} type="submit">
                {t("support.propose")}
              </Button>
            </form>
          ) : null}
        </>
      ) : null}
      {error ? <Alert tone="error">{t("support.actionError")}</Alert> : null}
    </section>
  );
}

export function SupportEpisodePage() {
  const principal = usePlatformPrincipal();
  const { episodeId = "" } = useParams();
  return (
    <Episode
      key={`${principal.userId}:${episodeId}`}
      userId={principal.userId}
      episodeId={episodeId}
    />
  );
}
