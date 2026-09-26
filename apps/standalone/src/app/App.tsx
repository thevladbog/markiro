import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";

import { createHostApi, type HostApi } from "../host/api.js";
import { createTauriHostClient, HostError } from "../host/client.js";
import {
  createTauriDeviceApi,
  DeviceError,
  type DeviceApi,
  type DeviceErrorCode,
} from "../host/device.js";
import { createTauriHostProbe, HostProbeError, type HostProbe } from "../host/probe.js";
import {
  LOCAL_HOST_ADDRESS,
  type BootstrapRequest,
  type DeviceStatus,
  type OfficeLoginRequest,
} from "../host/protocol.js";
import { Office } from "../office/Office.js";
import { OfficeLogin } from "../office/OfficeLogin.js";
import type { OfficeSessionValue } from "../office/office-session.js";
import { BootstrapWizard } from "../wizard/BootstrapWizard.js";
import {
  ConfigErrorScreen,
  DeviceRejectedScreen,
  FloorScreen,
  HostMissingScreen,
  PairFailedScreen,
  WaitScreen,
} from "./screens.js";
import { initialShellState, nextShellView, shellActionFor, shellReducer } from "./shell.js";

export interface AppProps {
  probe?: HostProbe;
  device?: DeviceApi;
  host?: HostApi;
  address?: string;
}

