import "@markiro/ui/styles.css";
import "../../../src/app/shell.css";
import "../../../src/i18n/index.js";

import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@markiro/ui";

import { OfficeLogin } from "../../../src/office/OfficeLogin.js";
import { AboutProvider } from "../../../src/office/info/about-context.js";
import type { AboutApi } from "../../../src/office/info/about-api.js";
import { rememberLogin } from "../../../src/office/recent-logins.js";
import { HostError } from "../../../src/host/client.js";
import type { HostStatus } from "../../../src/host/protocol.js";

// Isolated browser fixtures: no host requests, hardware or credentials leave this page.
const query = new URLSearchParams(location.search);
const state = query.get("state");
localStorage.setItem("markiro.theme", query.get("theme") === "light" ? "light" : "dark");
localStorage.removeItem("markiro.office.recentLogins");
if (state !== "empty") rememberLogin("admin");
if (state === "long") {
  for (const login of [
    "technologist_with_a_very_long_personnel_login",
    "упаковка-смена-номер-двадцать-четыре",
  ])
    rememberLogin(login);
}
const about: AboutApi = {
  appVersion: async () => "1.3.1",
  installRole: async () => "host",
  pairing: async () => null,
  hello: () => Promise.reject(new Error("No live host in the browser harness")),
  system: async () => ({ os: "Windows 11", arch: "x64", webview: null }),
  openLink: async () => undefined,
};
const link: HostStatus = {
  state: state === "offline" ? "offline" : "online",
  lastContactAt: null,
  lastError: null,
  seq: 1,
};
const root = document.getElementById("root");
if (root === null) throw new Error("Missing preview root");
createRoot(root).render(
  <ThemeProvider>
    <AboutProvider value={about}>
      <OfficeLogin
        notice={state === "expired" ? "session_ended" : null}
        link={link}
        onLogin={() =>
          Promise.reject(
            new HostError({
              kind: "api",
              code: "unauthorized",
              status: 401,
              details: { credential: "password" },
              message: "Preview sign-in refused",
            }),
          )
        }
        onBack={query.get("officePc") === "1" ? null : () => undefined}
        hostAddress={query.get("remote") === "1" ? "https://192.168.1.10:45710" : null}
        onChangeAddress={async () => undefined}
      />
    </AboutProvider>
  </ThemeProvider>,
);
