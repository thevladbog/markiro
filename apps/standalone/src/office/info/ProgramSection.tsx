import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Card, DefinitionGrid, type DefinitionGridItem } from "@markiro/ui";

import { PROTOCOL_VERSION } from "../../host/protocol.js";
import { PageLoading } from "../page-state.js";
import { useAboutData, type AboutData } from "./about-data.js";
import { BUILD_INFO } from "./build-info.js";
import { roleKey } from "./support-report.js";

/**
 * More rows for «О программе» (extension point T5 of the license and update
 * spec: the versions of the stations and other office PCs). Each returns
 * the rows it has, none while its data is missing.
 */
export type ProgramRows = (about: AboutData | undefined, t: TFunction) => DefinitionGridItem[];

/** The extra rows, after the page's own; empty until a feature adds its own. */
export const PROGRAM_ROWS: readonly ProgramRows[] = [];

/** «О программе»: the product, the versions of the app, the host and the protocol, this PC's role and system. */
export function ProgramSection() {
  const { t } = useTranslation();
  const data = useAboutData();
  return (
    <Card title={t("office.about.program.title")} titleAs="h2">
      {data.isPending ? <PageLoading /> : <DefinitionGrid items={programItems(data.data, t)} />}
    </Card>
  );
}

function programItems(about: AboutData | undefined, t: TFunction): DefinitionGridItem[] {
  const unknown = t("office.about.report.unknown");
  const hello = about?.hello ?? null;
  const items: DefinitionGridItem[] = [
    {
      id: "product",
      term: t("office.about.program.product"),
      description: t("office.about.program.productName"),
    },
    {
      id: "appVersion",
      term: t("office.about.program.appVersion"),
      description: about?.appVersion ?? unknown,
      mono: true,
    },
  ];
  if (BUILD_INFO.commit !== null || BUILD_INFO.date !== null) {
    items.push({
      id: "build",
      term: t("office.about.program.build"),
      description: [BUILD_INFO.commit, BUILD_INFO.date]
        .filter((part): part is string => part !== null)
        .join(", "),
      mono: true,
    });
  }
  items.push(
    {
      id: "hostVersion",
      term: t("office.about.program.hostVersion"),
      description: hello === null ? t("office.about.program.hostSilent") : hello.version,
      mono: hello !== null,
    },
    {
      id: "protocol",
      term: t("office.about.program.protocol"),
      description:
        hello === null
          ? String(PROTOCOL_VERSION)
          : t("office.about.program.protocolWithHost", {
              app: PROTOCOL_VERSION,
              host: hello.protocol,
              min: hello.minProtocol,
            }),
    },
    {
      id: "role",
      term: t("office.about.program.role"),
      description: t(`office.about.role.${roleKey(about?.role ?? "unknown")}`),
    },
    {
      id: "system",
      term: t("office.about.program.system"),
      description:
        about?.system == null
          ? unknown
          : [about.system.os, about.system.arch, about.system.webview]
              .filter((part): part is string => part !== null)
              .join(", "),
    },
  );
  for (const rows of PROGRAM_ROWS) items.push(...rows(about, t));
  return items;
}
