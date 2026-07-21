/** Пустое / ошибочное / офлайн состояние поверхности: иконка, заголовок, действие. */
export interface EmptyStateProps {
  /** Имя иконки из набора Icon */
  icon?: string;
  title: string;
  children?: React.ReactNode;
  /** Кнопка действия («Создать задание») */
  action?: React.ReactNode;
  mode?: "office" | "floor";
  style?: React.CSSProperties;
}
/** Скелетон загрузки. */
export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  style?: React.CSSProperties;
}
