/** Линейный прогресс. */
export interface ProgressBarProps {
  value?: number;
  max?: number;
  kind?: "ok" | "error" | "duplicate" | "syncing" | "neutral";
  mode?: "office" | "floor";
  label?: string;
  /** Показывать «value / max» справа (mono, tabular) */
  showValue?: boolean;
  style?: React.CSSProperties;
}
/** Кольцевой счётчик с процентом в центре. */
export interface RingCounterProps {
  value?: number;
  max?: number;
  /** Диаметр в px */
  size?: number;
  label?: string;
  kind?: "ok" | "error" | "duplicate" | "syncing" | "neutral";
  style?: React.CSSProperties;
}
