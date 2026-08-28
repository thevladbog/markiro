import { useCallback, useEffect, useRef, useState } from "react";
import type { InventoryProgressPage } from "@markiro/domain";

import type { CredentialGeneration } from "./credential-recovery.js";
import {
  createInventorySyncEngine,
  type InventorySyncEngine,
  type InventorySyncState,
} from "./inventory-sync.js";
import type { SqlExecutor } from "./mirror.js";

const HEARTBEAT_MS = 15_000;

export interface UseInventorySyncEngineDeps {
  exec: SqlExecutor;
  client: {
    get(path: string): Promise<unknown>;
    post(path: string, body?: unknown): Promise<unknown>;
  } | null;
  inventoryId: string;
  snapshotId: string;
  floorTaskPointerValue?: string;
  active: boolean;
  credentialGeneration?: CredentialGeneration;
  onProgressApplied?: (page: InventoryProgressPage) => void | Promise<void>;
}

export interface UseInventorySyncEngineResult {
  state: InventorySyncState;
  nudge: () => void;
  idle: () => Promise<void>;
  stop: () => void;
  resume: () => void;
}

export function useInventorySyncEngine(
  deps: UseInventorySyncEngineDeps,
): UseInventorySyncEngineResult {
  const {
    exec,
    client,
    inventoryId,
    snapshotId,
    floorTaskPointerValue,
    active,
    credentialGeneration,
    onProgressApplied,
  } = deps;
  const [state, setState] = useState<InventorySyncState>({
    pending: 0,
    draining: false,
    lastSuccessAt: null,
    lastError: null,
  });
  const engineRef = useRef<InventorySyncEngine | null>(null);

  useEffect(() => {
    if (!client) {
      engineRef.current = null;
      return;
    }
    const engine = createInventorySyncEngine({
      exec,
      client,
      inventoryId,
      snapshotId,
      ...(floorTaskPointerValue ? { floorTaskPointerValue } : {}),
      onState: setState,
      ...(onProgressApplied ? { onProgressApplied } : {}),
      ...(credentialGeneration ? { credentialGeneration } : {}),
    });
    engineRef.current = engine;
    engine.nudge();
    if (active) {
      void engine.pollProgress().catch(() => undefined);
    }
    const heartbeat = setInterval(() => {
      engine.nudge();
      if (active) void engine.pollProgress().catch(() => undefined);
    }, HEARTBEAT_MS);
    return () => {
      clearInterval(heartbeat);
      engine.stop();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [
    exec,
    client,
    inventoryId,
    snapshotId,
    floorTaskPointerValue,
    active,
    credentialGeneration,
    onProgressApplied,
  ]);

  const nudge = useCallback(() => engineRef.current?.nudge(), []);
  const idle = useCallback(() => engineRef.current?.idle() ?? Promise.resolve(), []);
  const stop = useCallback(() => engineRef.current?.stop(), []);
  const resume = useCallback(() => engineRef.current?.resume(), []);
  return { state, nudge, idle, stop, resume };
}
