import { createContext, useContext, type ReactNode } from "react";

/** The id of the device the office runs on (`DeviceStatus.deviceId`); `null` when unknown. */
const ThisDeviceContext = createContext<string | null>(null);

export function ThisDeviceProvider({
  deviceId,
  children,
}: {
  deviceId: string | null;
  children: ReactNode;
}) {
  return <ThisDeviceContext.Provider value={deviceId}>{children}</ThisDeviceContext.Provider>;
}

/** This PC's device id, so «Устройства» can mark its row and warn before it revokes itself. */
export function useThisDeviceId(): string | null {
  return useContext(ThisDeviceContext);
}
