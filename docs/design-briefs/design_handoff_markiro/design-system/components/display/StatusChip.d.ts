/** Статусный чип: цвет + форма-иконка + текст, никогда только цвет. Держит контраст в обеих темах. */
export interface StatusChipProps {
  /** ok | error | duplicate | syncing | offline | neutral */
  kind?: "ok" | "error" | "duplicate" | "syncing" | "offline" | "neutral";
  /** Текст; по умолчанию — русская подпись статуса */
  children?: React.ReactNode;
  mode?: "office" | "floor";
  /** Заливка статусным цветом (для тёмных панелей цеха) */
  solid?: boolean;
  /** Переопределить имя иконки; null — без иконки */
  icon?: string | null;
  style?: React.CSSProperties;
}
