/** Кнопка Маркиро. Офис: 40px (sm 32px). Цех: 64px, на всю ширину — нажимается в перчатке. */
export interface ButtonProps {
  /** primary — главное действие экрана (одно); secondary — обычное; destructive — необратимое; ghost — третьестепенное */
  variant?: "primary" | "secondary" | "destructive" | "ghost";
  /** office (по умолчанию) | floor — цеховой размер 64px+, full-width, без hover-состояний */
  mode?: "office" | "floor";
  size?: "sm" | "md" | "floor";
  fullWidth?: boolean;
  disabled?: boolean;
  /** Показывает спиннер и блокирует onClick */
  loading?: boolean;
  /** Иконка слева, обычно <Icon /> */
  icon?: React.ReactNode;
  children?: React.ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  style?: React.CSSProperties;
}
