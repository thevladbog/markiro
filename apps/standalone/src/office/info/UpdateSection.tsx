import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DefinitionGrid,
  type DefinitionGridItem,
} from "@markiro/ui";

import { errorMessageKey } from "../../host/errors.js";
import { useOfficeSession } from "../office-session.js";
import { PageLoading } from "../page-state.js";
import { useThisDeviceId } from "../this-device.js";
import { useAboutData } from "./about-data.js";
import { useUpdateShell } from "./update-context.js";
import {
  BackupFailedError,
  BackupTimeoutError,
  installWarnings,
  runUpdate,
  type InstallWarnings,
  type UpdatePhase,
} from "./update-flow.js";
import {
  UpdateShellError,
  type FoundPackage,
  type UpdateOutcome,
  type VerifiedReport,
} from "./update-shell.js";

export const UPDATE_PACKAGES_KEY = ["office", "about", "update", "packages"] as const;
export const UPDATE_OUTCOME_KEY = ["office", "about", "update", "outcome"] as const;

const RELEASE_DATE = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

/** The text of a failed search, check or launch. */
export function updateErrorText(t: TFunction, error: unknown): string {
  if (error instanceof UpdateShellError) return t(`office.about.update.error.${error.code}`);
  if (error instanceof BackupFailedError) {
    return t("office.about.update.error.backup_failed", { code: error.code ?? "—" });
  }
  if (error instanceof BackupTimeoutError) return t("office.about.update.error.backup_timeout");
  return t(errorMessageKey(error));
}

/** Why the report refuses the package, in words; `null` when it does not. */
export function refusalText(t: TFunction, report: VerifiedReport): string | null {
  const refusal = report.refusal;
  if (refusal === null) return null;
  switch (refusal.code) {
    case "older":
      return t("office.about.update.refusal.older", { installed: refusal.installed });
    case "min_upgrade":
      return t("office.about.update.refusal.min_upgrade", { version: refusal.minUpgradeFrom });
    case "host_first":
      return t("office.about.update.refusal.host_first", {
        protocol: refusal.protocol,
        host: refusal.hostProtocol,
      });
  }
}

/**
 * «Обновление» (spec §9.3, the part «Из файла»): this PC's version, what the
 * last update came to and, for an administrator, the packages found on this
 * PC — checked, then installed with Windows' administrator prompt.
 */
export function UpdateSection() {
  const { t } = useTranslation();
  const { user } = useOfficeSession();
  const about = useAboutData();
  const shell = useUpdateShell();
  const outcome = useQuery({ queryKey: UPDATE_OUTCOME_KEY, queryFn: () => shell.outcome() });
  const items: DefinitionGridItem[] = [
    {
      id: "thisVersion",
      term: t("office.about.update.thisVersion"),
      description: about.data?.appVersion ?? t("office.about.report.unknown"),
      mono: true,
    },
  ];
  return (
    <Card title={t("office.about.update.title")} titleAs="h2">
      <DefinitionGrid items={items} />
      {outcome.data ? (
        <OutcomeAlert outcome={outcome.data} onHidden={() => void outcome.refetch()} />
      ) : null}
      {user.role === "admin" ? (
        <UpdateFromFile />
      ) : (
        <p className="office-note">{t("office.about.update.adminOnly")}</p>
      )}
    </Card>
  );
}

function OutcomeAlert({
  outcome,
  onHidden,
}: {
  outcome: NonNullable<UpdateOutcome>;
  onHidden: () => void;
}) {
  const { t } = useTranslation();
  const shell = useUpdateShell();
  const [failed, setFailed] = useState(false);
  const hide = async () => {
    try {
      await shell.dismissOutcome();
      onHidden();
    } catch {
      setFailed(true);
    }
  };
  const updated = outcome.kind === "updated";
  return (
    <Alert
      tone={updated ? "ok" : "warn"}
      action={
        <Button variant="secondary" size="compact" onClick={() => void hide()}>
          {t("office.about.update.outcome.dismiss")}
        </Button>
      }
    >
      {updated
        ? t("office.about.update.outcome.updated", { to: outcome.to })
        : t("office.about.update.outcome.notFinished", { from: outcome.from, to: outcome.to })}
      {failed ? ` ${t("office.about.update.error.storage")}` : null}
    </Alert>
  );
}

