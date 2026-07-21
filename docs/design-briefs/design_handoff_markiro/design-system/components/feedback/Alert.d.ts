/** Инлайн-уведомление в потоке страницы. Ошибка всегда заканчивается действием. */
export interface AlertProps {
  kind?: "ok" | "error" | "duplicate" | "syncing" | "neutral";
  title?: string;
  children?: React.ReactNode;
  /** Кнопка действия справа (например «Повторить») */
  action?: React.ReactNode;
  mode?: "office" | "floor";
  style?: React.CSSProperties;
}
/** Тост — временное уведомление в углу (только офис; в цехе — SignalOverlay). */
export interface ToastProps {
  kind?: "ok" | "error" | "duplicate" | "syncing" | "neutral";
  children?: React.ReactNode;
  onClose?: () => void;
  style?: React.CSSProperties;
}
