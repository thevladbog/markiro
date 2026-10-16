import "@markiro/ui/styles.css";
import "./app/shell.css";
import "./office/list/list.css";
import "./office/avatar/profile.css";
import "./i18n/index.js";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ThemeProvider } from "@markiro/ui";

import { App } from "./app/App.js";
import "./floor/floor-kit.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}

// «Системная» (follow the OS) is the default; the office header and sign-in switch it.
createRoot(container).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system">
      <App />
    </ThemeProvider>
  </StrictMode>,
);
