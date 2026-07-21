/** Иконка Маркиро: сетка 24, штрих 2px, прямые углы. В цехе минимум 32px и всегда с подписью. */
export interface IconProps {
  /** Имя иконки из набора ICONS (check, close, scan, box, pallet, printer, sync, offline, duplicate, ...) */
  name: string;
  /** Размер в px. Офис: 16–24, цех: 32+. По умолчанию 24 */
  size?: number;
  /** Цвет штриха. По умолчанию currentColor */
  color?: string;
  /** Толщина штриха при 24px. По умолчанию 2 */
  strokeWidth?: number;
  /** Доступная подпись (aria-label) */
  title?: string;
  style?: React.CSSProperties;
}
