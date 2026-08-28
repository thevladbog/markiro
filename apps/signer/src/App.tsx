import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Spinner } from "@markiro/ui";
import { bridge, type AgentStatus } from "./lib/bridge.js";
import { Pairing } from "./pages/Pairing.js";
import { Status } from "./pages/Status.js";

export type SignerView = "loading" | "pairing" | "ready";

/** Three states, no router: the agent is either still reading its config, not
 *  paired yet, or running. Degraded is a badge on the ready screen, not a
 *  separate view — the operator still needs the journal and the unpair button. */
export function nextSignerView(status: AgentStatus | null): SignerView {
  if (!status) return "loading";
  return status.phase === "unpaired" ? "pairing" : "ready";
}

export function App(): ReactElement {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [hostname] = useState(() => window.location.hostname || "windows-pc");

  useEffect(() => {
    let disposed = false;
    void bridge.status().then((initial) => {
      if (!disposed) setStatus(initial);
    });
    const unlisten = bridge.onStatus((next) => setStatus(next));
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, []);

  const view = nextSignerView(status);
  if (view === "loading") return <Spinner label={t("app.loading")} />;
  if (view === "pairing" || !status) {
    return (
      <Pairing
        hostname={hostname}
        onPair={(code) => bridge.pair(code, hostname)}
        onPaired={() => void bridge.status().then(setStatus)}
      />
    );
  }
  return <Status status={status} onChanged={() => void bridge.status().then(setStatus)} />;
}
