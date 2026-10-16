import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  DefinitionGrid,
  PageHeader,
  type TableColumn,
} from "@markiro/ui";

import type {
  BackupCopy,
  BackupDestination,
  BackupState,
  RestoreHold,
} from "../../host/backups.js";
import { PagedTable } from "../paging/PagedTable.js";
import { HostError } from "../../host/client.js";
import { useCan } from "../access.js";
import { alertFailure, failureMessage, type AlertFailure } from "../form-errors.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { formatSize } from "./backup-format.js";
import { useBackupPolling } from "./backup-polling.js";
import { useBackupTime, type BackupTime } from "./backup-time.js";
import { failureReason } from "./backup-warnings.js";
import { BackupWarnings } from "./BackupWarnings.js";
import { SecondDirForm } from "./SecondDirForm.js";

/**
 * «Резервные копии» (plan РК): the stations' facts a restore holds, both
 * folders, their last copy and attempt, the copies on the host, «Сделать
 * копию сейчас», the second folder and resuming the facts for
 * administrators, and how a copy is restored (by support, on the host).
 * Technologists see all of it and are told what only an administrator may do.
 */
export function BackupsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t("office.backups.title")} description={t("office.backups.subtitle")} />
      <BackupsContent />
    </>
  );
}

function isRunningConflict(error: unknown): boolean {
  return (
    error instanceof HostError &&
    error.code === "conflict" &&
    error.details.constraint === "backup_running"
  );
}

