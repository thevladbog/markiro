import "@markiro/ui/styles.css";
import "../../../src/app/shell.css";
import "../../../src/i18n/index.js";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@markiro/ui";
import { PackStateChip } from "../../../src/office/codes/PackLinks.js";
import { createHostApi } from "../../../src/host/api.js";
import { OfficeSessionProvider } from "../../../src/office/office-session.js";
import { OfficeSearch } from "../../../src/office/search/OfficeSearch.js";
import { OfficeSidebar } from "../../../src/office/OfficeSidebar.js";
import { navGroups } from "../../../src/office/nav-groups.js";
import { OfficeTopBar } from "../../../src/office/OfficeTopBar.js";
import { OfficeLinkProvider } from "../../../src/office/office-link.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { createOfficeQueryClient } from "../../../src/office/office-query.js";
import { MemoryRouter } from "react-router";

const api = createHostApi({
  async request(_method, _path, options) {
    if (_path.endsWith("/avatar")) return options.schema.parse({ avatar: null });
    return options.schema.parse({
      items: [
        {
          id: "warehouse:1",
          label: "(00)146006820000000409",
          detail: null,
          target: { kind: "warehouse_pallet", id: "1" },
        },
        {
          id: "cloud:2",
          label: "Октябрь — пробная смена",
          detail: "Сидр полусухой газированный «ДИКИЙ КРЕСТ» 0,45 л",
          target: { kind: "shift", id: "2", source: "cloud" },
        },
        {
          id: "document:3",
          label: "Палетный лист — отгрузка для производственного склада.pdf",
          detail: null,
          target: {
            kind: "document",
            id: "3",
            targetType: "warehouse_pallet",
            targetId: "1",
            source: "local",
          },
        },
      ],
      truncated: false,
    });
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing test root");
const theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
function Harness() {
  const [searchOpen, setSearchOpen] = useState(false);
  return (
    <ThemeProvider defaultTheme={theme}>
      {
        <OfficeSessionProvider
          value={{
            user: { id: "1", login: "admin", name: "Администратор", role: "admin" },
            api,
            call: (operation) => operation("browser-fixture"),
            logout: () => undefined,
            refreshUser: async () => undefined,
          }}
        >
          <QueryClientProvider client={createOfficeQueryClient()}>
            <MemoryRouter initialEntries={["/codes/warehouse-pallet/1"]}>
              <OfficeLinkProvider
                value={{
                  status: { state: "online", lastContactAt: Date.now(), lastError: null, seq: 1 },
                  sync: { kind: "done", synced: 1, failure: null, quarantined: 0 },
                }}
              >
                <div className="office-shell">
                  <OfficeSidebar
                    groups={navGroups("admin")}
                    collapsed={innerWidth < 1366}
                    id="menu"
                    onSearch={() => setSearchOpen(true)}
                  />
                  <div className="office-shell__main">
                    <OfficeTopBar
                      user={{
                        id: "1",
                        login: "admin",
                        name: "Александр Константинов",
                        role: "admin",
                      }}
                      pathname="/codes/warehouse-pallet/1"
                      menuCollapsed={innerWidth < 1366}
                      menuId="menu"
                      onToggleMenu={() => undefined}
                      onToFloor={() => undefined}
                      onProfile={() => undefined}
                      onChangePassword={() => undefined}
                      onSignOut={() => undefined}
                      onWindowLeft={() => undefined}
                    />
                    <main className="office-shell__content">
                      <div className="office-stack">
                        <h1>Палет (00)146006820000000409</h1>
                        <PackStateChip kind="pallet" state="closed" />
                        <p>Короба на палете</p>
                      </div>
                    </main>
                  </div>
                </div>
                {searchOpen && (
                  <OfficeSearch
                    onClose={() => setSearchOpen(false)}
                    onSelect={() => setSearchOpen(false)}
                  />
                )}
              </OfficeLinkProvider>
            </MemoryRouter>
          </QueryClientProvider>
        </OfficeSessionProvider>
      }
    </ThemeProvider>
  );
}
createRoot(root).render(<Harness />);
