import { useId } from "react";
import { useTranslation } from "react-i18next";

import {
  compareStandaloneReleaseVersions,
  type StandaloneRelease,
  type StandaloneReleaseChannel,
  type StandaloneReleaseChannelView,
} from "@markiro/platform-contracts";
import { Alert, Button, StatusChip } from "@markiro/ui";

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
      <div className="releases-history">
        {view.releases.length === 0 ? (
          <p className="releases-muted">{t("standaloneReleases.list.empty")}</p>
        ) : (
          view.releases.map((release) => (
            <article className="releases-entry" key={release.version} aria-label={release.version}>
              <header className="releases-entry__header">
                <h3 className="releases-entry__version">{release.version}</h3>
                <div className="releases-actions">{action(release)}</div>
              </header>
              <dl className="releases-entry__meta">
                <div>
                  <dt>{t("standaloneReleases.list.releasedAt")}</dt>
                  <dd>
                    <time dateTime={release.releasedAt}>
                      {formatReleaseDateTime(release.releasedAt, language)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>{t("standaloneReleases.list.size")}</dt>
                  <dd>
                    {t("standaloneReleases.list.megabytes", {
                      value: formatMegabytes(release.installer.sizeBytes, language),
                    })}
                  </dd>
                </div>
              </dl>
              {release.notes.length > 0 ? (
                <section
                  className="releases-entry__changes"
                  aria-label={t("standaloneReleases.list.notes")}
                >
                  <h4>{t("standaloneReleases.list.notes")}</h4>
                  <ul className="releases-notes">
                    {release.notes.map((note, index) => (
                      <li key={index}>{note}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <footer className="releases-entry__footer">
                <span className="releases-files">
                  <a href={release.installer.url} rel="noreferrer">
                    {t("standaloneReleases.list.installerLink")}
                  </a>
                  <a href={release.manifest.url} rel="noreferrer">
                    {t("standaloneReleases.list.manifestLink")}
                  </a>
                </span>
                <details className="releases-entry__technical">
                  <summary>{t("standaloneReleases.list.technical")}</summary>
                  <dl className="releases-entry__meta">
                    <div>
                      <dt>{t("standaloneReleases.list.registeredAt")}</dt>
                      <dd>{formatReleaseDateTime(release.registeredAt, language)}</dd>
                    </div>
                    <div>
                      <dt>{t("standaloneReleases.list.kid")}</dt>
                      <dd>
                        <code>{release.kid}</code>
                      </dd>
                    </div>
                    <div className="releases-entry__checksum">
                      <dt>{t("standaloneReleases.list.sha256")}</dt>
                      <dd className="releases-sha">
                        <code
                          className="releases-hash releases-hash--full"
                          title={release.installer.sha256}
                        >
                          {release.installer.sha256}
                        </code>
                        <Button
                          size="compact"
                          variant="secondary"
                          aria-label={t("standaloneReleases.list.copyShaFor", {
                            version: release.version,
                          })}
                          onClick={() => copyText(release.installer.sha256)}
                        >
                          {t("standaloneReleases.list.copy")}
                        </Button>
                      </dd>
                    </div>
                  </dl>
                </details>
              </footer>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
