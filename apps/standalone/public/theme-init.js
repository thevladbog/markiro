// Pre-paint theme: «Системная» (the default) follows the OS, a stored choice wins.
// External (not inline) so the webview's CSP (script-src 'self') needs no exception;
// it runs before first paint, so the floor never flashes the wrong theme.
/* global window, document */
(function () {
  var theme = "system";
  try {
    var stored = window.localStorage.getItem("markiro.theme");
    if (stored === "light" || stored === "dark" || stored === "system") theme = stored;
  } catch {
    // storage unavailable: keep the default
  }
  var dark = false;
  if (theme === "dark") dark = true;
  else if (theme === "system") {
    try {
      dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
      // storage unavailable: keep the default
    }
  }
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
})();
