import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  DeviceRetentionView,
  emptyDeviceRetentionAttempt,
  type DeviceRetentionAttempt,
} from "@markiro/ui/entitlements";
import { useReplacementCache } from "./replacement-state.js";
import { EntitlementSnapshotView } from "../billing/EntitlementSnapshotView.js";
import {
  inspectDeviceRetention,
  previewDeviceRetention,
  confirmDeviceRetention,
  retentionErrorKind,
} from "./device-retention-api.js";
export const retentionKeys = {
  inspect: (tenantId: string) => ["device-retention", tenantId] as const,
  attempt: (tenantId: string) => ["device-retention-attempt", tenantId] as const,
};
export function DeviceRetentionPanel({
  tenantId,
  canWrite,
}: {
  tenantId: string;
  canWrite: boolean;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const inspection = useQuery({
    queryKey: retentionKeys.inspect(tenantId),
    queryFn: () => inspectDeviceRetention(tenantId),
  });
  const key = retentionKeys.attempt(tenantId);
  const [attempt, setAttempt] = useReplacementCache<DeviceRetentionAttempt>(
    key,
    emptyDeviceRetentionAttempt,
  );
  return (
    <DeviceRetentionView
      canWrite={canWrite}
      inspection={inspection}
      attempt={attempt}
      getAttempt={() => qc.getQueryData<DeviceRetentionAttempt>(key) ?? attempt}
      setAttempt={setAttempt}
      preview={(request) => previewDeviceRetention(tenantId, request)}
      confirm={(request, expected) => confirmDeviceRetention(tenantId, request, expected)}
      refresh={() =>
        Promise.allSettled([
          qc.invalidateQueries({ queryKey: retentionKeys.inspect(tenantId) }),
          qc.invalidateQueries({ queryKey: ["device-replacements", tenantId] }),
          qc.invalidateQueries({ queryKey: ["cabinet-access"] }),
        ])
      }
      classifyError={retentionErrorKind}
      createRequestId={() => crypto.randomUUID()}
      translate={(key, options) => t(key, options ?? {})}
      language={i18n.language}
      renderSnapshot={(snapshot) => <EntitlementSnapshotView snapshot={snapshot} />}
    />
  );
}
