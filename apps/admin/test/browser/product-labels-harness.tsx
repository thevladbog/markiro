// The normal cabinet routes, auth fixture and shell. Tests mock only API responses.
import i18n from "../../src/i18n/index.js";
await i18n.changeLanguage(
  new URLSearchParams(location.search).get("locale") === "en" ? "en" : "ru",
);
const fixtureParams = new URLSearchParams(location.search);
if (fixtureParams.get("fixture") === "validation-reprocessing") {
  localStorage.setItem("markiro.theme", fixtureParams.get("theme") === "dark" ? "dark" : "light");
}
await import("./cabinet-harness.js");
