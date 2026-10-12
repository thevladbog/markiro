import { Button } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import type { UsRequestArtifact } from "./types.js";
import { getRequestCopy } from "./copy.js";

export type RequestDownloadButtonProps = {
  artifact: UsRequestArtifact;
  disabled: boolean;
  active: boolean;
  onDownload: () => void;
};
export const requestArtifactKinds = [
  "xlsx",
  "plan_pdf",
  "validation_report",
  "request_report",
  "manifest",
  "package_zip",
] as const;
export function RequestDownloadButton({
  artifact,
  disabled,
  active,
  onDownload,
}: RequestDownloadButtonProps) {
  const { i18n } = useTranslation();
  const copy = getRequestCopy(i18n.language);
  return (
    <div>
      <Button disabled={disabled || active} onClick={onDownload}>
        {copy.download} {copy[artifact.kind]}
      </Button>
      {active ? <p role="status">{copy.downloading}</p> : null}
      <p>
        {copy.bytes}: {artifact.byteSize}; SHA-256:{" "}
        <span className="font-mono">{artifact.sha256}</span>
      </p>
    </div>
  );
}