function BackupsContent() {
  const { t } = useTranslation();
  const canManage = useCan("manageBackups");
  const queryClient = useQueryClient();
  const backups = useOfficeQuery(officeKeys.backups, (api, token) => api.getBackups(token));
  const time = useBackupTime();
  const state = backups.data;
  // Read again while the page is open, and quickly while a copy runs.
  useBackupPolling(async () => (await backups.refetch({ cancelRefetch: false })).isSuccess, {
    enabled: state !== undefined,
    running: state?.running != null,
  });
  const start = useOfficeMutation<void, BackupState>((api, token) => api.startBackup(token));
  // The host's time of the request «Сделать копию сейчас» made, to tell its copy from an older one.
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const [startFailure, setStartFailure] = useState<AlertFailure | "running" | null>(null);
  const [savedRev, setSavedRev] = useState<number | null>(null);
  const [resumed, setResumed] = useState(false);

  const shown = state !== undefined && time.ready ? state : null;
  const running = shown?.running != null;
  const attempt = shown?.local.lastAttempt;
  const done =
    askedAt !== null && !running && attempt?.ok === true && Date.parse(attempt.at) >= askedAt;

  const copyNow = async () => {
    if (shown === null) return;
    setStartFailure(null);
    setAskedAt(null);
    setResumed(false);
    try {
      const answer = await start.mutateAsync();
      queryClient.setQueryData(officeKeys.backups, answer);
      setAskedAt(Date.parse(answer.now));
    } catch (error) {
      if (isRunningConflict(error)) {
        // A copy is on its way already: show it, as the next read will.
        setStartFailure("running");
        setAskedAt(Date.parse(shown.now));
        void backups.refetch();
      } else {
        setStartFailure(alertFailure(error));
      }
    }
  };

  let body: ReactNode;
  if (shown === null) {
    body =
      state === undefined && backups.isError ? (
        <LoadError error={backups.error} onRetry={() => void backups.refetch()} />
      ) : (
        <PageLoading />
      );
  } else {
    body = (
      <>
        <p className="office-note">
          {time.note === null
            ? t("office.backups.timeZoneNote", { zone: time.zone?.replaceAll("_", " ") })
            : t(`office.backups.${time.note}`)}
        </p>
        {shown.restoreHold !== null && (
          <RestoreHoldCard
            hold={shown.restoreHold}
            canManage={canManage}
            format={time.format}
            onResumed={(next) => {
              queryClient.setQueryData(officeKeys.backups, next);
              setResumed(true);
            }}
          />
        )}
        <Card title={t("office.backups.local")} titleAs="h2">
          <div className="standalone-form">
            <div className="backup-alerts" aria-live="polite">
              {done && (
                <Alert tone="ok" role="presentation">
                  {t("office.backups.done")}
                </Alert>
              )}
              {startFailure === "running" && (
                <Alert tone="info" role="presentation">
                  {t("office.backups.alreadyRunning")}
                </Alert>
              )}
              {startFailure !== null && startFailure !== "running" && (
                <Alert tone="error" role="presentation">
                  {t(failureMessage(startFailure))}
                </Alert>
              )}
            </div>
            <Destination destination={shown.local} time={time} />
            {canManage ? (
              <div className="standalone-form__actions">
                <Button
                  size="md"
                  loading={running || start.isPending}
                  onClick={() => void copyNow()}
                >
                  {running ? t("office.backups.running") : t("office.backups.copyNow")}
                </Button>
              </div>
            ) : (
              <p className="office-note">{t("office.backups.adminOnlyCopy")}</p>
            )}
          </div>
        </Card>
        <Card title={t("office.backups.second")} titleAs="h2">
          <div className="standalone-form">
            <div className="backup-alerts" aria-live="polite">
              {savedRev === shown.settingsRev && (
                <Alert tone="ok" role="presentation">
                  {t("office.common.saved")}
                </Alert>
              )}
            </div>
            {shown.second === null ? (
              <>
                <p>{t("office.backups.secondNotSet")}</p>
                <p className="office-note">{t("office.backups.secondNotSetHint")}</p>
              </>
            ) : (
              <Destination destination={shown.second} time={time} />
            )}
            {canManage ? (
              <SecondDirForm
                key={shown.settingsRev}
                state={shown}
                onSaved={(next) => {
                  queryClient.setQueryData(officeKeys.backups, next);
                  setSavedRev(next.settingsRev);
                }}
                onSubmitStart={() => setSavedRev(null)}
                onReload={() => void backups.refetch()}
              />
            ) : (
              <p className="office-note">{t("office.common.readOnly")}</p>
            )}
          </div>
        </Card>
        <Card title={t("office.backups.copies")} titleAs="h2">
          <CopiesTable copies={shown.local.copies} time={time} />
        </Card>
        <Card title={t("office.backups.restore.title")} titleAs="h2">
          <div className="standalone-form">
            <p>{t("office.backups.restore.who")}</p>
            <ol>
              <li>{t("office.backups.restore.stop")}</li>
              <li>{t("office.backups.restore.run")}</li>
              <li>{t("office.backups.restore.start")}</li>
            </ol>
            <p className="office-note">{t("office.backups.restore.after")}</p>
            <p className="office-note">{t("office.backups.restore.newPc")}</p>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      {/*
        The warnings, and what happened to the page's state, share one polite
        region that is on the screen before any of them, so each is heard once,
        when it comes; their alerts lose their own role (`presentation`) for
        that reason.
      */}
      <div className="backup-alerts" aria-live="polite">
        {shown !== null && backups.isError && (
          <Alert
            tone="warn"
            role="presentation"
            action={
              <Button variant="secondary" size="compact" onClick={() => void backups.refetch()}>
                {t("office.common.retry")}
              </Button>
            }
          >
            {t("office.backups.refreshFailed")}
          </Alert>
        )}
        {resumed && (
          <Alert tone="ok" role="presentation">
            {t("office.backups.resumed")}
          </Alert>
        )}
        {shown !== null && <BackupWarnings state={shown} format={time.format} />}
      </div>
      {body}
    </>
  );
}

type HoldStation = RestoreHold["stations"][number];

interface RestoreHoldCardProps {
  hold: RestoreHold;
  canManage: boolean;
  format: (instant: string) => string;
  onResumed: (state: BackupState) => void;
}

/**
 * The stations after a restore, each with whether the host marks it as having
 * given its blocks back (plan РК-С: a station does by itself once it is online;
 * the host marks it once it received the last part of its blocks, even when it
 * refused some or all of them, which only the station's status bar shows, and
 * marks a station that never took a block by its empty last part, plans ХП and
 * ОЧ), and, for an administrator, resuming the facts the host
 * holds until then. A station on a dead computer never gives them back, so the
 * administrator resumes only after the SSCC checks, and says so in a
 * confirmation that is not one click.
 */
function RestoreHoldCard({ hold, canManage, format, onResumed }: RestoreHoldCardProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const resume = useOfficeMutation<void, BackupState>((api, token) => api.resumeFacts(token));
  const columns: TableColumn<HoldStation>[] = [
    { key: "name", title: t("office.backups.hold.station"), render: (station) => station.name },
    {
      key: "lastSeen",
      title: t("office.backups.hold.lastSeen"),
      render: (station) =>
        station.lastSeenAt === null ? t("office.common.none") : format(station.lastSeenAt),
    },
    {
      key: "blocks",
      title: t("office.backups.hold.blocks"),
      render: (station) =>
        t(station.reconciled ? "office.backups.hold.returned" : "office.backups.hold.notReturned"),
    },
  ];
  const returned = hold.stations.filter((station) => station.reconciled).length;
  const open = () => {
    setFailure(null);
    setAcknowledged(false);
    setConfirming(true);
  };
  const confirm = async () => {
    setFailure(null);
    try {
      const next = await resume.mutateAsync();
      setConfirming(false);
      onResumed(next);
    } catch (error) {
      setFailure(alertFailure(error));
    }
  };
  return (
    <Card title={t("office.backups.hold.title")} titleAs="h2">
      <div className="standalone-form">
        <DefinitionGrid
          items={[
            {
              id: "since",
              term: t("office.backups.hold.since"),
              description: format(hold.since),
            },
            {
              id: "epoch",
              term: t("office.backups.hold.epoch"),
              description: hold.epoch,
              mono: true,
            },
          ]}
        />
        <p>{t("office.backups.hold.text")}</p>
        <PagedTable
          tableId="backup-copies"
          columns={columns}
          rows={hold.stations}
          getRowKey={(station) => station.id}
          empty={t("office.backups.hold.noStations")}
          scrollLabel={t("office.backups.hold.title")}
        />
        <p className="office-note">{t("office.backups.hold.blocksNote")}</p>
        {canManage ? (
          <div className="standalone-form__actions">
            <Button size="md" onClick={open}>
              {t("office.backups.hold.resume")}
            </Button>
          </div>
        ) : (
          <p className="office-note">{t("office.backups.adminOnlyResume")}</p>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        title={t("office.backups.hold.confirmTitle")}
        description={
          <div className="standalone-form">
            <p>{t("office.backups.hold.confirmChecks")}</p>
            <p>
              {t("office.backups.hold.confirmCount", {
                returned,
                total: hold.stations.length,
                count: hold.stations.length,
              })}
            </p>
            <p>{t("office.backups.hold.confirmNotReturned")}</p>
            <p>{t("office.backups.hold.confirmRisk")}</p>
            <p>
              {t("office.backups.hold.confirmFacts", {
                since: format(hold.since),
                epoch: hold.epoch,
              })}
            </p>
          </div>
        }
        entity={
          <Checkbox
            label={t("office.backups.hold.confirmCheck")}
            checked={acknowledged}
            onCheckedChange={setAcknowledged}
          />
        }
        {...(failure === null ? {} : { error: t(failureMessage(failure)) })}
        confirmLabel={t("office.backups.hold.resume")}
        cancelLabel={t("office.common.cancel")}
        confirmDisabled={!acknowledged}
        busy={resume.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void confirm()}
      />
    </Card>
  );
}

function Destination({ destination, time }: { destination: BackupDestination; time: BackupTime }) {
  const { t } = useTranslation();
  const newest = destination.copies[0];
  const attempt = destination.lastAttempt;
  let attemptText = t("office.backups.notTried");
  if (attempt !== null) {
    attemptText = attempt.ok
      ? t("office.backups.attemptOk", { when: time.format(attempt.at) })
      : t("office.backups.attemptFailed", {
          when: time.format(attempt.at),
          reason: t(`office.backups.failures.${failureReason(attempt.code)}`),
        });
  }
  return (
    <DefinitionGrid
      items={[
        { id: "dir", term: t("office.backups.dir"), description: destination.dir, mono: true },
        {
          id: "last-copy",
          term: t("office.backups.lastCopy"),
          description:
            newest === undefined
              ? t("office.common.none")
              : t("office.backups.copyOf", {
                  when: time.format(newest.createdAt),
                  size: formatSize(newest.sizeBytes, t),
                }),
        },
        { id: "last-attempt", term: t("office.backups.lastAttempt"), description: attemptText },
      ]}
    />
  );
}

function CopiesTable({ copies, time }: { copies: BackupCopy[]; time: BackupTime }) {
  const { t } = useTranslation();
  const columns: TableColumn<BackupCopy>[] = [
    {
      key: "createdAt",
      title: t("office.backups.table.createdAt"),
      render: (copy) => time.format(copy.createdAt),
    },
    {
      key: "trigger",
      title: t("office.backups.table.trigger"),
      render: (copy) => t(`office.backups.triggers.${copy.trigger}`),
    },
    {
      key: "size",
      title: t("office.backups.table.size"),
      align: "right",
      mono: true,
      render: (copy) => formatSize(copy.sizeBytes, t),
    },
    {
      key: "identity",
      title: t("office.backups.table.identity"),
      render: (copy) =>
        t(copy.hostIdentity ? "office.backups.identity.yes" : "office.backups.identity.no"),
    },
  ];
  return (
    <>
      <PagedTable
        tableId="backup-restore-copies"
        columns={columns}
        rows={copies}
        getRowKey={(copy) => copy.file}
        empty={t("office.backups.noCopiesYet")}
        scrollLabel={t("office.backups.copies")}
      />
      {copies.length > 0 && <p className="office-note">{t("office.backups.identity.note")}</p>}
    </>
  );
}
