import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Spinner } from "@markiro/ui";

import { createTauriHostProbe, type HostProbe } from "../host/probe.js";
import { LOCAL_HOST_ADDRESS } from "../host/protocol.js";
import { formatFingerprint } from "./fingerprint.js";
import { useLocalHost } from "./use-local-host.js";

export interface AppProps {
  probe?: HostProbe;
  address?: string;
}

const REASON_KEY = {
  unreachable: "shell.hostMissing.unreachable",
  not_markiro_host: "shell.hostMissing.notHost",
  invalid_response: "shell.hostMissing.invalidResponse",
  host_too_old: "shell.version.hostTooOld",
  app_too_old: "shell.version.appTooOld",
} as const;

export function App({ probe, address = LOCAL_HOST_ADDRESS }: AppProps) {
  const { t } = useTranslation();
  const hostProbe = useMemo(() => probe ?? createTauriHostProbe(), [probe]);
  const { state, retry } = useLocalHost(hostProbe, address);

  return (
    <main className="standalone-screen">
      {state.kind === "probing" && (
        <div className="standalone-probing" role="status">
          <Spinner size={32} />
          <p>{t("shell.probing")}</p>
        </div>
      )}
      {state.kind === "missing" &&
        (() => {
          const versionMismatch = state.reason === "host_too_old" || state.reason === "app_too_old";
          return (
            <Card
              className="standalone-card"
              title={t(versionMismatch ? "shell.version.title" : "shell.hostMissing.title")}
              titleAs="h2"
            >
              {!versionMismatch && <p>{t("shell.hostMissing.body", { address })}</p>}
              <Alert tone="warn">{t(REASON_KEY[state.reason])}</Alert>
              <Button onClick={retry}>{t("shell.hostMissing.retry")}</Button>
            </Card>
          );
        })()}
      {state.kind === "found" && (
        <Card className="standalone-card" title={t("shell.hostFound.title")} titleAs="h2">
          <p>{t("shell.hostFound.version", { version: state.observation.hello.version })}</p>
          <p className="standalone-fingerprint-label">{t("shell.hostFound.fingerprint")}</p>
          <p className="standalone-fingerprint" data-testid="host-fingerprint">
            {formatFingerprint(state.observation.fingerprint)}
          </p>
          <Alert tone="info">
            {t(
              state.observation.hello.initialized
                ? "shell.hostFound.initialized"
                : "shell.hostFound.uninitialized",
            )}
          </Alert>
        </Card>
      )}
    </main>
  );
}
