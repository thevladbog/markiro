import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type AgentPhase = "unpaired" | "idle" | "working" | "degraded";

/** Mirrors `signer_core::runtime::AgentStatus`. */
export interface AgentStatus {
  phase: AgentPhase;
  tenantName: string | null;
  certThumbprint: string | null;
  lastTokenExpiresAt: string | null;
  lastError: string | null;
  journal: { message: string; detail: string | null }[];
}

/** Mirrors `signer_core::signer::CertificateSummary`. */
export interface CertificateSummary {
  thumbprint: string;
  subject: string;
  inn: string | null;
  notAfter: string;
  hasPrivateKey: boolean;
}

export type PairOutcome =
  | { ok: true; tenantName: string }
  | { ok: false; error: "rejected" | "unavailable" };

export const bridge = {
  status: () => invoke<AgentStatus>("signer_status"),
  async pair(code: string, hostname: string): Promise<PairOutcome> {
    try {
      const tenantName = await invoke<string>("signer_pair", { code, hostname });
      return { ok: true, tenantName };
    } catch (error) {
      return { ok: false, error: error === "rejected" ? "rejected" : "unavailable" };
    }
  },
  unpair: () => invoke<void>("signer_unpair"),
  listCertificates: () => invoke<CertificateSummary[]>("signer_list_certificates"),
  selectCertificate: (thumbprint: string) =>
    invoke<void>("signer_select_certificate", { thumbprint }),
  setServerUrl: (url: string) => invoke<void>("signer_set_server_url", { url }),
  onStatus: (listener: (status: AgentStatus) => void) =>
    listen<AgentStatus>("signer://status", (event) => listener(event.payload)),
};
