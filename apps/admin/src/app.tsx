import { BrowserRouter, Route, Routes } from "react-router";

import { CreateOrgPage } from "./pages/auth/CreateOrg.js";
import { LoginPage } from "./pages/auth/Login.js";
import { RegisterPage } from "./pages/auth/Register.js";
import { SelectOrgPage } from "./pages/auth/SelectOrg.js";
import { ShellPage } from "./pages/Shell.js";

/**
 * Component routing (<BrowserRouter>/<Routes>/<Route>) rather than a data
 * router (createBrowserRouter/RouterProvider): this app has no loaders,
 * actions, or route-level data dependencies yet -- all data fetching so far
 * happens inside components via the auth client / react-query (wired at the
 * root in main.tsx). Component routing also composes more simply with
 * jsdom-based render tests (MemoryRouter drop-in, no router object to
 * construct per test).
 */
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/org/create" element={<CreateOrgPage />} />
        <Route path="/org/select" element={<SelectOrgPage />} />
        <Route path="/" element={<ShellPage />} />
      </Routes>
    </BrowserRouter>
  );
}
