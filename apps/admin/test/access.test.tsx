import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { AccessProvider, useCan } from "../src/access/context.js";

function CapabilityProbe() {
  return <div>{useCan(CABINET_CAPABILITY.OPERATIONS_READ) ? "allowed" : "denied"}</div>;
}

describe("cabinet access context", () => {
  it("exposes the effective access document to capability checks", () => {
    render(
      <AccessProvider
        value={{ roles: ["manager"], capabilities: [CABINET_CAPABILITY.OPERATIONS_READ] }}
      >
        <CapabilityProbe />
      </AccessProvider>,
    );

    expect(screen.getByText("allowed")).toBeDefined();
  });
});
