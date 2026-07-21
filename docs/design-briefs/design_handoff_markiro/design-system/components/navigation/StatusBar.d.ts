/** Статус-бар станции: связь, синхронизация, оборудование, оператор, часы. */
export interface StatusBarDevice {
  name: string;
  ok: boolean;
  /** printer | scan | camera | agent */
  icon?: string;
}
export interface StatusBarProps {
  online?: boolean;
  syncing?: boolean;
  /** Кодов в очереди на отправку (офлайн-буфер) */
  queued?: number;
  devices?: StatusBarDevice[];
  operator?: string;
  shiftLabel?: string;
  /** Строка времени, например "14:32" */
  clock?: string;
  style?: React.CSSProperties;
}
