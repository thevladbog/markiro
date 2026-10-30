import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Select } from "@markiro/ui";
import { OnlineUpdateError, type OnlineOffer, type ReleaseChannel } from "./online-updates-api.js";
import { UpdateError, type UpdateErrorCode } from "../../update/updates-api.js";
import { useUpdates } from "../../update/updates-context.js";
import { officeKeys } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { stageOnlinePackage } from "./stage-online-package.js";
import { useOnlineUpdates } from "./online-updates-context.js";

export function OnlineUpdateBlock({
  disabled,
  onBusy,
  onReset,
  onDownloaded,
}: {
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onReset: () => void;
  onDownloaded: (path: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const api = useOnlineUpdates();
  const updates = useUpdates();
  const session = useOfficeSession();
  const queryClient = useQueryClient();
  const [channel, setChannel] = useState<ReleaseChannel>("stable");
  const [offer, setOffer] = useState<OnlineOffer | null>(null);
  const [phase, setPhase] = useState<"check" | "download" | "verify" | "stage" | null>(null);
  const [received, setReceived] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [localPackage, setLocalPackage] = useState<{ path: string; version: string } | null>(null);
  const [staged, setStaged] = useState<string | null>(null);
  const [stageFailure, setStageFailure] = useState<UpdateErrorCode | null>(null);
  const generation = useRef(0);
  const running = useRef(false);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const transfer = async (path: string, version: string, mine: number) => {
    setPhase("stage");
    setStageFailure(null);
    try {
      await stageOnlinePackage(session, updates, path, version);
      if (mine === generation.current) {
        setStaged(version);
        void queryClient.invalidateQueries({ queryKey: officeKeys.updateStatus });
      }
    } catch (error) {
      if (mine === generation.current)
        setStageFailure(error instanceof UpdateError ? error.code : "refused");
    }
  };
  const retryTransfer = async () => {
    if (running.current || disabled || localPackage === null) return;
    const mine = ++generation.current;
    running.current = true;
    onBusy(true);
    try {
      await transfer(localPackage.path, localPackage.version, mine);
    } finally {
      if (mine === generation.current) {
        running.current = false;
        setPhase(null);
        onBusy(false);
      }
    }
  };
  const work = async (download: boolean) => {
    if (running.current || disabled) return;
    const selected = offer;
    if (download && selected === null) return;
    const mine = ++generation.current;
    running.current = true;
    onBusy(true);
    onReset();
    setPhase(download ? "download" : "check");
    setFailure(null);
    setReceived(0);
    setDownloaded(false);
    setLocalPackage(null);
    setStaged(null);
    setStageFailure(null);
    if (!download) setOffer(null);
    try {
      if (download && selected !== null) {
        const result = await api.download(
          channel,
          selected.manifest.version,
          ({ received: bytes }) => {
            if (mine === generation.current) setReceived(bytes);
          },
        );
        if (mine === generation.current) {
          setPhase("verify");
          const verified = await onDownloaded(result.manifestPath);
          if (mine !== generation.current) return;
          setDownloaded(true);
          if (verified) {
            setLocalPackage({ path: result.manifestPath, version: result.version });
            await transfer(result.manifestPath, result.version, mine);
          }
        }
      } else {
        const result = await api.check(channel);
        if (mine === generation.current) setOffer(result);
      }
    } catch (error) {
      if (mine === generation.current)
        setFailure(error instanceof OnlineUpdateError ? error.code : "refused");
    } finally {
      if (mine === generation.current) {
        running.current = false;
        setPhase(null);
        onBusy(false);
      }
    }
  };
  const busy = disabled || phase !== null;
  return (
    <section className="office-stack" aria-labelledby="update-online">
      <div className="office-section-intro">
        <h3 id="update-online">{t("office.about.update.online.title")}</h3>
        <p className="office-note">{t("office.about.update.online.hint")}</p>
      </div>
      <Select<ReleaseChannel>
        label={t("office.about.update.online.channel")}
        value={channel}
        disabled={busy}
        options={[
          { value: "stable", label: t("office.about.update.online.stable") },
          { value: "beta", label: t("office.about.update.online.beta") },
        ]}
        onValueChange={(value) => {
          generation.current += 1;
          setChannel(value);
          setOffer(null);
          setFailure(null);
          setDownloaded(false);
          setLocalPackage(null);
          setStaged(null);
          setStageFailure(null);
          onReset();
        }}
      />
      {channel === "beta" && <Alert tone="warn">{t("office.about.update.online.betaHint")}</Alert>}
      <div className="office-actions">
        <Button
          variant="secondary"
          disabled={busy}
          loading={phase === "check"}
          onClick={() => void work(false)}
        >
          {t("office.about.update.online.check")}
        </Button>
      </div>
      <div aria-live="polite">
        {offer !== null && (
          <div className="office-stack">
            {offer.newer ? (
              <>
                <p>
                  {t("office.about.update.online.available", {
                    version: offer.manifest.version,
                    size: (offer.manifest.sizeBytes / 1048576).toLocaleString("ru-RU", {
                      maximumFractionDigits: 1,
                    }),
                  })}
                </p>
                <ul className="update-release-notes">
                  {offer.manifest.notes.map((note, index) => (
                    <li key={`${index}:${note}`}>{note}</li>
                  ))}
                </ul>
                {!offer.compatible && (
                  <Alert tone="warn">
                    {t("office.about.update.online.intermediate", {
                      version: offer.manifest.minUpgradeFrom,
                    })}
                  </Alert>
                )}
                <div className="office-actions">
                  <Button
                    variant="secondary"
                    disabled={busy || !offer.compatible || downloaded}
                    loading={phase === "download"}
                    onClick={() => void work(true)}
                  >
                    {t("office.about.update.online.download")}
                  </Button>
                </div>
              </>
            ) : (
              <p>{t("office.about.update.online.current")}</p>
            )}
          </div>
        )}
        {phase === "download" && offer !== null && (
          <p>
            {t("office.about.update.online.progress", {
              percent: Math.min(100, Math.floor((received * 100) / offer.manifest.sizeBytes)),
            })}
          </p>
        )}
        {phase === "verify" && <p>{t("office.about.update.checking")}</p>}
        {phase === "stage" && <p>{t("office.about.update.online.staging")}</p>}
        {downloaded && <p>{t("office.about.update.online.downloaded")}</p>}
        {staged !== null && (
          <Alert tone="ok">{t("office.about.update.online.staged", { version: staged })}</Alert>
        )}
        {stageFailure !== null && (
          <div className="office-stack">
            <Alert tone="error">
              {t("office.about.update.online.stageFailed")} {t(`update.errors.${stageFailure}`)}
            </Alert>
            <div className="office-actions">
              <Button variant="secondary" disabled={busy} onClick={() => void retryTransfer()}>
                {t("office.about.update.online.retryStage")}
              </Button>
            </div>
          </div>
        )}
        {failure !== null && (
          <Alert tone="error">{t(`office.about.update.online.errors.${failure}`)}</Alert>
        )}
      </div>
    </section>
  );
}
