export interface ContractDiagnostic {
  endpoint: string;
  issuePath: Array<string | number>;
  releaseSha: string | null;
  requestId: string | null;
}

let latest: ContractDiagnostic | null = null;

export function recordContractDiagnostic(diagnostic: ContractDiagnostic): void {
  latest = {
    endpoint: diagnostic.endpoint.slice(0, 512),
    issuePath: diagnostic.issuePath
      .slice(0, 16)
      .map((segment) => (typeof segment === "number" ? segment : segment.slice(0, 128))),
    releaseSha: diagnostic.releaseSha?.slice(0, 128) ?? null,
    requestId: diagnostic.requestId,
  };
}

export function latestContractDiagnostic(): ContractDiagnostic | null {
  return latest
    ? {
        endpoint: latest.endpoint,
        issuePath: [...latest.issuePath],
        releaseSha: latest.releaseSha,
        requestId: latest.requestId,
      }
    : null;
}
