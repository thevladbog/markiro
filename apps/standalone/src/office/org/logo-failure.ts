import { HostError } from "../../host/client.js";
import { errorMessageKey } from "../../host/errors.js";
import { LogoDecodeError } from "../../labels/logo.js";

/**
 * The `ru.json` key of why a picked file cannot become a logo: the precise
 * reason of `decodeLogoFile`, or the general one for anything else the
 * webview threw.
 */
export function logoDecodeKey(error: unknown): string {
  if (error instanceof LogoDecodeError) return `office.org.logo.errors.${error.code}`;
  return "office.org.logo.errors.unreadable";
}

/** The `ru.json` key of why the host did not take a logo or its removal. */
export function logoWriteKey(error: unknown): string {
  if (error instanceof HostError && error.code === "validation_failed") {
    return "office.org.logo.errors.rejected";
  }
  if (
    error instanceof HostError &&
    error.code === "conflict" &&
    error.details["constraint"] === "feature_disabled"
  ) {
    return "office.about.license.refusals.feature.customLogo";
  }
  return errorMessageKey(error);
}
