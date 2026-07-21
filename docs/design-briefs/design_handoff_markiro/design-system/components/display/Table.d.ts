/** Таблица офиса: сортировка, пагинация, пустое состояние. Числа и коды — mono-колонки. */
export interface TableColumn {
  key: string;
  title: string;
  width?: number | string;
  align?: "left" | "right" | "center";
  /** Plex Mono + tabular-nums */
  mono?: boolean;
  sortable?: boolean;
  render?: (row: any) => React.ReactNode;
}
export interface TableProps {
  columns: TableColumn[];
  rows: any[];
  sortKey?: string;
  sortDir?: "asc" | "desc";
  onSort?: (key: string) => void;
  page?: number;
  pageCount?: number;
  onPage?: (page: number) => void;
  /** Текст пустого состояния */
  empty?: React.ReactNode;
  style?: React.CSSProperties;
}
