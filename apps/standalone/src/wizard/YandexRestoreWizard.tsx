import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, Checkbox, Input, Select } from "@markiro/ui";
import { yandexNative, type RecoveryCopy } from "../host/yandex-native.js";
import { yandexErrorCode } from "../host/yandex-errors.js";
import { formatWhen } from "../office/backups/backup-format.js";
export function YandexRestoreWizard({
  onBack,
  onRestored,
}: {
  onBack: () => void;
  onRestored: () => void;
}) {
  const { t } = useTranslation();
  const [id, setId] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const [copies, setCopies] = useState<RecoveryCopy[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (f: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await f();
    } catch (e) {
      setError(yandexErrorCode(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = copies.find((c) => `${c.hostId}/${c.snapshotId}` === selected);
  return (
    <Card title={t("yandex.restoreTitle")}>
      <div className="standalone-form">
        <p>{t("yandex.restoreWarning")}</p>
        <p>{t("yandex.restoreClientId")}</p>
        {error && (
          <Alert tone="warn">
            {t(`yandex.errors.${error}`, { defaultValue: t("yandex.errors.operation_failed") })}
          </Alert>
        )}
        {done ? (
          <>
            <Alert tone="ok">{t("yandex.restored")}</Alert>
            <Button onClick={onRestored}>{t("yandex.openOffice")}</Button>
          </>
        ) : (
          <>
            <Input
              label="ClientID"
              value={id}
              disabled={busy || account !== null}
              onChange={(e) => setId(e.target.value)}
            />
            {!account && (
              <div className="standalone-form__actions">
                <Button
                  disabled={busy || !/^[A-Za-z0-9_-]{1,128}$/u.test(id.trim())}
                  onClick={() =>
                    void act(async () => {
                      const account = await yandexNative.auth(id.trim());
                      const copies = await yandexNative.list();
                      setAccount(account);
                      setCopies(copies);
                    })
                  }
                >
                  {t("yandex.restoreLogin")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      setId((await yandexNative.importProfile()).clientId);
                    })
                  }
                >
                  {t("yandex.import")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await yandexNative.resume();
                      setDone(true);
                    })
                  }
                >
                  {t("yandex.resume")}
                </Button>
              </div>
            )}
            {account && (
              <>
                <p>
                  Яндекс: {account} · ClientID: {id}
                </p>
                <Select
                  label={t("yandex.restoreChoose")}
                  value={selected ?? ""}
                  disabled={busy}
                  searchable
                  options={[
                    { value: "", label: "—" },
                    ...copies.map((c) => ({
                      value: `${c.hostId}/${c.snapshotId}`,
                      label: `${c.organizationLabel} · ${c.inn} · ${formatWhen(c.createdAt, null)} · ${c.hostId} · ${c.appVersion}`,
                    })),
                  ]}
                  onValueChange={(value) => {
                    setSelected(value);
                    setReady(false);
                  }}
                />
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setAccount(null);
                    setReady(false);
                    setCopies([]);
                    setSelected(null);
                  }}
                >
                  {t("yandex.changeAccount")}
                </Button>
                {copy && (
                  <div style={{ overflowWrap: "anywhere" }}>
                    <p>
                      {copy.organizationLabel} · {t("yandex.inn")}: {copy.inn}
                    </p>
                    <p>
                      {t("yandex.hostIdentity")}: {copy.hostId}
                    </p>
                    <p>
                      {t("yandex.copyAt")}: {formatWhen(copy.createdAt, null)} ·{" "}
                      {t("yandex.appVersion")}: {copy.appVersion}
                    </p>
                    <p>
                      {t("yandex.copySize")}: {Math.ceil(copy.sizeBytes / 1048576)} MiB ·{" "}
                      {t("yandex.identityIncluded")}
                    </p>
                  </div>
                )}
                <Button
                  disabled={!copy || busy}
                  onClick={() =>
                    void act(async () => {
                      if (!copy) return;
                      await yandexNative.download(copy.hostId, copy.snapshotId);
                      setReady(true);
                    })
                  }
                >
                  {t("yandex.restoreDownload")}
                </Button>
                {ready && (
                  <>
                    <Alert tone="info">{t("yandex.restoreReady")}</Alert>
                    <Checkbox
                      label={t("yandex.oldStopped")}
                      checked={stopped}
                      onCheckedChange={setStopped}
                    />
                    <Button
                      disabled={!stopped || busy}
                      onClick={() =>
                        void act(async () => {
                          await yandexNative.restore();
                          setDone(true);
                        })
                      }
                    >
                      {t("yandex.restoreApply")}
                    </Button>
                  </>
                )}
              </>
            )}
            {busy && (
              <>
                <p role="status">{t("yandex.working")}</p>
                {!ready && (
                  <Button variant="secondary" onClick={() => void yandexNative.cancel()}>
                    {t("yandex.cancel")}
                  </Button>
                )}
              </>
            )}
            <Button variant="secondary" disabled={busy} onClick={onBack}>
              {t("yandex.return")}
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
