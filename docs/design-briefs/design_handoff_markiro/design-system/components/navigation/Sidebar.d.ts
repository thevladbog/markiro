/** Боковая навигация админ-панели (офис) с логотипом сверху. */
export interface SidebarItem {
  id: string;
  label: string;
  /** Имя иконки из набора Icon */
  icon?: string;
  /** Счётчик справа */
  badge?: number | string;
}
export interface SidebarProps {
  items: SidebarItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
  /** Низ сайдбара: профиль, выход */
  footer?: React.ReactNode;
  collapsed?: boolean;
  style?: React.CSSProperties;
}
