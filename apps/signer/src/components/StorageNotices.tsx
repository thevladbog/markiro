import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "@markiro/ui";
import type { StorageNotice } from "../lib/bridge.js";
import { storageNoticeKey } from "../lib/storage-notices.js";

/** Where the agent data lives and why, as Rust reported it
 *  (`AgentStatus.storageNotices`). Renders nothing when all is well. */
export function StorageNotices({
  notices,
}: {
  notices: readonly StorageNotice[];
}): ReactElement | null {
  const { t } = useTranslation();
  if (notices.length === 0) return null;
  return (
    <div className="signer-storage-notices">
      {notices.map((notice) => {
        const key = storageNoticeKey(notice);
        return (
          <Alert key={key} tone="warn">
            {t(key)}
          </Alert>
        );
      })}
    </div>
  );
}
