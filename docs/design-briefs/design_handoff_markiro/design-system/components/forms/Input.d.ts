/** Поле ввода. type="date" — офисный датапикер; mono — для кодов и номеров партий. */
export interface InputProps {
  label?: string;
  /** Подсказка под полем */
  hint?: string;
  /** Текст ошибки: красная рамка + сообщение. Ошибка всегда заканчивается действием */
  error?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (e: any) => void;
  placeholder?: string;
  /** text | number | date | password ... */
  type?: string;
  mode?: "office" | "floor";
  /** Plex Mono + tabular-nums — коды, GTIN, количества */
  mono?: boolean;
  disabled?: boolean;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  style?: React.CSSProperties;
  id?: string;
}
