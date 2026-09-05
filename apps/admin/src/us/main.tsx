import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@markiro/ui";
import "@markiro/ui/styles.css";
import { UsApp } from "./app.js";
import "./us.css";

const root = document.getElementById("root");
if (!root || import.meta.env.VITE_DEPLOYMENT_EDITION !== "US") {
  throw new Error("US browser entry unavailable");
}
createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <UsApp />
    </ThemeProvider>
  </StrictMode>,
);
