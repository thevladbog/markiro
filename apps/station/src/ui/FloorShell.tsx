import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@markiro/ui";
import type { ServerReachability } from "../lib/api-client.js";
import { StatusBar, type ScannerIndicator, type UpdateIndicatorModel } from "./StatusBar.js";

export interface FloorShellProps {
  stationName: string;
  lineName: string | null;
  operatorName: string;
  shiftLabel: string | null;
  serverReachability: ServerReachability;
  scanner: ScannerIndicator;
  printerConfigured: boolean;
  syncPending: number;
  syncStuck: boolean;
  conflicts: number;
  update?: UpdateIndicatorModel;
  onOpenUpdates?: () => void;
  tasks?: ReadonlyArray<{ id: string; label: string }>;
  activeTaskId?: string;
  onSelectTask?: (id: string) => void;
  footer?: ReactNode;
  windowChrome?: ReactNode;
  children: ReactNode;
}

export function FloorShell({
  stationName,
  lineName,
  operatorName,
  shiftLabel,
  serverReachability,
  scanner,
  printerConfigured,
  syncPending,
  syncStuck,
  conflicts,
  update,
  onOpenUpdates,
  tasks = [],
  activeTaskId,
  onSelectTask,
  footer,
  windowChrome,
  children,
}: FloorShellProps) {
  const { t } = useTranslation();
  return (
    <div className="station-root">
      {windowChrome ? <div className="station-floor-window-chrome">{windowChrome}</div> : null}
      <StatusBar
        stationName={stationName}
        lineName={lineName}
        operatorName={operatorName}
        shiftLabel={shiftLabel}
        serverReachability={serverReachability}
        scanner={scanner}
        printerConfigured={printerConfigured}
        syncPending={syncPending}
        syncStuck={syncStuck}
        conflicts={conflicts}
        {...(update ? { update } : {})}
        {...(onOpenUpdates ? { onOpenUpdates } : {})}
      />
      {tasks.length > 0 ? (
        <nav aria-label={t("shell.tasks")} className="station-task-nav">
          {tasks.map((task) => (
            <Button
              key={task.id}
              type="button"
              size="floor"
              variant="secondary"
              aria-pressed={task.id === activeTaskId}
              onClick={() => onSelectTask?.(task.id)}
            >
              {task.label}
            </Button>
          ))}
        </nav>
      ) : null}
      <div className="station-screen-slot" role="region" aria-label={t("shell.activeScreen")}>
        {children}
      </div>
      {footer}
    </div>
  );
}
