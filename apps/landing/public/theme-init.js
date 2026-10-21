// Applies the saved colour theme before the first paint. A classic blocking script
// because the landing CSP has no 'unsafe-inline'; src/scripts/theme.ts owns the switch.
(function () {
  var root = document.documentElement;
  var choice = "system";
  try {
    var saved = localStorage.getItem("markiro:theme");
    if (saved === "light" || saved === "dark") choice = saved;
  } catch (error) {}
  var dark =
    choice === "dark" ||
    (choice === "system" &&
      window.matchMedia &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  root.setAttribute("data-theme", dark ? "dark" : "light");
  root.setAttribute("data-theme-choice", choice);
})();
