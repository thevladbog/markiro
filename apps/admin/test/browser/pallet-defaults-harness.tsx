import "@markiro/ui/styles.css";
import "../../src/i18n/index.js";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ThemeProvider } from "@markiro/ui";
import { OrgProfilePage } from "../../src/pages/settings/OrgProfilePage.js";
const root = document.getElementById("root");
if (!root) throw new Error("Root missing");
createRoot(root).render(
  <ThemeProvider defaultTheme="dark">
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <OrgProfilePage />
      </MemoryRouter>
    </QueryClientProvider>
  </ThemeProvider>,
);
document.documentElement.dataset.ready = "true";
