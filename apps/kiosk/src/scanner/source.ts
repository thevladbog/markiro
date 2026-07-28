export type ScanListener = (raw: string) => void;

/**
 * The subset of `Window`'s event-target surface the keyboard wedge needs.
 * Narrowing to this lets tests drive the source with a plain fake instead of
 * a real DOM window.
 */
export type KeyTarget = Pick<Window, "addEventListener" | "removeEventListener">;

/**
 * A source of raw scan payloads. Screens consume this seam and never need to
 * know whether the bytes came from a HID keyboard wedge or a Web Serial
 * port — see `keyboard.ts` and `web-serial.ts`.
 */
export interface ScanSource {
  /** Whether this transport can run here at all (e.g. `navigator.serial` exists). */
  isAvailable(): boolean;
  /** Begins delivering scans; returns the function that stops it. */
  start(listener: ScanListener): () => void;
}
