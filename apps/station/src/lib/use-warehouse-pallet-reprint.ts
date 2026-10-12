import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createWarehousePalletWork } from "./warehouse-reprint/pallet-work.js";
import type { WarehouseWorkOptions } from "./warehouse-reprint/work.js";
import type { FloorWorkBarrier } from "./credential-recovery.js";
export function useWarehousePalletReprint(
  options: WarehouseWorkOptions,
  register?: (barrier: FloorWorkBarrier) => () => void,
) {
  const latest = useRef(options);
  latest.current = options;
  const { exec, generation, deviceId, operatorId } = options;
  const work = useMemo(
    () =>
      createWarehousePalletWork({
        exec,
        generation,
        deviceId,
        operatorId,
        client: {
          get: (path, requestOptions) => latest.current.client.get(path, requestOptions),
          post: (path, body) => latest.current.client.post(path, body),
          download: (path) => latest.current.client.download(path),
          whoami: (signal) => latest.current.client.whoami(signal),
        },
        hardware: () => latest.current.hardware(),
        print: (target, bytes) => latest.current.print(target, bytes),
        onJournalChange: () => latest.current.onJournalChange?.(),
      }),
    [exec, generation, deviceId, operatorId],
  );
  const state = useSyncExternalStore(work.subscribe, work.getSnapshot, work.getSnapshot);
  useEffect(() => {
    const unregister = register?.(work);
    work.open();
    void work.initialize();
    const timer = setInterval(() => {
      void work.poll().catch(() => undefined);
    }, 5000);
    return () => {
      clearInterval(timer);
      void work.close().finally(() => unregister?.());
    };
  }, [work, register]);
  return { work, state };
}
