/** Переключатель верхнего уровня на станции линии: Сканирование / Агрегация / Смена. */
export interface TaskSwitcherItem {
  id: string;
  label: string;
  icon?: string;
}
export interface TaskSwitcherProps {
  items: TaskSwitcherItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
  style?: React.CSSProperties;
}