function UpdateFromFile() {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const about = useAboutData();
  const thisDeviceId = useThisDeviceId();
  const shell = useUpdateShell();
  const packages = useQuery({ queryKey: UPDATE_PACKAGES_KEY, queryFn: () => shell.scan() });
  const [checking, setChecking] = useState<string | null>(null);
  const [report, setReport] = useState<VerifiedReport | null>(null);
  const [warnings, setWarnings] = useState<InstallWarnings | null>(null);
  const [phase, setPhase] = useState<UpdatePhase | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const role = about.data?.role ?? "unknown";

  const check = async (found: FoundPackage) => {
    setChecking(found.path);
    setReport(null);
    setFailure(null);
    try {
      setReport(await shell.verify(found.path));
    } catch (error) {
      setFailure(error);
    } finally {
      setChecking(null);
    }
  };

  const prepare = async (checked: VerifiedReport) => {
    setFailure(null);
    try {
      const [devices, shifts] = await Promise.all([
        role === "host"
          ? session.call((token) => session.api.listDevices(token))
          : Promise.resolve([]),
        // Without the host there is no list: no shift to name, the shell's own warning says the rest.
        session.call((token) => session.api.listShifts(token)).catch(() => []),
      ]);
      setWarnings(installWarnings({ report: checked, role, devices, shifts, thisDeviceId }));
    } catch (error) {
      setFailure(error);
    }
  };

  const install = async (checked: VerifiedReport) => {
    setWarnings(null);
    setFailure(null);
    try {
      await runUpdate(
        {
          call: session.call,
          api: session.api,
          shell,
          now: () => Date.now(),
          sleep: (ms) =>
            new Promise<void>((resolve) => {
              setTimeout(resolve, ms);
            }),
          onPhase: setPhase,
        },
        checked,
        role,
      );
    } catch (error) {
      setFailure(error);
      setPhase(null);
    }
  };

  const openFolder = async () => {
    setFailure(null);
    try {
      await shell.openFolder();
    } catch (error) {
      setFailure(error);
    }
  };

  const busy = checking !== null || phase !== null;
  return (
    <section aria-labelledby="update-from-file">
      <h3 id="update-from-file">{t("office.about.update.fromFile")}</h3>
      <p className="office-note">{t("office.about.update.hint")}</p>
      <div>
        <Button
          variant="secondary"
          loading={packages.isFetching}
          disabled={busy}
          onClick={() => void packages.refetch()}
        >
          {t("office.about.update.search")}
        </Button>{" "}
        <Button variant="secondary" onClick={() => void openFolder()}>
          {t("office.about.update.openFolder")}
        </Button>
      </div>
      {packages.isPending ? (
        <PageLoading />
      ) : packages.isError ? (
        <Alert
          tone={
            packages.error instanceof UpdateShellError && packages.error.code === "unsupported"
              ? "info"
              : "error"
          }
        >
          {packages.error instanceof UpdateShellError && packages.error.code === "unsupported"
            ? t("office.about.update.unavailable")
            : updateErrorText(t, packages.error)}
        </Alert>
      ) : packages.data.length === 0 ? (
        <p className="office-note">{t("office.about.update.none")}</p>
      ) : (
        <ul aria-label={t("office.about.update.found")}>
          {packages.data.map((found) => (
            <li key={found.path}>
              <span>{found.fileName}</span>{" "}
              <span>
                (
                {found.place === "documents"
                  ? t("office.about.update.placeDocuments")
                  : t("office.about.update.placeRemovable")}
                )
              </span>{" "}
              {found.manifest === null ? (
                <span>
                  {t(`office.about.update.problem.${found.problem ?? "manifest_malformed"}`)}
                </span>
              ) : (
                <>
                  <span>
                    {t("office.about.update.notChecked", { version: found.manifest.version })}
                  </span>{" "}
                  {found.manifest.channel === "beta" ? (
                    <Badge tone="warn">{t("office.about.update.beta")}</Badge>
                  ) : null}{" "}
                  <Button
                    size="compact"
                    variant="secondary"
                    loading={checking === found.path}
                    disabled={busy}
                    onClick={() => void check(found)}
                  >
                    {t("office.about.update.check")}
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {report !== null ? (
        <ReportCard report={report} busy={busy} onInstall={() => void prepare(report)} />
      ) : null}
      {failure !== null ? <Alert tone="error">{updateErrorText(t, failure)}</Alert> : null}
      {/* A polite live region without the status role: the page's loading
          spinner is the one status there (test/about-page.test.tsx waits for it to go). */}
      <p aria-live="polite">
        {checking !== null
          ? t("office.about.update.checking")
          : phase !== null
            ? t(`office.about.update.phase.${phase}`)
            : ""}
      </p>
      {report !== null && warnings !== null ? (
        <ConfirmDialog
          open
          title={t(
            warnings.reinstall
              ? "office.about.update.confirm.reinstallTitle"
              : "office.about.update.confirm.title",
            { version: report.manifest.version },
          )}
          description={<WarningList warnings={warnings} />}
          confirmLabel={t("office.about.update.confirm.go")}
          cancelLabel={t("office.about.update.confirm.cancel")}
          onConfirm={() => void install(report)}
          onCancel={() => setWarnings(null)}
        />
      ) : null}
    </section>
  );
}

function ReportCard({
  report,
  busy,
  onInstall,
}: {
  report: VerifiedReport;
  busy: boolean;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  const refusal = refusalText(t, report);
  const facts: DefinitionGridItem[] = [
    {
      id: "version",
      term: t("office.about.update.versionTerm"),
      description: t("office.about.update.version", {
        version: report.manifest.version,
        installed: report.installed,
      }),
      mono: true,
    },
    {
      id: "releasedAt",
      term: t("office.about.update.releasedAt"),
      description: RELEASE_DATE.format(new Date(report.manifest.releasedAt)),
    },
  ];
  return (
    <div>
      <Alert tone="ok">{t("office.about.update.signed")}</Alert>
      {report.manifest.channel === "beta" ? (
        <Badge tone="warn">{t("office.about.update.beta")}</Badge>
      ) : null}
      <DefinitionGrid items={facts} />
      <h4>{t("office.about.update.notes")}</h4>
      <ul>
        {report.manifest.notes.map((note, index) => (
          <li key={`${index}:${note}`}>{note}</li>
        ))}
      </ul>
      {refusal === null ? null : <Alert tone="error">{refusal}</Alert>}
      <Button variant="primary" disabled={refusal !== null || busy} onClick={onInstall}>
        {t("office.about.update.install")}
      </Button>
      <details>
        <summary>{t("office.about.update.manual")}</summary>
        <p className="office-note">{t("office.about.update.manualHint")}</p>
        <DefinitionGrid
          items={[
            {
              id: "installerPath",
              term: t("office.about.update.installerPath"),
              description: report.installerPath,
              mono: true,
            },
            {
              id: "installerSha256",
              term: t("office.about.update.installerSha256"),
              description: report.manifest.installer.sha256,
              mono: true,
            },
          ]}
        />
      </details>
    </div>
  );
}

function WarningList({ warnings }: { warnings: InstallWarnings }) {
  const { t } = useTranslation();
  const lines = [t("office.about.update.confirm.window")];
  if (warnings.hostRole) lines.push(t("office.about.update.confirm.hostRole"));
  if (warnings.incompatibleDevices.length > 0) {
    lines.push(
      t("office.about.update.confirm.devices", { names: warnings.incompatibleDevices.join(", ") }),
    );
  }
  if (warnings.openShift !== null) {
    lines.push(t("office.about.update.confirm.openShift", { number: warnings.openShift }));
  }
  if (warnings.hostSilent) lines.push(t("office.about.update.confirm.hostSilent"));
  if (warnings.reinstall) lines.push(t("office.about.update.confirm.reinstall"));
  return (
    <ul>
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}
