import { createContext, useContext, type ReactNode } from "react";

import type { HostUpdateOffer } from "./host-offer.js";

const NONE: HostUpdateOffer = { kind: "none" };
const UpdateOfferContext = createContext<HostUpdateOffer>(NONE);

/** The update the host offers this PC (`useHostUpdateOffer` in `App`), for the office. */
export function UpdateOfferProvider({
  value,
  children,
}: {
  value: HostUpdateOffer;
  children: ReactNode;
}) {
  return <UpdateOfferContext value={value}>{children}</UpdateOfferContext>;
}

export function useUpdateOffer(): HostUpdateOffer {
  return useContext(UpdateOfferContext);
}
