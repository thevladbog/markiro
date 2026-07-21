/** Полноэкранный сигнал станции линии: виден с 2 метров, боковым зрением. */
export interface SignalOverlayProps {
  /** ok — вспышка ~400мс; error/duplicate — висит до подтверждения; box-complete — итог короба */
  kind?: "ok" | "error" | "duplicate" | "box-complete";
  /** Заголовок; по умолчанию русская подпись статуса */
  title?: string;
  /** Что делать: «Отложите бутылку в брак» */
  detail?: string;
  /** Кнопка подтверждения (обязательна для error/duplicate) */
  action?: React.ReactNode;
  style?: React.CSSProperties;
}
