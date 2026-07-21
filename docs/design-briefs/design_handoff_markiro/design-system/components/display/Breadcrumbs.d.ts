/** Хлебные крошки админ-панели (офис). */
export interface BreadcrumbsProps {
  /** Строки или {label, onClick} */
  items: Array<string | { label: string; onClick?: () => void }>;
  style?: React.CSSProperties;
}
