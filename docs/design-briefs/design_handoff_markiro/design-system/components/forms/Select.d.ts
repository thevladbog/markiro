/** Выпадающий список (нативный select со стилями системы). */
export interface SelectProps {
  label?: string;
  /** Строки или {value, label} */
  options: Array<string | { value: string; label: string }>;
  value?: string;
  onChange?: (value: string) => void;
  mode?: "office" | "floor";
  disabled?: boolean;
  hint?: string;
  error?: string;
  style?: React.CSSProperties;
}
