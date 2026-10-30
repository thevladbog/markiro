import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
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
import { DeviceVersionsBlock } from "./DeviceVersionsBlock.js";
import { OnlineUpdateBlock } from "./OnlineUpdateBlock.js";
import { HostUpdateBlock } from "./HostUpdateBlock.js";
import { StageToHostButton } from "./StageToHostButton.js";
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
import type { InstallRole } from "../../host/device.js";
import { UpdateShellError, type UpdateOutcome, type VerifiedReport } from "./update-shell.js";

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
    case "host_differs":
      return t("office.about.update.refusal.host_differs", { host: refusal.hostVersion });
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
    <>
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
      <HostUpdateBlock />
      <DeviceVersionsBlock />
    </>
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

/** The roles an update knows: an unknown one installs nothing (the host's PC must copy first). */
type KnownRole = NonNullable<InstallRole>;

function knownRole(role: InstallRole | "unknown" | undefined): KnownRole | null {
  return role === "host" || role === "station" || role === "office" ? role : null;
}

/** The file name of a package's path, Windows or not. */
function fileNameOf(path: string): string {
  return path.split(/[\\/]/u).pop() ?? path;
}

/** A checked package the person is asked to confirm, with what the warnings were computed for. */
interface Pending {
  report: VerifiedReport;
  warnings: InstallWarnings;
  role: KnownRole;
}

