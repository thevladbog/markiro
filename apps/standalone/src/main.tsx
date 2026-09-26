import "@markiro/ui/styles.css";
import "./app/shell.css";
import "./i18n/index.js";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ThemeProvider } from "@markiro/ui";

import { App } from "./app/App.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}

// The floor is dark (design brief 02/04); office screens will share this
// provider and switch the theme from their header.
createRoot(container).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <App />
    </ThemeProvider>
  </StrictMode>,
);
