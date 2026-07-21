/** Цифровая клавиатура цеха: вход оператора по PIN. Клавиши 64px — работает в перчатке. */
export interface PinPadProps {
  /** Длина PIN. По умолчанию 4 */
  length?: number;
  /** Вызывается при нажатии OK с полным PIN */
  onSubmit?: (pin: string) => void;
  label?: string;
  style?: React.CSSProperties;
}