export function App({ probe, device, host, address = LOCAL_HOST_ADDRESS }: AppProps) {
  const { t } = useTranslation();
  const hostProbe = useMemo(() => probe ?? createTauriHostProbe(), [probe]);
  const deviceApi = useMemo(() => device ?? createTauriDeviceApi(), [device]);
  const hostApi = useMemo(() => host ?? createHostApi(createTauriHostClient()), [host]);
  const [state, dispatch] = useReducer(shellReducer, initialShellState);
  const [probeAttempt, setProbeAttempt] = useState(0);
  const [repairState, setRepairState] = useState<"idle" | "busy" | DeviceErrorCode>("idle");
  const view = nextShellView(state, address);
  const localName = t("device.localName");

  useEffect(() => {
    let cancelled = false;
    deviceApi.status().then(
      (status) => {
        if (!cancelled) dispatch({ type: "device_loaded", status });
      },
      () => {
        if (!cancelled) dispatch({ type: "device_unreadable" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [deviceApi]);

  useEffect(() => {
    let cancelled = false;
    hostProbe.hello(address).then(
      (observation) => {
        if (!cancelled)
          dispatch({ type: "host_probed", localHost: { kind: "found", observation } });
      },
      (error: unknown) => {
        if (!cancelled) {
          dispatch({
            type: "host_probed",
            localHost: {
              kind: "missing",
              reason: error instanceof HostProbeError ? error.code : "unreachable",
            },
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [hostProbe, address, probeAttempt]);

  /** Pair with the host on this computer; a pairing another call already made is adopted. */
  const pairLocally = useCallback(async (): Promise<DeviceStatus> => {
    try {
      return await deviceApi.pairLocally(localName);
    } catch (error) {
      if (error instanceof DeviceError && error.code === "already_paired") {
        const status = await deviceApi.status();
        if (status) return status;
      }
      throw error;
    }
  }, [deviceApi, localName]);

  const pairingDue = view.kind === "pairing" && state.pairing.kind === "idle";
  useEffect(() => {
    if (!pairingDue) return;
    dispatch({ type: "pairing_started" });
    pairLocally().then(
      (status) => dispatch({ type: "paired", status }),
      (error: unknown) =>
        dispatch({
          type: "pairing_failed",
          code: error instanceof DeviceError ? error.code : "unreachable",
        }),
    );
  }, [pairingDue, pairLocally]);

  const retryProbe = useCallback(() => {
    dispatch({ type: "host_probed", localHost: { kind: "probing" } });
    setProbeAttempt((attempt) => attempt + 1);
  }, []);

  const repair = useCallback(() => {
    setRepairState("busy");
    deviceApi.forget().then(
      () => {
        setRepairState("idle");
        dispatch({ type: "forgotten" });
        retryProbe();
      },
      (error: unknown) => {
        // The config could not be removed; this screen stays and offers the
        // same action again, now explaining why it did not work.
        setRepairState(error instanceof DeviceError ? error.code : "unreachable");
      },
    );
  }, [deviceApi, retryProbe]);

  const unpaired = state.device.kind === "ready" && state.device.status === null;
  const bootstrap = useCallback(
    async (request: BootstrapRequest) => {
      if (unpaired) dispatch({ type: "paired", status: await pairLocally() });
      try {
        const response = await hostApi.bootstrap(request);
        dispatch({ type: "host_initialized" });
        dispatch({ type: "office_opened", session: response.session });
      } catch (error) {
        if (error instanceof HostError && error.code === "already_initialized") {
          dispatch({ type: "host_initialized" });
          dispatch({ type: "office_requested" });
          return;
        }
        // No session exists yet during the wizard, so any rejection applies
        // unconditionally (`shellActionFor(error, null)`).
        const action = shellActionFor(error, null);
        if (action?.type === "device_rejected") {
          dispatch(action);
          return;
        }
        throw error;
      }
    },
    [unpaired, pairLocally, hostApi],
  );

  const login = useCallback(
    async (request: OfficeLoginRequest) => {
      try {
        dispatch({ type: "office_opened", session: await hostApi.officeLogin(request) });
      } catch (error) {
        // No session exists yet during sign-in either.
        const action = shellActionFor(error, null);
        if (action?.type === "device_rejected") {
          dispatch(action);
          return;
        }
        throw error;
      }
    },
    [hostApi],
  );

  const session = view.kind === "office" ? view.session : null;
  const officeSession = useMemo<OfficeSessionValue | null>(() => {
    if (!session) return null;
    const call = async <T,>(operation: (token: string) => Promise<T>): Promise<T> => {
      try {
        return await operation(session.token);
      } catch (error) {
        // Scoped to this session's token: a late failure from a session the
        // user already left or replaced must not pull them back into
        // sign-in or mark a fresh pairing rejected.
        const action = shellActionFor(error, session.token);
        if (action) dispatch(action);
        throw error;
      }
    };
    return {
      user: session.user,
      call,
      changePassword: (request) => call((token) => hostApi.officeChangePassword(token, request)),
      leave: () => dispatch({ type: "office_left" }),
      logout: async () => {
        try {
          await hostApi.officeLogout(session.token);
        } catch {
          // The session ends on this device regardless; the host expires it on its own.
        }
        dispatch({ type: "logged_out" });
      },
    };
  }, [session, hostApi]);

  if (officeSession) return <Office session={officeSession} />;

  const repairBusy = repairState === "busy";
  const repairError = repairState === "idle" || repairState === "busy" ? null : repairState;

  return (
    <main className="standalone-screen">
      {view.kind === "loading" && <WaitScreen messageKey="shell.loading" />}
      {view.kind === "config_error" && (
        <ConfigErrorScreen busy={repairBusy} error={repairError} onReset={repair} />
      )}
      {view.kind === "host_missing" && (
        <HostMissingScreen reason={view.reason} address={address} onRetry={retryProbe} />
      )}
      {view.kind === "bootstrap" && <BootstrapWizard onSubmit={bootstrap} />}
      {view.kind === "pairing" && <WaitScreen messageKey="shell.pairing.title" />}
      {view.kind === "pair_failed" && (
        <PairFailedScreen
          code={view.code}
          onRetry={() => {
            // A stale probe snapshot can carry the wrong host identity (e.g.
            // after a host swap): re-probe as well, not just the pairing.
            dispatch({ type: "pairing_retried" });
            retryProbe();
          }}
        />
      )}
      {view.kind === "device_rejected" && (
        <DeviceRejectedScreen
          reason={view.reason}
          busy={repairBusy}
          error={repairError}
          onRepair={repair}
        />
      )}
      {view.kind === "floor" && (
        <FloorScreen onOffice={() => dispatch({ type: "office_requested" })} />
      )}
      {view.kind === "office_login" && (
        <OfficeLogin
          notice={view.notice}
          onLogin={login}
          onBack={() => dispatch({ type: "office_left" })}
        />
      )}
    </main>
  );
}
