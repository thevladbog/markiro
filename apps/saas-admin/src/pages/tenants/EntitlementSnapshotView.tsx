import type { EntitlementSnapshotV1, EntitlementSource } from "@markiro/platform-contracts";
import {
  EntitlementSnapshotView as SafeEntitlementSnapshotView,
  SourceEffects as SafeSourceEffects,
} from "@markiro/ui/entitlements";
import { useTranslation } from "react-i18next";

export function EntitlementSnapshotView({ snapshot }: { snapshot: EntitlementSnapshotV1 }) {
  const { t, i18n } = useTranslation();
  return (
    <SafeEntitlementSnapshotView
      snapshot={snapshot}
      translate={(key, options) => t(key, options ?? {})}
      formatDate={(value) =>
        value
          ? new Intl.DateTimeFormat(i18n.language, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(value))
          : t("entitlements.noEnd")
      }
      classNames={{
        quotaGrid: "usage-grid",
        quotaItem: "usage-item",
        facts: "tenant-facts",
        sources: "addon-timeline",
      }}
    />
  );
}
export function SourceEffects({ source }: { source: Pick<EntitlementSource, "effects"> }) {
  const { t } = useTranslation();
  return <SafeSourceEffects source={source} translate={(key, options) => t(key, options ?? {})} />;
}
