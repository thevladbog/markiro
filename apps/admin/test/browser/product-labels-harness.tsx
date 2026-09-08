// The normal cabinet routes, auth fixture and shell. Tests mock only API responses.
import i18n from "../../src/i18n/index.js";
await i18n.changeLanguage(
  new URLSearchParams(location.search).get("locale") === "en" ? "en" : "ru",
);
await import("./cabinet-harness.js");
