import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Textarea } from "@markiro/ui";

import type { HostApi } from "../../host/api.js";
import { PROTOCOL_VERSION } from "../../host/protocol.js";
import { useOfficeFiles } from "../exports/office-files-context.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { useOfficeLink } from "../office-link.js";
import { useOfficeSession } from "../office-session.js";
import { ABOUT_KEY, loadAboutData } from "./about-data.js";
import { useAbout } from "./about-context.js";
import { BUILD_INFO } from "./build-info.js";
import { copyText } from "./clipboard.js";
import { ALTERNATIVE_SUPPORT_EMAIL, PRIMARY_SUPPORT_EMAIL, supportMailLink } from "./contacts.js";
import { buildSupportReport, type SupportFacts } from "./support-report.js";
import { collectSupportBlocks, SUPPORT_CONTRIBUTORS } from "./support-blocks.js";
import { licenseLoadOf, usageLoadOf } from "./support-usage.js";

/** The folder under `Документы\Markiro\Выгрузки` the support text is saved into. */
const SAVE_SEGMENTS = ["Выгрузки", "Сведения для поддержки"] as const;

type Copied = "copied" | "failed";
type Saved = { kind: "saved"; path: string; segments: readonly string[] } | { kind: "failed" };

/** «2026-10-13_09-41-05» of an instant, UTC, for a file name. */
function stamp(when: Date): string {
  return when.toISOString().slice(0, 19).replace("T", "_").replaceAll(":", "-");
}

/**
 * «Сведения для поддержки»: one click builds the text (versions, role, link,
 * the last copy, the license state: `buildSupportReport`'s allowlist, no
 * secrets, and the usage statistics as one encrypted token only the maker
 * can open) and copies it. The text stays on screen to copy by hand when the
 * clipboard refuses, to save into a file, and «Написать в поддержку» opens a
 * letter with no body: the text is pasted, never put into the link.
 */
export function SupportSection() {
  const { t } = useTranslation();
  const about = useAbout();
  const files = useOfficeFiles();
  const link = useOfficeLink();
  const queryClient = useQueryClient();
  const session = useOfficeSession();
  const backups = useOfficeQuery(officeKeys.backups, (api, token) => api.getBackups(token));

  /** The host through the session, for the contributors (`SupportContext.read`). */
  function readHost<T>(operation: (api: HostApi, token: string) => Promise<T>): Promise<T> {
    return session.call((token) => operation(session.api, token));
  }
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState<Copied | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [mailFailed, setMailFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const build = async () => {
    setBusy(true);
    setSaved(null);
    // The host's answer as of this click, not as of the page's opening.
    const fresh = await loadAboutData(about);
    queryClient.setQueryData(ABOUT_KEY, fresh);
    const backupState = (await backups.refetch()).data;
    const facts: SupportFacts = {
      generatedAt: new Date(),
      appVersion: fresh.appVersion,
      buildCommit: BUILD_INFO.commit,
      buildDate: BUILD_INFO.date,
      appProtocol: PROTOCOL_VERSION,
      hostVersion: fresh.hello?.version ?? null,
      hostProtocol: fresh.hello?.protocol ?? null,
      hostMinProtocol: fresh.hello?.minProtocol ?? null,
      role: fresh.role,
      os: fresh.system?.os ?? null,
      arch: fresh.system?.arch ?? null,
      webview: fresh.system?.webview ?? null,
      hostReachable: fresh.hello !== null,
      linkState: link.status?.state ?? null,
      hostAddress: fresh.hostAddress,
      hostId: fresh.hostId,
      lastBackupAt: backupState?.local.copies[0]?.createdAt ?? null,
    };
    // The counts by month, as of this click: an administrator's, else the block says why not.
    const [usageResult, licenseResult] = await Promise.allSettled([
      session.call((token) => session.api.getUsageStats(token)),
      session.call((token) => session.api.getLicense(token)),
    ]);
    const blocks = await collectSupportBlocks(SUPPORT_CONTRIBUTORS, {
      t,
      facts,
      about: fresh,
      read: readHost,
      ...(usageResult === undefined ? {} : { usage: usageLoadOf(usageResult) }),
      ...(licenseResult === undefined ? {} : { license: licenseLoadOf(licenseResult) }),
    });
    const report = buildSupportReport(facts, t, blocks);
    setText(report);
    setCopied((await copyText(report)) ? "copied" : "failed");
    setBusy(false);
  };

  const save = async () => {
    if (text === null) return;
    setSaved(null);
    try {
      const folder = await files.save(SAVE_SEGMENTS, [
        {
          name: `markiro-support-${stamp(new Date())}.txt`,
          bytes: new TextEncoder().encode(`\uFEFF${text}`),
        },
      ]);
      setSaved({ kind: "saved", path: folder.path, segments: folder.segments });
    } catch {
      setSaved({ kind: "failed" });
    }
  };

  const mail = () => {
    setMailFailed(false);
    about.openLink(supportMailLink()).catch(() => setMailFailed(true));
  };

  return (
    <Card title={t("office.about.support.title")} titleAs="h2">
      <div className="standalone-form">
        <p>{t("office.about.support.intro")}</p>
        <div className="standalone-form__actions">
          <Button size="md" variant="primary" loading={busy} onClick={() => void build()}>
            {t("office.about.support.build")}
          </Button>
          <Button variant="secondary" onClick={mail}>
            {t("office.about.support.write")}
          </Button>
        </div>
        <div aria-live="polite">
          {copied === "copied" && (
            <Alert tone="ok" role="presentation">
              {t("office.about.support.copied")}
            </Alert>
          )}
          {copied === "failed" && (
            <Alert tone="warn" role="presentation">
              {t("office.about.support.copyFailed")}
            </Alert>
          )}
          {saved?.kind === "saved" && (
            <Alert tone="ok" role="presentation">
              {t("office.about.support.saved", { path: saved.path })}
            </Alert>
          )}
          {saved?.kind === "failed" && (
            <Alert tone="error" role="presentation">
              {t("office.about.support.saveFailed")}
            </Alert>
          )}
          {mailFailed && (
            <Alert tone="warn" role="presentation">
              {t("office.about.contacts.openFailed", {
                email: PRIMARY_SUPPORT_EMAIL,
                other: ALTERNATIVE_SUPPORT_EMAIL,
              })}
            </Alert>
          )}
        </div>
        {text !== null && (
          <>
            <Textarea
              label={t("office.about.support.textLabel")}
              readOnly
              rows={18}
              value={text}
              onFocus={(event) => event.currentTarget.select()}
              style={{ fontFamily: "var(--font-mono)" }}
            />
            <div className="standalone-form__actions">
              <Button variant="secondary" onClick={() => void save()}>
                {t("office.about.support.save")}
              </Button>
              {saved?.kind === "saved" && (
                <Button
                  variant="secondary"
                  onClick={() => void files.open(saved.segments).catch(() => undefined)}
                >
                  {t("office.about.support.showFolder")}
                </Button>
              )}
            </div>
            <p className="office-note">{t("office.about.support.pasteHint")}</p>
          </>
        )}
      </div>
    </Card>
  );
}
