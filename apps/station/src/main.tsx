import "@markiro/ui/styles.css";
import "./station.css";
import "./i18n/index.js";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { ThemeProvider } from "@markiro/ui";

import { App } from "./App.js";
import { shouldRenderGallery } from "./dev/gallery-guard.js";

const queryClient = new QueryClient();

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}
const rootContainer = container;

function render(content: ReactNode) {
  // Floor mode: dark theme is the default (design brief 02/04).
  createRoot(rootContainer).render(
    <StrictMode>
      <ThemeProvider defaultTheme="dark">
        <QueryClientProvider client={queryClient}>{content}</QueryClientProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}

if (import.meta.env.DEV) {
  if (shouldRenderGallery(true, window.location.search)) {
    void import("./dev/StationScreenGallery.js").then(({ StationScreenGalleryRoute }) => {
      render(<StationScreenGalleryRoute search={window.location.search} />);
    });
  } else {
    render(<App />);
  }
} else {
  render(<App />);
}
