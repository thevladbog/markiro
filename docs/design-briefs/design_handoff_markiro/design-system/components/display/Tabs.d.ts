/** Вкладки с нижним подчёркиванием. */
export interface TabsProps {
  /** Строки или {value, label} */
  items: Array<string | { value: string; label: string }>;
  value?: string;
  onChange?: (value: string) => void;
  mode?: "office" | "floor";
  style?: React.CSSProperties;
}
