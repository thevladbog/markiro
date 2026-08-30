import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Spinner } from "@markiro/ui";
import { UpdateBanner } from "./components/UpdateBanner.js";
import { bridge, type AgentStatus } from "./lib/bridge.js";
import {
  announceUpdate,
  checkForUpdate,
  UPDATE_CHECK_INTERVAL_MS,
  type SignerUpdate,
} from "./lib/updates.js";
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
  const [update, setUpdate] = useState<SignerUpdate | null>(null);
  const announced = useRef(new Set<string>());

  useEffect(() => {
    // The check is deliberately quiet: `checkForUpdate` resolves to null on
    // failure, so an unreachable mirror costs a console warning and nothing
    // else. The tray announces each version once; the banner is where the
    // operator consents.
    let disposed = false;
    const run = async (): Promise<void> => {
      const found = await checkForUpdate();
      if (disposed || !found) return;
      setUpdate(found);
      await announceUpdate(found, announced.current);
    };
    void run();
    const timer = setInterval(() => void run(), UPDATE_CHECK_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    // `bridge.status()` (the initial snapshot) and `bridge.onStatus` (the
    // live event stream) race: if an event arrives before the initial
    // promise resolves, applying the snapshot afterwards would overwrite a
    // newer status with a stale one. `receivedEvent` makes the snapshot a
    // no-op once any event has landed, on top of the unmount guard `disposed`
    // already provided.
    let disposed = false;
    let receivedEvent = false;
    void bridge.status().then((initial) => {
      if (!disposed && !receivedEvent) setStatus(initial);
    });
    const unlisten = bridge.onStatus((next) => {
      receivedEvent = true;
      setStatus(next);
    });
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, []);

  const view = nextSignerView(status);
  if (view === "loading") return <Spinner label={t("app.loading")} />;
  if (view === "pairing" || !status) {
    // The hostname is resolved in Rust (never `window.location.hostname`,
    // which in a Tauri 2 custom-protocol build is the `tauri.localhost`
    // origin, not the PC name) and travels here through `AgentStatus`.
    return (
      <Pairing
        hostname={status?.hostname ?? ""}
        onPair={(code) => bridge.pair(code)}
        onPaired={() => void bridge.status().then(setStatus)}
      />
    );
  }
  // The banner rides above the ready screen only: the pairing screen is an
  // operator mid-setup, and an update prompt there competes with the one
  // action they came to do.
  return (
    <>
      <UpdateBanner update={update} onInstalled={() => setUpdate(null)} />
      <Status status={status} onChanged={() => void bridge.status().then(setStatus)} />
    </>
  );
}
