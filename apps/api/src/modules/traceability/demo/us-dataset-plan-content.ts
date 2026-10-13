import { usPlanDraftCreateBodySchema } from "@markiro/platform-contracts";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Separately versioned statements; these describe a synthetic demonstration only. */
export const usDatasetPlanContent = freeze(
  usPlanDraftCreateBodySchema.parse({
    changeSummary: "Synthetic six-month processor traceability demonstration",
    sections: {
      recordMaintenance: {
        systemOfRecord: "Synthetic Markiro demonstration register",
        formats: ["Structured electronic records", "Immutable PDF"],
        recordLocations: ["Synthetic processor QA register"],
        responsibleRoles: ["Synthetic QA reviewer", "Synthetic production operator"],
        backupAndRecovery:
          "Demonstration procedure: retain a separate synthetic export and rehearse recovery in a disposable environment. This statement does not certify operating backup infrastructure.",
        narrative: [
          "All organizations, contacts, lots and transactions in this six-month demonstration are fictional. No regulatory approval or production acceptance is asserted.",
        ],
      },
      ftlIdentification: {
        procedure:
          "A synthetic QA reviewer manually compares each product with the Food Traceability List and records the reviewed coverage decision. The application does not automatically classify products.",
        reviewCadence:
          "Review each synthetic product at setup and whenever its description or coverage changes.",
      },
      tlcAssignment: {
        procedure:
          "Assign a traceability lot code at processing using the configured synthetic TLC source location. Preserve the assigned code in receiving, transformation and shipping trace records.",
      },
      pointOfContact: {
        name: "Synthetic QA Contact",
        title: "Demonstration QA reviewer",
        phone: "+1 202 555 0100",
        email: "qa@example.test",
      },
      farmActivity: {
        status: "no",
        explanation:
          "This synthetic processor demonstration includes no growing, harvesting, cooling or farm activities.",
      },
      reviewAndUpdate: {
        procedure:
          "The synthetic QA reviewer updates the demonstration plan when procedures, product coverage, contacts or TLC source locations change; preserve earlier approved versions and their original PDF bytes.",
      },
    },
  }),
);
export const US_DATASET_PLAN_CONTENT_VERSION = "us-six-month-plan-v1" as const;
