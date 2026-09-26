import { useCallback, useEffect, useState } from "react";

import {
  HostProbeError,
  type HelloObservation,
  type HostProbe,
  type HostProbeErrorCode,
} from "../host/probe.js";

export type LocalHostState =
  | { kind: "probing" }
  | { kind: "missing"; reason: HostProbeErrorCode }
  | { kind: "found"; observation: HelloObservation };

/** Probes `address` once per attempt; `retry` starts a new attempt. */
export function useLocalHost(probe: HostProbe, address: string) {
  const [state, setState] = useState<LocalHostState>({ kind: "probing" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    probe.hello(address).then(
      (observation) => {
        if (!cancelled) setState({ kind: "found", observation });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            kind: "missing",
            reason: error instanceof HostProbeError ? error.code : "unreachable",
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [probe, address, attempt]);

  const retry = useCallback(() => {
    setState({ kind: "probing" });
    setAttempt((value) => value + 1);
  }, []);

  return { state, retry };
}
