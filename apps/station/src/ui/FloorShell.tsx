import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StatusBar } from "./StatusBar.js";

export interface FloorShellProps {
  online: boolean;
  tasks: Array<{ id: string; label: string }>;
  activeTaskId: string;
  onSelectTask: (id: string) => void;
  children: ReactNode;
}

export function FloorShell({ online, tasks, activeTaskId, onSelectTask, children }: FloorShellProps) {
  const { t } = useTranslation();
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <StatusBar online={online} />
      <nav aria-label={t("shell.tasks")} style={{ display: "flex", gap: 8, padding: "8px 16px" }}>
        {tasks.map((task) => (
          <button
            key={task.id}
            type="button"
            aria-pressed={task.id === activeTaskId}
            style={{ minHeight: 64, minWidth: 120, fontSize: "1.1rem" }}
            onClick={() => onSelectTask(task.id)}
          >
            {task.label}
          </button>
        ))}
      </nav>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
