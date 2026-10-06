import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { Alert, Button, Card, Spinner, Textarea } from "@markiro/ui";
import { supportTranscriptNotice, type SupportEpisodeView } from "@markiro/platform-contracts";
import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { useAuthClient } from "../../auth/client.js";
import { useActiveOrg } from "../../layout/useActiveOrg.js";
import { SupportConsentCard } from "./SupportConsentCard.js";
import { createEpisode, decideProposal, getEpisode, listEpisodes, sendMessage } from "./api.js";
import { mergeMessages, reconcileHistory, type EpisodeHistory } from "./history.js";
import "./support.css";

function Chat({ tenantId, userId }: { tenantId: string; userId: string }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const canReadBilling = useCan(CABINET_CAPABILITY.BILLING_READ);
  const [selected, setSelected] = useState<string | null>(null);
  const [createdEpisodes, setCreatedEpisodes] = useState<SupportEpisodeView[]>([]);
  const [draft, setDraft] = useState("");
  const [attempt, setAttempt] = useState<{ text: string; key: string } | null>(null);
  const createAttempt = useRef<string | null>(null);
  const decisionAttempt = useRef<{
    id: string;
    revision: number;
    decision: "accept" | "decline";
    key: string;
  } | null>(null);
  const [actionError, setActionError] = useState<"send" | "other" | null>(null);
  const [busy, setBusy] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const wasVisible = useRef(visible);
  const alive = useRef(true);
  const selectedEpisode = useRef<string | null>(null);
  const contextVersion = useRef(0);
  const accessDenied = useRef(false);
  const listKey = ["support", tenantId, userId, "list"];
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      void client.cancelQueries({ queryKey: ["support", tenantId, userId] });
      client.removeQueries({ queryKey: ["support", tenantId, userId] });
    };
  }, [client, tenantId, userId]);
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  const list = useInfiniteQuery({
    queryKey: listKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const page = await listEpisodes(pageParam);
      signal.throwIfAborted();
      if (!alive.current || accessDenied.current) throw new Error("Support context changed");
      return page;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !denied,
    retry: false,
  });
  const items = [
    ...new Map(
      [...createdEpisodes, ...(list.data?.pages.flatMap((page) => page.items) ?? [])].map(
        (item) => [item.id, item],
      ),
    ).values(),
  ];
  const episodeId = selected ?? items[0]?.id ?? null;
  if (selectedEpisode.current !== episodeId) contextVersion.current++;
  selectedEpisode.current = episodeId;
  const ownsContext = (version: number) =>
    alive.current && !accessDenied.current && contextVersion.current === version;
  function denyAccess() {
    accessDenied.current = true;
    contextVersion.current++;
    setDenied(true);
    setDraft("");
    setAttempt(null);
    setCreatedEpisodes([]);
    createAttempt.current = null;
    decisionAttempt.current = null;
    setBusy(false);
    setActionError(null);
    void client.cancelQueries({ queryKey: ["support", tenantId, userId] });
    client.removeQueries({ queryKey: ["support", tenantId, userId] });
  }
  function selectEpisode(id: string) {
    contextVersion.current++;
    selectedEpisode.current = id;
    setSelected(id);
    setDraft("");
    setAttempt(null);
    createAttempt.current = null;
    decisionAttempt.current = null;
    setActionError(null);
    setBusy(false);
    setOlderError(null);
    setOlderBusy(false);
  }
  const episode = useQuery({
    queryKey: ["support", tenantId, userId, "episode", episodeId],
    queryFn: async ({ signal }) => {
      const version = contextVersion.current;
      const read = async (cursor?: string) => {
        const result = await getEpisode(episodeId!, cursor);
        signal.throwIfAborted();
        if (!alive.current || accessDenied.current || contextVersion.current !== version)
          throw new Error("Support context changed");
        return result;
      };
      const latest = await read();
      const key = ["support", tenantId, userId, "episode", episodeId];
      const previous = client.getQueryData<EpisodeHistory>(key);
      if (!previous) return latest;
      const recovered = await reconcileHistory(previous, latest, read);
      // A manual older read or send may finish while the recovery page is in flight.
      const current = client.getQueryData<EpisodeHistory>(key) ?? previous;
      return {
        ...recovered,
        messages: mergeMessages(current.messages, recovered.messages),
        nextCursor: current.nextCursor,
      };
    },
    enabled: Boolean(episodeId) && !denied,
    retry: false,
    refetchInterval: visible ? 5_000 : false,
  });
  const refetchEpisode = episode.refetch;
  useEffect(() => {
    if (visible && !wasVisible.current && episodeId) void refetchEpisode();
    wasVisible.current = visible;
  }, [visible, episodeId, refetchEpisode]);
  useEffect(() => {
    if (
      (list.error instanceof ApiRequestError && list.error.status === 403) ||
      (episode.error instanceof ApiRequestError && episode.error.status === 403)
    ) {
      setDenied(true);
      accessDenied.current = true;
      contextVersion.current++;
      setDraft("");
      setAttempt(null);
      setCreatedEpisodes([]);
      void client.cancelQueries({ queryKey: ["support", tenantId, userId] });
      client.removeQueries({ queryKey: ["support", tenantId, userId] });
    }
  }, [list.error, episode.error, client, tenantId, userId]);
  useEffect(() => {
    if (denied) {
      void client.cancelQueries({ queryKey: ["support", tenantId, userId] });
      client.removeQueries({ queryKey: ["support", tenantId, userId] });
    }
  }, [denied, client, tenantId, userId]);
  async function loadOlder() {
    const requestedId = episodeId;
    const version = contextVersion.current;
    const cursor = episode.data?.nextCursor;
    if (!requestedId || !cursor || olderBusy || denied) return;
    setOlderBusy(true);
    setOlderError(null);
    try {
      const page = await getEpisode(requestedId, cursor);
      if (!alive.current || accessDenied.current || contextVersion.current !== version) return;
      client.setQueryData<SupportEpisodeView>(
        ["support", tenantId, userId, "episode", requestedId],
        (old) => {
          if (!old) return page;
          const messages = mergeMessages(page.messages, old.messages);
          return { ...old, messages, nextCursor: page.nextCursor };
        },
      );
    } catch (error) {
      if (!alive.current || accessDenied.current || contextVersion.current !== version) return;
      if (error instanceof ApiRequestError && error.status === 403) {
        denyAccess();
      } else {
        setOlderError(requestedId);
      }
    } finally {
      if (alive.current && contextVersion.current === version) setOlderBusy(false);
    }
  }
  async function newQuestion() {
    if (busy || !list.data || denied || accessDenied.current) return;
    const version = contextVersion.current;
    setBusy(true);
    setActionError(null);
    try {
      const key = createAttempt.current ?? crypto.randomUUID();
      createAttempt.current = key;
      const next = await createEpisode(key);
      if (!ownsContext(version)) return;
      createAttempt.current = null;
      setCreatedEpisodes((old) => [...old.filter((item) => item.id !== next.id), next]);
      client.setQueryData(["support", tenantId, userId, "episode", next.id], next);
      selectEpisode(next.id);
    } catch (error) {
      if (ownsContext(version)) {
        if (error instanceof ApiRequestError && error.status === 403) denyAccess();
        else setActionError("other");
      }
    } finally {
      if (ownsContext(version)) setBusy(false);
    }
  }
  async function submit() {
    if (!episodeId || !draft.trim() || draft.length > 2_000 || busy) return;
    const current = attempt?.text === draft ? attempt : { text: draft, key: crypto.randomUUID() };
    const version = contextVersion.current;
    setAttempt(current);
    setBusy(true);
    setActionError(null);
    try {
      const message = await sendMessage(episodeId, current.text, current.key);
      if (!ownsContext(version)) return;
      client.setQueryData<SupportEpisodeView>(
        ["support", tenantId, userId, "episode", episodeId],
        (old) =>
          old
            ? {
                ...old,
                messages: [...old.messages.filter((item) => item.id !== message.id), message],
              }
            : old,
      );
      if (message.delivery === "sent") {
        setDraft("");
        setAttempt(null);
      }
    } catch (error) {
      if (ownsContext(version)) {
        if (error instanceof ApiRequestError && error.status === 403) denyAccess();
        else setActionError("send");
      }
    } finally {
      if (ownsContext(version)) setBusy(false);
    }
  }
  async function decision(kind: "accept" | "decline", locale: "ru" | "en") {
    const proposal = episode.data?.proposal;
    if (!episodeId || !proposal || busy) return;
    const version = contextVersion.current;
    setBusy(true);
    setActionError(null);
    try {
      const notice = supportTranscriptNotice(locale);
      const previous = decisionAttempt.current;
      const key =
        previous?.id === proposal.id &&
        previous.revision === proposal.revision &&
        previous.decision === kind
          ? previous.key
          : crypto.randomUUID();
      decisionAttempt.current = {
        id: proposal.id,
        revision: proposal.revision,
        decision: kind,
        key,
      };
      const updated = await decideProposal(episodeId, proposal.id, {
        decision: kind,
        revision: proposal.revision,
        noticeVersion: notice.version,
        noticeLocale: locale,
        idempotencyKey: key,
      });
      if (!ownsContext(version)) return;
      decisionAttempt.current = null;
      client.setQueryData(["support", tenantId, userId, "episode", episodeId], updated);
      await client.invalidateQueries({ queryKey: listKey });
    } catch (error) {
      if (ownsContext(version)) {
        if (error instanceof ApiRequestError && error.status === 403) denyAccess();
        else {
          setActionError("other");
          if (error instanceof ApiRequestError && error.status === 409) void episode.refetch();
        }
      }
    } finally {
      if (ownsContext(version)) setBusy(false);
    }
  }
  const accessLost =
    denied ||
    (list.error instanceof ApiRequestError && list.error.status === 403) ||
    (episode.error instanceof ApiRequestError && episode.error.status === 403);
  accessDenied.current = accessLost;
  if (accessLost) return <Alert tone="error">{t("support.accessLost")}</Alert>;
  return (
    <section className="mk-support-page" style={{ minWidth: 0 }}>
      <header>
        <h1>{t("support.title")}</h1>
        <p>{t("support.description")}</p>
      </header>
      <Button disabled={busy || !list.data} onClick={() => void newQuestion()}>
        {t("support.newQuestion")}
      </Button>
      {list.isPending ? <Spinner label={t("support.loading")} /> : null}
      {list.isError ? (
        <Alert tone="error">
          {t("support.connectionError")}{" "}
          <Button onClick={() => void list.refetch()}>{t("support.retry")}</Button>
        </Alert>
      ) : null}
      {items.length ? (
        <nav aria-label={t("support.episodes")}>
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                <Button
                  variant="secondary"
                  aria-current={episodeId === item.id ? "page" : undefined}
                  onClick={() => selectEpisode(item.id)}
                >
                  {item.proposal?.title ?? item.request?.number ?? t("support.question")}
                </Button>
              </li>
            ))}
          </ul>
          {list.hasNextPage ? (
            <Button disabled={list.isFetching} onClick={() => void list.fetchNextPage()}>
              {t("support.moreEpisodes")}
            </Button>
          ) : null}
        </nav>
      ) : null}
      {list.data && items.length === 0 && !episodeId ? <p>{t("support.empty")}</p> : null}
      {episode.isPending && episodeId ? <Spinner label={t("support.loading")} /> : null}
      {episode.isError && !episode.isPending ? (
        <Alert tone="error">
          {t("support.connectionError")}{" "}
          <Button onClick={() => void episode.refetch()}>{t("support.retry")}</Button>
        </Alert>
      ) : null}
      {episode.data && !episode.isError ? (
        <>
          <Card title={t("support.history")} titleAs="h2">
            <ol aria-label={t("support.history")}>
              {episode.data.messages.map((message) => (
                <li key={message.id} style={{ overflowWrap: "anywhere" }}>
                  <strong>{t(`support.side.${message.direction}`)}</strong>{" "}
                  <time dateTime={message.occurredAt}>
                    {new Date(message.occurredAt).toLocaleString(i18n.language)}
                  </time>
                  <p>{message.text}</p>
                  {message.delivery !== "sent" ? (
                    <span>{t(`support.delivery.${message.delivery}`)}</span>
                  ) : null}
                </li>
              ))}
            </ol>
            {episode.data.nextCursor ? (
              <Button variant="secondary" disabled={olderBusy} onClick={() => void loadOlder()}>
                {t("support.older")}
              </Button>
            ) : null}
            {olderError === episodeId ? (
              <Alert tone="error">
                {t("support.connectionError")}{" "}
                <Button onClick={() => void loadOlder()}>{t("support.retry")}</Button>
              </Alert>
            ) : null}
          </Card>
          {episode.data.request ? (
            <p>
              {t("support.requestStatus", {
                number: episode.data.request.number,
                status: t(`pages.billing.status.request.${episode.data.request.status}`),
              })}{" "}
              {canReadBilling ? (
                <Link to={`/billing/requests/${episode.data.request.id}`}>
                  {episode.data.request.number}
                </Link>
              ) : null}
            </p>
          ) : null}
          {episode.data.sync.state !== "healthy" && episode.data.request ? (
            <Alert tone={episode.data.sync.state === "error" ? "error" : "warn"}>
              {t(
                episode.data.sync.errorCode === "consent_notice_unknown"
                  ? "support.noticeReview"
                  : episode.data.sync.state === "error"
                    ? "support.syncError"
                    : "support.syncPending",
              )}
            </Alert>
          ) : null}
          {episode.data.sync.state === "error" && !episode.data.request ? (
            <Alert tone="error">
              {t("support.connectionError")}{" "}
              <Button onClick={() => void episode.refetch()}>{t("support.retry")}</Button>
            </Alert>
          ) : null}
          {episode.data.proposal?.state === "pending" ? (
            <SupportConsentCard
              proposal={episode.data.proposal}
              busy={busy}
              onDecision={(kind, locale) => void decision(kind, locale)}
            />
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Textarea
              label={t("support.message")}
              maxLength={2_000}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                if (attempt?.text !== event.target.value) {
                  setAttempt(null);
                  if (actionError === "send") setActionError(null);
                }
              }}
            />
            <Button
              type="submit"
              disabled={
                busy ||
                !draft.trim() ||
                (Boolean(attempt) &&
                  episode.data.messages.some(
                    (message) => message.delivery === "uncertain" && message.text === attempt?.text,
                  ))
              }
            >
              {t("support.send")}
            </Button>
          </form>
          {episode.data.messages.some((message) => message.delivery === "uncertain") ? (
            <Alert tone="warn">{t("support.uncertain")}</Alert>
          ) : null}
        </>
      ) : null}
      {actionError ? (
        <Alert tone="error">
          {t(actionError === "send" ? "support.sendError" : "support.actionError")}{" "}
          {actionError === "send" ? (
            <Button disabled={busy || !attempt} onClick={() => void submit()}>
              {t("support.retry")}
            </Button>
          ) : null}
        </Alert>
      ) : null}
    </section>
  );
}

export function SupportChatPage() {
  const { t } = useTranslation();
  const auth = useAuthClient();
  const session = auth.useSession();
  const { orgId } = useActiveOrg();
  if (session.isPending) return <Spinner label={t("support.loading")} />;
  if (!session.data?.user.id || !orgId)
    return <Alert tone="error">{t("support.accessLost")}</Alert>;
  return (
    <Chat key={`${orgId}:${session.data.user.id}`} tenantId={orgId} userId={session.data.user.id} />
  );
}
