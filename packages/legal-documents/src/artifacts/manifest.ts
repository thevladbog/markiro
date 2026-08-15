import { artifactFileName, type LegalArtifactRequest } from "./names.js";

export interface LegalArtifactDescriptor extends LegalArtifactRequest {
  readonly fileName: string;
}

export function describeLegalArtifact(input: LegalArtifactRequest): LegalArtifactDescriptor {
  return { ...input, fileName: artifactFileName(input) };
}
