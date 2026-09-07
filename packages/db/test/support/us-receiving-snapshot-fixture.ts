import { randomUUID } from "node:crypto";
import type { createUsProfileTestDatabase } from "./us-profile-database.js";

/** Raw pre-root v1/v2 specimens: never rebuilt through a newer snapshot writer. */
export const time = "2026-09-07T10:00:00.000Z";
export const evidenceUrl = "https://例え.テスト/Ä";
export const reason = "  Receipt-specific rationale  ";
export const receipt = {
  evidenceUrl,
  tlcHandling: "assign_if_missing",
  proposedTlc: "=Case/Ä-001",
};
export type Path = "ordinary" | "preserved" | "assigned";
export type Fixture = Awaited<ReturnType<typeof createUsProfileTestDatabase>>;

export async function seed(
  fixture: Fixture,
  path: Path = "ordinary",
  version = 2,
  assignmentBasis?: string,
) {
  const tenant = randomUUID(),
    id = randomUUID(),
    party = randomUUID(),
    location = randomUUID(),
    product = randomUUID(),
    lot = randomUUID(),
    document = randomUUID();
  await fixture.pool.query(
    "INSERT INTO organization(id,name,slug,created_at) VALUES ($1,'Synthetic',$1,now())",
    [tenant],
  );
  await fixture.pool.query(
    "INSERT INTO traceability_profiles(tenant_id,code,baseline_version) VALUES ($1,'US_GENERIC_LOT_TRACEABILITY','US-REG-2026-09-03')",
    [tenant],
  );
  await fixture.pool.query(
    "INSERT INTO traceability_parties(id,tenant_id,name) VALUES ($1,$2,'Synthetic supplier')",
    [party, tenant],
  );
  await fixture.pool.query(
    "INSERT INTO traceability_locations(id,tenant_id,party_id,name,business_name,phone_number,street_address,city,state_or_region,zip_or_postal_code,country_code) VALUES ($1,$2,$3,'Dock','Synthetic supplier','+1 509 555 0100','100 Test Way','Yakima','WA','98901','US')",
    [location, tenant, party],
  );
  await fixture.pool.query(
    "INSERT INTO products(id,tenant_id,name) VALUES ($1,$2,'Apple slices')",
    [product, tenant],
  );
  await fixture.pool.query(
    "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,source_location_id,source_locked_at,created_by,updated_by) VALUES ($1,$2,$3,'=Case/Ä-001',$4,$5,$6,'qa-user','qa-user')",
    [
      lot,
      tenant,
      product,
      assignmentBasis ?? (path === "assigned" ? "exempt_supplier_receipt" : "imported"),
      location,
      time,
    ],
  );
  await fixture.pool.query(
    "INSERT INTO traceability_events(id,tenant_id,event_number,time_zone,date_received,location_id,previous_source_location_id,created_by,updated_by) VALUES ($1,$2,'REC-26-0001','America/Chicago','2026-09-07',$3,$3,'qa-user','qa-user')",
    [id, tenant, location],
  );
  await fixture.pool.query(
    "INSERT INTO receiving_event_items(tenant_id,event_id,line_no,product_id,lot_id,lot_link_mode,tlc,quantity,unit_of_measure,source_location_id,exempt_supplier,exempt_reason) VALUES ($1,$2,1,$3,$4,'create_on_finalize',$5,'500.000','lb',$6,$7,$8)",
    [
      tenant,
      id,
      product,
      lot,
      path === "assigned" ? null : "=Case/Ä-001",
      location,
      path !== "ordinary",
      path === "ordinary" ? null : reason,
    ],
  );
  if (version === 2)
    await fixture.pool.query(
      "UPDATE receiving_event_items SET exempt_receipt=$1 WHERE tenant_id=$2 AND event_id=$3",
      [
        path === "preserved"
          ? { ...receipt, tlcHandling: "preserve_existing", proposedTlc: null }
          : receipt,
        tenant,
        id,
      ],
    );
  await fixture.pool.query(
    "INSERT INTO reference_documents(id,tenant_id,type,number,created_by) VALUES ($1,$2,'bol','0001','qa-user')",
    [document, tenant],
  );
  await fixture.pool.query(
    "INSERT INTO receiving_event_documents(tenant_id,event_id,document_id,position) VALUES ($1,$2,$3,1)",
    [tenant, id, document],
  );
  const description = {
    schemaVersion: 1,
    locationId: location,
    partyId: party,
    businessName: "Synthetic supplier",
    phoneNumber: "+1 509 555 0100",
    address: { kind: "street", streetAddress: "100 Test Way" },
    city: "Yakima",
    stateOrRegion: "WA",
    zipOrPostalCode: "98901",
    countryCode: "US",
    countryDisplay: "United States",
  };
  const basis =
    path === "ordinary"
      ? { kind: "ordinary" }
      : {
          kind: path === "assigned" ? "exempt_assigned_tlc" : "exempt_existing_tlc",
          reason,
          evidenceUrl,
          reviewedBy: "qa-user",
          reviewedAt: time,
          ...(path === "assigned" ? { receivedTlc: null } : {}),
        };
  const snapshot = {
    snapshotVersion: version,
    dateReceived: "2026-09-07",
    locationId: location,
    previousSourceLocationId: location,
    receivedAtNote: null,
    notes: null,
    profileCode: "US_GENERIC_LOT_TRACEABILITY",
    baselineVersion: "US-REG-2026-09-03",
    locationDescription: description,
    previousSourceDescription: description,
    items: [
      {
        lineNo: 1,
        productId: product,
        lotId: lot,
        lotLinkMode: "create_on_finalize",
        tlc: "=Case/Ä-001",
        source: { kind: "location", locationId: location },
        quantity: "500.000",
        unitOfMeasure: "lb",
        supplierLotReference: null,
        notes: null,
        productDescription: {
          snapshotVersion: 1,
          sourceProductId: product,
          productName: "Apple slices",
          brandName: null,
          commodity: null,
          variety: null,
          packagingSize: null,
          packagingStyle: null,
          gtin: null,
        },
        coverage: {
          coverageStatus: "unknown",
          coverageRationale: null,
          ftlCategory: null,
          ftlSourceUrl: null,
          ftlSourceVersion: null,
          reviewedBy: null,
          reviewedAt: null,
        },
        sourceDescription: description,
        ...(version === 2 ? { receiptBasis: basis } : {}),
      },
    ],
    documents: [
      {
        document: {
          snapshotVersion: 1,
          documentId: document,
          type: "bol",
          typeOtherLabel: null,
          number: "0001",
          partyId: null,
          issuedOn: null,
          notes: null,
        },
        issuer: null,
      },
    ],
    confirmation: {
      ruleVersion: version === 2 ? "receiving-readiness-v3" : "receiving-readiness-v2",
      inputDigest: "a".repeat(64),
      warnings: [],
      ...(version === 2 ? { reviewedExemptLines: path === "ordinary" ? [] : [1] } : {}),
    },
  };
  return { tenant, id, location, product, lot, document, snapshot };
}
export type Specimen = Awaited<ReturnType<typeof seed>>;
export function firstItem(c: Specimen) {
  const item = c.snapshot.items[0];
  if (!item) throw new Error("Missing specimen item");
  return item;
}
export function transition(
  fixture: Fixture,
  c: Specimen,
  snapshot: unknown = c.snapshot,
  finalizedAt = time,
) {
  return fixture.pool.query(
    "UPDATE traceability_events SET status='finalized', finalized_at=$1, updated_at=$1, finalized_by='qa-user', updated_by='qa-user', finalization_snapshot=$2 WHERE tenant_id=$3 AND id=$4",
    [finalizedAt, snapshot, c.tenant, c.id],
  );
}
