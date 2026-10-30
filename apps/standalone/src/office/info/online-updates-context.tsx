import { createContext, useContext, type ReactNode } from "react";
import { createOnlineUpdatesApi, type OnlineUpdatesApi } from "./online-updates-api.js";
const OnlineUpdatesContext = createContext<OnlineUpdatesApi>(createOnlineUpdatesApi());
export function OnlineUpdatesProvider({
  value,
  children,
}: {
  value: OnlineUpdatesApi;
  children: ReactNode;
}) {
  return <OnlineUpdatesContext value={value}>{children}</OnlineUpdatesContext>;
}
export function useOnlineUpdates(): OnlineUpdatesApi {
  return useContext(OnlineUpdatesContext);
}
