import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlatformCapability } from "@markiro/platform-contracts";
import { Alert, Button, Card } from "@markiro/ui";
import { getTenantEntitlements } from "./api.js";
import { EntitlementSnapshotView } from "./EntitlementSnapshotView.js";
import { EntitlementSourceForm } from "./EntitlementSourceForm.js";

export function EntitlementsPanel({
  tenantId,
  capabilities,
}: {
  tenantId: string;
  capabilities: readonly PlatformCapability[];
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["platform", "tenants", tenantId, "entitlements"],
    queryFn: () => getTenantEntitlements(tenantId),
  });
  const [intent, setIntent] = useState<
    { intent: "prepare" } | { intent: "revoke"; sourceId: string } | null
  >(null);
  const [locked, setLocked] = useState(false);
  const canWrite = capabilities.includes("tenants.write") && capabilities.includes("billing.write");
  return (
    <>
      {query.isPending ? (
        <p role="status">{t("auth.boundary.loading")}</p>
      ) : !query.data ? (
        <Alert tone="error">
          {t("entitlements.loadError")}
          <Button onClick={() => void query.refetch()}>{t("entitlements.retry")}</Button>
        </Alert>
      ) : (
        <>
          {query.isError ? (
            <Alert tone="error">
              {t("entitlements.loadError")}
              <Button onClick={() => void query.refetch()}>{t("entitlements.retry")}</Button>
            </Alert>
          ) : null}
          <EntitlementSnapshotView snapshot={query.data.snapshot} />
          {canWrite ? (
            <Card>
              <Button disabled={locked} onClick={() => setIntent({ intent: "prepare" })}>
                {t("entitlements.prepare")}
              </Button>
              {query.data.snapshot.sources
                .filter((source) => source.prepared)
                .map((source) => (
                  <p key={source.id}>
                    <Button
                      disabled={locked}
                      variant="secondary"
                      onClick={() => setIntent({ intent: "revoke", sourceId: source.id })}
                    >
                      {t("entitlements.revoke")}: {t(`entitlements.kinds.${source.kind}`)} ·{" "}
                      {source.id.slice(0, 8)}
                    </Button>
                  </p>
                ))}
              {intent ? (
                <EntitlementSourceForm
                  key={intent.intent === "prepare" ? "prepare" : intent.sourceId}
                  tenantId={tenantId}
                  intent={intent}
                  onClose={() => setIntent(null)}
                  onLockChange={setLocked}
                  onRefresh={async () => {
                    const result = await query.refetch();
                    if (result.isError) throw result.error;
                  }}
                />
              ) : null}
            </Card>
          ) : null}
        </>
      )}
    </>
  );
}