function UpdateFromFile() {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const about = useAboutData();
  const thisDeviceId = useThisDeviceId();
  const shell = useUpdateShell();
  const packages = useQuery({ queryKey: UPDATE_PACKAGES_KEY, queryFn: () => shell.scan() });
  const [onlineBusy, setOnlineBusy] = useState(false);
  const [onlineReportPath, setOnlineReportPath] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [report, setReport] = useState<VerifiedReport | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [phase, setPhase] = useState<UpdatePhase | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [focusFailure, setFocusFailure] = useState(false);
  const failureRef = useRef<HTMLDivElement>(null);
  // Bumped by every new check or search: a warning computed for an older report is dropped.
  const generation = useRef(0);
  // `true` once the section is gone: a running update stops before its report and its launch.
  const left = useRef(false);
  const role = knownRole(about.data?.role);

  useEffect(() => {
    left.current = false;
    return () => {
      left.current = true;
    };
  }, []);

  // After a failed install the dialog is gone and its opener disabled: focus the reason.
  useEffect(() => {
    if (focusFailure && failure !== null) {
      failureRef.current?.focus();
      setFocusFailure(false);
    }
  }, [focusFailure, failure]);

  const search = () => {
    generation.current += 1;
    setReport(null);
    setPending(null);
    setFailure(null);
    void packages.refetch();
  };

  const check = async (path: string, online = false): Promise<boolean> => {
    const mine = ++generation.current;
    setChecking(path);
    setOnlineReportPath(online ? path : null);
    setReport(null);
    setPending(null);
    setFailure(null);
    try {
      const checked = await shell.verify(path);
      if (!left.current && mine === generation.current) {
        setReport(checked);
        return true;
      }
    } catch (error) {
      if (!left.current && mine === generation.current) setFailure(error);
    } finally {
      if (!left.current && mine === generation.current) setChecking(null);
    }
    return false;
  };

  const prepare = async (checked: VerifiedReport) => {
    if (role === null) return;
    const mine = generation.current;
    setFailure(null);
    setPreparing(true);
    try {
      const [devices, shifts] = await Promise.all([
        role === "host"
          ? session.call((token) => session.api.listDevices(token))
          : Promise.resolve([]),
        // Without the host there is no list: no shift to name, the shell's own warning says the rest.
        session.call((token) => session.api.listShifts(token)).catch(() => []),
      ]);
      if (mine === generation.current) {
        setPending({
          report: checked,
          role,
          warnings: installWarnings({ report: checked, role, devices, shifts, thisDeviceId }),
        });
      }
    } catch (error) {
      if (mine === generation.current) setFailure(error);
    } finally {
      setPreparing(false);
    }
  };

  const install = async (confirmed: Pending) => {
    setPending(null);
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
          cancelled: () => left.current,
        },
        confirmed.report,
        confirmed.role,
      );
    } catch (error) {
      if (left.current) return;
      setFailure(error);
      setPhase(null);
      setFocusFailure(true);
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

  const busy = onlineBusy || checking !== null || preparing || phase !== null;
  return (
    <div className="office-stack">
      <OnlineUpdateBlock
        disabled={busy}
        onBusy={setOnlineBusy}
        onReset={() => {
          generation.current += 1;
          setReport(null);
          setPending(null);
          setFailure(null);
        }}
        onDownloaded={(path) => check(path, true)}
      />
      <section aria-labelledby="update-from-file" className="office-stack update-from-file">
        <div className="office-section-intro">
          <h3 id="update-from-file">{t("office.about.update.fromFile")}</h3>
          <p className="office-note">{t("office.about.update.hint")}</p>
        </div>
        <div className="office-actions">
          <Button
            variant="secondary"
            loading={packages.isFetching}
            disabled={busy}
            onClick={search}
          >
            {t("office.about.update.search")}
          </Button>
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
          <ul className="update-packages" aria-label={t("office.about.update.found")}>
            {packages.data.map((found) => (
              <li key={found.path} className="update-packages__item">
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
                      aria-label={t("office.about.update.checkPackage", { file: found.fileName })}
                      loading={checking === found.path}
                      disabled={busy}
                      onClick={() => void check(found.path)}
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
          <ReportCard
            report={report}
            busy={busy}
            roleKnown={role !== null}
            manualStage={onlineReportPath !== report.path}
            onInstall={() => void prepare(report)}
          />
        ) : null}
        {failure !== null ? (
          <div ref={failureRef} tabIndex={-1}>
            <Alert tone="error">{updateErrorText(t, failure)}</Alert>
          </div>
        ) : null}
        {/* A polite live region without the status role: the page's loading
          spinner is the one status there (test/about-page.test.tsx waits for it to go). */}
        <p className="update-progress office-note" aria-live="polite">
          {checking !== null
            ? t("office.about.update.checking")
            : phase !== null
              ? t(`office.about.update.phase.${phase}`)
              : ""}
        </p>
        {pending !== null ? (
          <ConfirmDialog
            open
            title={t(
              pending.warnings.reinstall
                ? "office.about.update.confirm.reinstallTitle"
                : "office.about.update.confirm.title",
              { version: pending.report.manifest.version },
            )}
            description={<WarningList warnings={pending.warnings} />}
            confirmLabel={t("office.about.update.confirm.go")}
            cancelLabel={t("office.about.update.confirm.cancel")}
            onConfirm={() => void install(pending)}
            onCancel={() => setPending(null)}
          />
        ) : null}
      </section>
    </div>
  );
}

function ReportCard({
  report,
  busy,
  roleKnown,
  manualStage,
  onInstall,
}: {
  report: VerifiedReport;
  busy: boolean;
  /** Whether this PC's role is known: without it nothing is installed (the host's PC copies first). */
  roleKnown: boolean;
  manualStage: boolean;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  const refusal = refusalText(t, report);
  const facts: DefinitionGridItem[] = [
    {
      id: "package",
      term: t("office.about.update.packageTerm"),
      description: fileNameOf(report.path),
      mono: true,
    },
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
    <div className="office-stack update-report">
      <Alert tone="ok">{t("office.about.update.signed")}</Alert>
      {report.manifest.channel === "beta" ? (
        <Badge tone="warn">{t("office.about.update.beta")}</Badge>
      ) : null}
      <DefinitionGrid items={facts} />
      {report.manifest.notes.length > 0 ? (
        <section className="office-section-intro">
          <h4>{t("office.about.update.notes")}</h4>
          <ul className="update-release-notes">
            {report.manifest.notes.map((note, index) => (
              <li key={`${index}:${note}`}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {refusal === null ? null : <Alert tone="error">{refusal}</Alert>}
      {refusal === null && !roleKnown ? (
        <Alert tone="warn">{t("office.about.update.roleUnknown")}</Alert>
      ) : null}
      <div className="office-actions">
        <Button
          variant="primary"
          disabled={refusal !== null || !roleKnown || busy}
          onClick={onInstall}
        >
          {t("office.about.update.install")}
        </Button>
        {manualStage && <StageToHostButton manifestPath={report.path} />}
      </div>
      <details className="office-disclosure">
        <summary>{t("office.about.update.manual")}</summary>
        <div className="office-stack">
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
        </div>
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
