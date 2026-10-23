import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, Checkbox, Input } from "@markiro/ui";
import { yandexNative } from "../../host/yandex-native.js";
import { useOfficeSession } from "../office-session.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { useCan } from "../access.js";
import { useBackupTime } from "./backup-time.js";
export function YandexBackupCard() {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const admin = useCan("manageBackups");
  const time = useBackupTime();
  const query = useOfficeQuery(
    officeKeys.yandexBackups,
    (api, token) => api.getYandexBackups(token),
    { refetchInterval: 5000 },
  );
  const [clientId, setClientId] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const data = query.data;
  const chosen = clientId.trim() || data?.clientId || "";
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await query.refetch();
    } catch (e) {
      setError(typeof e === "string" ? e : "network");
    } finally {
      setBusy(false);
    }
  };
  const stale =
    data?.lastConfirmedCopyCreatedAt != null &&
    Date.now() - Date.parse(data.lastConfirmedCopyCreatedAt) > 26 * 3600000;
  return (
    <Card title={t("yandex.title")} titleAs="h2">
      <div className="standalone-form">
        <p>{t("yandex.direct")}</p>
        {data?.accountLabel && (
          <p>
            {data.accountLabel} · ClientID: {data.clientId}
          </p>
        )}
        {query.isError && <Alert tone="warn">{t("yandex.loadFailed")}</Alert>}
        {data && (
          <p>
            {t(`yandex.connection.${data.state}`)} · {t(`yandex.delivery.${data.deliveryState}`)}
          </p>
        )}
        {data?.lastConfirmedAt && (
          <p>
            {t("yandex.uploadedAt")}: {time.format(data.lastConfirmedAt)}
          </p>
        )}
        {data?.lastConfirmedCopyCreatedAt ? (
          <p>
            {t("yandex.copyAt")}: {time.format(data.lastConfirmedCopyCreatedAt)}
          </p>
        ) : (
          data?.state === "connected" && <Alert tone="warn">{t("yandex.noConfirmed")}</Alert>
        )}
        {stale && <Alert tone="warn">{t("yandex.stale")}</Alert>}
        {(error || data?.errorCode) && (
          <Alert tone="warn">
            {t(`yandex.errors.${error || data?.errorCode}`, {
              defaultValue: t("yandex.errors.network"),
            })}
          </Alert>
        )}
        {data?.nextAttemptAt && (
          <p>
            {t("yandex.nextAttempt")}: {time.format(data.nextAttemptAt)}
          </p>
        )}
        {admin ? (
          <>
            <p>{t("yandex.instructions")}</p>
            <Button variant="secondary" onClick={() => void act(yandexNative.registration)}>
              {t("yandex.register")}
            </Button>
            <Input
              label="ClientID"
              value={clientId}
              placeholder={data?.clientId ?? ""}
              onChange={(e) => setClientId(e.target.value)}
              disabled={busy}
            />
            <p className="office-note">{t("yandex.restoreClientId")}</p>
            <Checkbox checked={consent} onCheckedChange={setConsent} label={t("yandex.consent")} />
            <div className="standalone-form__actions">
              <Button
                disabled={busy || !consent || !/^[A-Za-z0-9_-]{1,128}$/u.test(chosen)}
                onClick={() =>
                  void act(() => session.call((token) => yandexNative.connect(chosen, token)))
                }
              >
                {t("yandex.connect")}
              </Button>
              {busy && (
                <Button variant="secondary" onClick={() => void yandexNative.cancel()}>
                  {t("yandex.cancel")}
                </Button>
              )}
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    setClientId((await yandexNative.importProfile()).clientId);
                  })
                }
              >
                {t("yandex.import")}
              </Button>
              <Button
                variant="secondary"
                disabled={busy || !chosen}
                onClick={() =>
                  void act(async () => {
                    setSaved(await yandexNative.exportProfile(chosen));
                  })
                }
              >
                {t("yandex.export")}
              </Button>
              {data?.connectionGeneration && data.state !== "disconnected" && (
                <>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        session.call((token) =>
                          session.api.retryYandexBackup(token, data.connectionGeneration ?? ""),
                        ),
                      )
                    }
                  >
                    {t("yandex.retry")}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy || !consent}
                    onClick={() =>
                      void act(() =>
                        session.call((token) =>
                          session.api.disconnectYandex(token, data.connectionGeneration ?? ""),
                        ),
                      )
                    }
                  >
                    {t("yandex.disconnect")}
                  </Button>
                </>
              )}
            </div>
            <p className="office-note">{t("yandex.disconnectHint")}</p>
            {saved && (
              <p>
                {t("yandex.profileSaved")}: {saved}
              </p>
            )}
          </>
        ) : (
          <p className="office-note">{t("yandex.adminOnly")}</p>
        )}
      </div>
    </Card>
  );
}
