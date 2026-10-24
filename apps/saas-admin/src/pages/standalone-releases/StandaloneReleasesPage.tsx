import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  StandaloneReleaseChannel,
  StandaloneReleaseChannelView,
  StandaloneReleaseList,
} from "@markiro/platform-contracts";
import { Alert, Card, ConfirmDialog, EmptyState, SectionHeader } from "@markiro/ui";

import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { PanelState } from "../../components/PanelState.js";
import {
  listStandaloneReleases,
  registerStandaloneRelease,
  setStandaloneReleaseLatest,
  standaloneReleaseKeys,
} from "./api.js";
import { ChannelReleases, type PointerMove } from "./ChannelReleases.js";
import { releaseErrorMessage, type ReleaseErrorMessage } from "./errorMessages.js";
import { ReleaseError } from "./ReleaseError.js";
import { ReleaseUpload } from "./ReleaseUpload.js";

type Notice = { tone: "ok"; text: string } | { tone: "error"; message: ReleaseErrorMessage };

export function StandaloneReleasesPage() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const queryClient = useQueryClient();
  const canManage = principal.capabilities.includes("standaloneReleases.manage");
  const list = useQuery({
    queryKey: standaloneReleaseKeys.list(),
    queryFn: listStandaloneReleases,
    enabled: canManage,
  });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [move, setMove] = useState<PointerMove | null>(null);
  const [moveError, setMoveError] = useState<ReleaseErrorMessage | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: standaloneReleaseKeys.all });
  const channelName = (channel: StandaloneReleaseChannel) =>
    t(`standaloneReleases.channel.${channel}`);

  const pointer = useMutation({
    mutationFn: (target: PointerMove) =>
      setStandaloneReleaseLatest(target.channel, {
        version: target.version,
        operationId: target.operationId,
        expectedRevision: target.expectedRevision,
        kind: target.direction === "rollback" ? "rollback" : "forward",
      }),
    onSuccess: (view, target) => {
      queryClient.setQueryData<StandaloneReleaseList>(standaloneReleaseKeys.list(), (current) =>
        current?.configured
          ? {
              ...current,
              channels: current.channels.map((entry) =>
                entry.channel === view.channel ? view : entry,
              ),
            }
          : current,
      );
      setMove(null);
      setNotice({
        tone: "ok",
        text: t("standaloneReleases.pointer.done", {
          channel: channelName(target.channel),
          version: target.version,
        }),
      });
      refresh();
    },
    onError: (error) => setMoveError(releaseErrorMessage("setLatest", error)),
  });

  const pending = useMutation({
    mutationFn: registerStandaloneRelease,
    onSuccess: (result) =>
      setNotice({
        tone: "ok",
        text: t(`standaloneReleases.upload.result.${result.outcome}`, {
          version: result.release.version,
          channel: channelName(result.release.channel),
        }),
      }),
    onError: (error) =>
      setNotice({
        tone: "error",
        message: releaseErrorMessage("register", error),
      }),
    onSettled: refresh,
  });

  const openMove = (next: PointerMove) => {
    setNotice(null);
    setMoveError(null);
    setMove(next);
  };

  const body = () => {
    if (!canManage) return <Alert tone="error">{t("standaloneReleases.forbidden")}</Alert>;
    if (list.isPending || (list.error && list.data === undefined)) {
      return (
        <PanelState
          loading={list.isPending}
          empty={false}
          error={list.error}
          onRetry={() => void list.refetch()}
          loadingText={t("standaloneReleases.loading")}
        >
          {null}
        </PanelState>
      );
    }
    const data = list.data;
    if (!data.configured) {
      return (
        <Card padding={0}>
          <EmptyState
            title={t("standaloneReleases.unconfigured.title")}
            hint={t("standaloneReleases.unconfigured.hint")}
          />
        </Card>
      );
    }
    return (
      <>
        <p className="releases-muted">
          {t("standaloneReleases.publicOrigin", { origin: data.publicOrigin })}
        </p>
        {notice?.tone === "ok" ? (
          <Alert tone="ok" role="status">
            {notice.text}
          </Alert>
        ) : null}
        {notice?.tone === "error" ? <ReleaseError message={notice.message} /> : null}
        <ReleaseUpload onSettled={refresh} />
        {data.channels.map((view: StandaloneReleaseChannelView) => (
          <ChannelReleases
            key={view.channel}
            view={view}
            busy={pending.isPending || pointer.isPending}
            onMove={openMove}
            onRegisterPending={(intentId) => {
              setNotice(null);
              pending.mutate({ intentId });
            }}
          />
        ))}
      </>
    );
  };

  const promote = move?.direction === "promote";
  const moveParams = move
    ? { version: move.version, previous: move.previous ?? "", channel: channelName(move.channel) }
    : {};

  return (
    <section className="releases-page">
      <SectionHeader
        eyebrow="PLATFORM / STANDALONE RELEASES"
        title={t("standaloneReleases.title")}
        description={t("standaloneReleases.description")}
      />
      {body()}
      <ConfirmDialog
        open={move !== null}
        title={t(
          promote
            ? "standaloneReleases.pointer.promoteTitle"
            : "standaloneReleases.pointer.rollbackTitle",
          moveParams,
        )}
        description={t(
          promote
            ? move?.previous
              ? "standaloneReleases.pointer.promoteDescription"
              : "standaloneReleases.pointer.promoteDescriptionFirst"
            : "standaloneReleases.pointer.rollbackDescription",
          moveParams,
        )}
        confirmLabel={t(
          promote
            ? "standaloneReleases.pointer.promote"
            : "standaloneReleases.pointer.rollbackConfirm",
        )}
        cancelLabel={t("standaloneReleases.pointer.cancel")}
        busy={pointer.isPending}
        {...(moveError ? { error: t(moveError.key, moveError.params ?? {}) } : {})}
        onCancel={() => {
          setMove(null);
          setMoveError(null);
        }}
        onConfirm={() => {
          if (!move) return;
          setMoveError(null);
          pointer.mutate(move);
        }}
      />
    </section>
  );
}
