/**
 * Фирменный «короб»: сетка ячеек, заполняющаяся при сканировании (14/20).
 * @startingPoint section="Компоненты" subtitle="Сетка короба 14/20" viewport="700x260"
 */
export interface BoxFillProps {
  /** Отсканировано единиц */
  filled?: number;
  /** Вместимость короба */
  total?: number;
  /** Колонок в сетке; по умолчанию вычисляется */
  columns?: number;
  /** Размер ячейки px (цех: 32–40) */
  cellSize?: number;
  kind?: "ok" | "error" | "duplicate" | "syncing" | "neutral";
  /** Крупный счётчик под сеткой */
  showCount?: boolean;
  mode?: "office" | "floor";
  style?: React.CSSProperties;
}
