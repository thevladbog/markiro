import { useId } from "react";
import { useTranslation } from "react-i18next";

import {
  compareStandaloneReleaseVersions,
  type StandaloneRelease,
  type StandaloneReleaseChannel,
  type StandaloneReleaseChannelView,
} from "@markiro/platform-contracts";
import { Alert, Button, StatusChip, Table, type TableColumn } from "@markiro/ui";

import { formatMegabytes, formatReleaseDateTime } from "./releaseFormat.js";

export interface PointerMove {
  operationId: string;
  expectedRevision: string;
  channel: StandaloneReleaseChannel;
  version: string;
  previous: string | null;
  direction: "promote" | "rollback";
}

function copyText(value: string) {
  try {
    void navigator.clipboard?.writeText(value).catch(() => undefined);
  } catch {
    // Clipboard permissions are optional; the full hash stays in the title.
  }
}

export function ChannelReleases({
  view,
  busy,
  onMove,
  onRegisterPending,
}: {
  view: StandaloneReleaseChannelView;
  busy: boolean;
  onMove: (move: PointerMove) => void;
  onRegisterPending: (version: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const headingId = useId();
  const { channel, latest } = view;

  const action = (release: StandaloneRelease) => {
    if (release.version === latest) {
      return <StatusChip phase="active" label={t("standaloneReleases.list.latestBadge")} />;
    }
    const direction =
      latest === null || compareStandaloneReleaseVersions(release.version, latest) > 0
        ? "promote"
        : "rollback";
    return (
      <Button
        size="compact"
        variant={direction === "promote" ? "primary" : "secondary"}
        disabled={busy}
        onClick={() =>
          onMove({
            channel,
            version: release.version,
            previous: latest,
            direction,
            operationId: crypto.randomUUID(),
            expectedRevision: view.revision,
          })
        }
      >
        {t(
          direction === "promote"
            ? "standaloneReleases.pointer.promote"
            : "standaloneReleases.pointer.rollback",
        )}
      </Button>
    );
  };

  const columns: TableColumn<StandaloneRelease>[] = [
    {
      key: "version",
      title: t("standaloneReleases.list.version"),
      mono: true,
      render: (release) => release.version,
    },
    {
      key: "releasedAt",
      title: t("standaloneReleases.list.releasedAt"),
      render: (release) => formatReleaseDateTime(release.releasedAt, language),
    },
    {
      key: "registeredAt",
      title: t("standaloneReleases.list.registeredAt"),
      render: (release) => formatReleaseDateTime(release.registeredAt, language),
    },
    {
      key: "size",
      title: t("standaloneReleases.list.size"),
      align: "right",
      mono: true,
      render: (release) =>
        t("standaloneReleases.list.megabytes", {
          value: formatMegabytes(release.installer.sizeBytes, language),
        }),
    },
    {
      key: "sha256",
      title: t("standaloneReleases.list.sha256"),
      render: (release) => (
        <span className="releases-sha">
          <code className="releases-hash" title={release.installer.sha256}>
            {`${release.installer.sha256.slice(0, 12)}…`}
          </code>
          <Button
            size="compact"
            variant="ghost"
            aria-label={t("standaloneReleases.list.copyShaFor", { version: release.version })}
            onClick={() => copyText(release.installer.sha256)}
          >
            {t("standaloneReleases.list.copy")}
          </Button>
        </span>
      ),
    },
    {
      key: "kid",
      title: t("standaloneReleases.list.kid"),
      mono: true,
      render: (release) => release.kid,
    },
    {
      key: "notes",
      title: t("standaloneReleases.list.notes"),
      wrap: true,
      minWidth: 220,
      render: (release) =>
        release.notes.length === 0 ? (
          "—"
        ) : (
          <ul className="releases-notes">
            {release.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        ),
    },
    {
      key: "files",
      title: t("standaloneReleases.list.files"),
      render: (release) => (
        <span className="releases-files">
          <a href={release.installer.url} rel="noreferrer">
            {t("standaloneReleases.list.installerLink")}
          </a>
          <a href={release.manifest.url} rel="noreferrer">
            {t("standaloneReleases.list.manifestLink")}
          </a>
        </span>
      ),
    },
    {
      key: "action",
      title: t("standaloneReleases.list.action"),
      stickyEnd: true,
      render: action,
    },
  ];

  return (
    <section className="commerce-ledger releases-channel" aria-labelledby={headingId}>
      <header className="commerce-ledger__header">
        <h2 id={headingId}>{t(`standaloneReleases.channelTitle.${channel}`)}</h2>
        <span className="commerce-ledger__count">
          {latest === null
            ? t("standaloneReleases.list.noLatest")
            : t("standaloneReleases.list.latest", { version: latest })}
        </span>
      </header>
      <div className="releases-channel__alerts">
        {!view.latestReadable ? (
          <Alert tone="warn">{t("standaloneReleases.list.latestUnreadable")}</Alert>
        ) : null}
        {view.pending.length > 0 ? (
          <Alert tone="warn" title={t("standaloneReleases.pending.title")}>
            <p className="releases-alert-line">{t("standaloneReleases.pending.hint")}</p>
            <ul className="releases-pending">
              {view.pending.map(({ version, intentId }) => (
                <li key={intentId}>
                  <code>{version}</code>
                  <Button
                    size="compact"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => onRegisterPending(intentId)}
                  >
                    {t("standaloneReleases.pending.register")}
                  </Button>
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </div>
      <Table
        scrollLabel={t("standaloneReleases.list.tableRegion", {
          channel: t(`standaloneReleases.channel.${channel}`),
        })}
        rows={view.releases}
        columns={columns}
        getRowKey={(release) => release.version}
        empty={t("standaloneReleases.list.empty")}
      />
    </section>
  );
}
