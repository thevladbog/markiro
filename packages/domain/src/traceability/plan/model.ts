export interface UsPlanSections {
  recordMaintenance: {
    systemOfRecord: string;
    formats: string[];
    recordLocations: string[];
    responsibleRoles: string[];
    backupAndRecovery: string;
    narrative: string[];
  };
  ftlIdentification: { procedure: string; reviewCadence: string };
  tlcAssignment: { procedure: string };
  pointOfContact: { name: string; title: string; phone: string; email: string | null };
  farmActivity: { status: "no" | "yes" | "unknown"; explanation: string };
  reviewAndUpdate: { procedure: string };
}

export interface UsPlanApprovalInput {
  profileCode: "US_FSMA204_PROCESSOR" | "US_GENERIC_LOT_TRACEABILITY";
  versionNumber: number;
  changeSummary: string;
  sections: UsPlanSections;
  tlcSourceLocationCount: number;
  /** Trusted caller fact: transport payloads must never select demo treatment. */
  provenance: "trusted_synthetic" | "operational";
  confirmations: {
    procedures: boolean;
    backupAndRecovery: boolean;
    contact: boolean;
    nonFarmScope: boolean;
  };
}

export interface UsPlanValidationIssue {
  code: string;
  section: keyof UsPlanSections | "plan";
  path: string;
}
