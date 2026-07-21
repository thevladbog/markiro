/** Карточка-контейнер: белая поверхность, граница 1px, лёгкая тень. */
export interface CardProps {
  title?: string;
  /** Кнопки/иконки в правом углу шапки */
  actions?: React.ReactNode;
  children?: React.ReactNode;
  /** Переопределить внутренний отступ (число px или CSS-строка) */
  padding?: number | string;
  mode?: "office" | "floor";
  style?: React.CSSProperties;
}
