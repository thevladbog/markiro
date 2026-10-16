import { codeDisplay, SERIAL_FULL } from "./scan-history.js";

export interface ScanCodeProps {
  gtin14: string | null;
  serial: string | null;
  /** `compact`: the serial's head is cut to fit a line; `full`: the whole serial. */
  size?: "compact" | "full";
  /** What stands when no serial can be read (the old masked line, or the «not a code» words). */
  fallback: string;
}

/**
 * A scan's code on a line: the serial (GS1 AI 21) as the main part in monospace, the GTIN short
 * and small beside or under it. The title carries the whole GTIN and serial; without a serial
 * the fallback is the old line.
 */
export function ScanCode({ gtin14, serial, size = "compact", fallback }: ScanCodeProps) {
  const display = codeDisplay(gtin14, serial, size === "full" ? SERIAL_FULL : undefined);
  if (display === null) return <span className="scan-code scan-code--fallback">{fallback}</span>;
  return (
    <span className="scan-code" title={display.full}>
      <span className="scan-code__serial">{display.serial}</span>
      {display.gtin !== "" && <span className="scan-code__gtin">{`GTIN ${display.gtin}`}</span>}
    </span>
  );
}
