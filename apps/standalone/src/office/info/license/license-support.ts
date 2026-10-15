import type { TFunction } from "i18next";

import type { OfficeLicense } from "../../../host/protocol.js";
import type { SupportContributor } from "../support-blocks.js";
import { shortId } from "../support-report.js";
import { shortLicenseId, stateText } from "./license-view.js";

/**
 * The «Лицензия» block of the support text (license spec §9.4): the state
 * (its word and its code), the host's clock, the file's number with the
 * first eight characters of its id, till when it runs and when it was
 * issued (UTC, like the rest of the text), the key it was signed with, the
 * host (eight characters), the trial and the emergency. Never the INN, the
 * customer, the certificate's fingerprint, the file's text or the
 * activation request.
 */
export function licenseSupportLines(license: OfficeLicense, t: TFunction): [string, string][] {
  const none = t("office.about.license.support.none");
  const state = stateText(license);
  const clock = [
    license.flags.clockBehindDays === null
      ? null
      : t("office.about.license.support.clockBehind", { n: license.flags.clockBehindDays }),
    license.flags.clockAhead ? t("office.about.license.support.clockAhead") : null,
  ].filter((part): part is string => part !== null);
  const file = license.license;
  return [
    [
      t("office.about.license.support.state"),
      `${t(state.key, state.values ?? {})} (${license.state})`,
    ],
    [
      t("office.about.license.support.clock"),
      clock.length === 0 ? t("office.about.license.support.clockOk") : clock.join(", "),
    ],
    [
      t("office.about.license.support.file"),
      file === null
        ? none
        : t("office.about.license.support.fileValue", {
            sequence: file.sequence,
            id: shortLicenseId(file.licenseId),
          }),
    ],
    [t("office.about.license.support.validUntil"), file === null ? none : file.validUntil],
    [t("office.about.license.support.issuedAt"), file === null ? none : file.issuedAt],
    [t("office.about.license.support.kid"), file === null ? none : file.kid],
    [t("office.about.license.support.hostId"), shortId(license.binding.hostId) ?? none],
    [
      t("office.about.license.support.trial"),
      license.trial === null
        ? none
        : t("office.about.license.support.trialValue", {
            from: license.trial.startedAt,
            to: license.trial.endsAt,
          }),
    ],
    [t("office.about.license.support.emergency"), license.emergency.until ?? none],
  ];
}

/** The block, read from the host at the moment of the click; a host that does not answer is said in it. */
export const licenseSupportBlock: SupportContributor = async ({ t, read }) => {
  const title = t("office.about.license.support.title");
  try {
    const license = await read((api, token) => api.getLicense(token));
    return { title, lines: licenseSupportLines(license, t) };
  } catch {
    return {
      title,
      lines: [[t("office.about.license.support.state"), t("office.about.license.support.unread")]],
    };
  }
};
