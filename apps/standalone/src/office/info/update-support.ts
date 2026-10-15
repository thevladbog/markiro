import type { SupportContributor } from "./support-blocks.js";
import { packageStateKey } from "./update-status.js";

/**
 * The support block «Раздача обновления» (spec §9.4): the host's package
 * and «Устройства и версии», without hashes, keys or paths.
 */
export const updateDistributionContributor: SupportContributor = async ({ t, read }) => {
  const status = await read((api, token) => api.getUpdateStatus(token));
  const state = t(`office.about.update.support.state.${packageStateKey(status.package.state)}`);
  return {
    title: t("office.about.update.support.title"),
    lines: [
      [
        t("office.about.update.support.package"),
        status.package.version === null ? state : `${state}, ${status.package.version}`,
      ],
      [t("office.about.update.support.staged"), status.package.staged ?? "—"],
      [t("office.about.update.support.previous"), status.package.previous ?? "—"],
      ...status.devices.map(
        (device) =>
          [
            `${device.name} (${device.kind})`,
            t("office.about.update.support.device", {
              version: device.appVersion,
              protocol: device.protocol,
              state: t(`office.about.update.support.deviceState.${device.state}`),
            }),
          ] as const,
      ),
    ],
  };
};
