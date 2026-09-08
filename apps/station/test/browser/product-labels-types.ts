export interface ProductLabelBrowserHarness {
  scan(raw?: string): void;
  ready(): boolean;
  setTransport(mode: "sent" | "unknown" | "hold"): void;
  inspect(): Promise<{
    accepted: number;
    prints: number;
    status: string | null;
    attempts: number;
    bytes: string[];
    events: string[];
  }>;
}
declare global {
  interface Window {
    __productLabels: ProductLabelBrowserHarness;
  }
}
