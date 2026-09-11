import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import {
  SIGNED_PRINT_SELLER_TAX_ID,
  offerWorkspaceBankAccountSchema,
  offerWorkspacePartyV2Schema,
  type OfferRegistryQuery,
  type PlatformPrincipal,
} from "@markiro/platform-contracts";
import { and, asc, desc, eq, gte, inArray, lt, type SQL, sql } from "drizzle-orm";

import { DB } from "../../auth/auth.module";
import { bankAccountSnapshot, billingProfileSnapshot } from "../billing/commercial-snapshots";
import { printSellerTaxId } from "../billing/print-document-model";

type OfferRecord = typeof schema.commercialOffers.$inferSelect;

@Injectable()
export class OfferWorkspaceService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async registry(_actor: PlatformPrincipal, query: OfferRegistryQuery) {
    const predicates = registryPredicates(query);
    const where = predicates.length > 0 ? and(...predicates) : undefined;
    const base = () =>
      this.db
        .select({
          offer: schema.commercialOffers,
          tenantName: schema.organization.name,
          tenantSlug: schema.organization.slug,
          buyerLegalName: schema.tenantBillingProfiles.fullName,
          buyerTaxId: schema.tenantBillingProfiles.inn,
        })
        .from(schema.commercialOffers)
        .innerJoin(
          schema.organization,
          eq(schema.organization.id, schema.commercialOffers.tenantId),
        )
        .leftJoin(
          schema.tenantBillingProfiles,
          and(
            eq(schema.tenantBillingProfiles.tenantId, schema.commercialOffers.tenantId),
            eq(schema.tenantBillingProfiles.isCurrent, true),
          ),
        );
    const [countRows, rows] = await Promise.all([
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.commercialOffers)
        .innerJoin(
          schema.organization,
          eq(schema.organization.id, schema.commercialOffers.tenantId),
        )
        .leftJoin(
          schema.tenantBillingProfiles,
          and(
            eq(schema.tenantBillingProfiles.tenantId, schema.commercialOffers.tenantId),
            eq(schema.tenantBillingProfiles.isCurrent, true),
          ),
        )
        .where(where),
      base()
        .where(where)
        .orderBy(desc(schema.commercialOffers.createdAt), desc(schema.commercialOffers.id))
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
    ]);
    const offerIds = rows.map(({ offer }) => offer.id);
    const lineRows =
      offerIds.length === 0
        ? []
        : await this.db
            .select({
              offerId: schema.commercialOfferLines.offerId,
              nameRu: schema.commercialOfferLines.nameRu,
            })
            .from(schema.commercialOfferLines)
            .where(inArray(schema.commercialOfferLines.offerId, offerIds))
            .orderBy(
              asc(schema.commercialOfferLines.offerId),
              asc(schema.commercialOfferLines.position),
              asc(schema.commercialOfferLines.id),
            );
    const linesByOffer = new Map<string, { count: number; names: string[] }>();
    for (const line of lineRows) {
      const summary = linesByOffer.get(line.offerId) ?? { count: 0, names: [] };
      summary.count += 1;
      if (summary.names.length < 3) summary.names.push(line.nameRu);
      linesByOffer.set(line.offerId, summary);
    }

    return {
      items: rows.map(({ offer, tenantName, tenantSlug, buyerLegalName, buyerTaxId }) => {
        const summary = linesByOffer.get(offer.id) ?? { count: 0, names: [] };
        return {
          ...offer,
          tenantName,
          tenantSlug,
          buyerLegalName,
          buyerTaxId,
          lineSummary: summary.names,
          lineCount: summary.count,
        };
      }),
      page: query.page,
      limit: query.limit,
      total: countRows[0]?.total ?? 0,
    };
  }

  async workspace(actor: PlatformPrincipal, id: string) {
    const [located] = await this.db
      .select({ offer: schema.commercialOffers, tenant: schema.organization })
      .from(schema.commercialOffers)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.commercialOffers.tenantId))
      .where(eq(schema.commercialOffers.id, id))
      .limit(1);
    if (!located) throw new NotFoundException({ code: "offer_not_found" });

    const { offer, tenant } = located;
    const [lines, revisions, decisions, documents] = await Promise.all([
      this.db
        .select()
        .from(schema.commercialOfferLines)
        .where(
          and(
            eq(schema.commercialOfferLines.tenantId, offer.tenantId),
            eq(schema.commercialOfferLines.offerId, offer.id),
          ),
        )
        .orderBy(asc(schema.commercialOfferLines.position), asc(schema.commercialOfferLines.id)),
      this.db
        .select()
        .from(schema.commercialOffers)
        .where(
          and(
            eq(schema.commercialOffers.tenantId, offer.tenantId),
            eq(schema.commercialOffers.familyId, offer.familyId),
          ),
        )
        .orderBy(desc(schema.commercialOffers.revision), desc(schema.commercialOffers.id)),
      this.db
        .select({
          id: schema.commercialOfferDecisions.id,
          decision: schema.commercialOfferDecisions.decision,
          message: schema.commercialOfferDecisions.message,
          createdAt: schema.commercialOfferDecisions.createdAt,
        })
        .from(schema.commercialOfferDecisions)
        .where(
          and(
            eq(schema.commercialOfferDecisions.tenantId, offer.tenantId),
            eq(schema.commercialOfferDecisions.offerId, offer.id),
          ),
        )
        .orderBy(
          desc(schema.commercialOfferDecisions.createdAt),
          desc(schema.commercialOfferDecisions.id),
        )
        .limit(1),
      this.db
        .select({
          id: schema.commercialOfferDocuments.id,
          revision: schema.commercialOfferDocuments.revision,
          format: schema.commercialOfferDocuments.format,
          printVariant: schema.commercialOfferDocuments.printVariant,
          status: schema.commercialOfferDocuments.status,
          contentType: schema.commercialOfferDocuments.contentType,
          byteSize: schema.commercialOfferDocuments.byteSize,
          sha256: schema.commercialOfferDocuments.sha256,
          errorCode: schema.commercialOfferDocuments.errorCode,
          createdAt: schema.commercialOfferDocuments.createdAt,
          updatedAt: schema.commercialOfferDocuments.updatedAt,
        })
        .from(schema.commercialOfferDocuments)
        .where(
          and(
            eq(schema.commercialOfferDocuments.tenantId, offer.tenantId),
            eq(schema.commercialOfferDocuments.offerId, offer.id),
          ),
        )
        .orderBy(
          desc(schema.commercialOfferDocuments.revision),
          asc(schema.commercialOfferDocuments.format),
          asc(schema.commercialOfferDocuments.id),
        ),
    ]);
    const decision = decisions[0] ?? null;
    const [partySource, requestRows] = await Promise.all([
      offer.status === "draft" ? this.currentParties(offer) : this.snapshotParties(offer),
      this.db
        .select({
          id: schema.tenantBillingRequests.id,
          number: schema.tenantBillingRequests.number,
          status: schema.tenantBillingRequests.status,
          linkedOfferId: schema.tenantBillingRequestLinks.offerId,
          linkedAt: schema.tenantBillingRequestLinks.createdAt,
        })
        .from(schema.tenantBillingRequestLinks)
        .innerJoin(
          schema.tenantBillingRequests,
          and(
            eq(schema.tenantBillingRequests.tenantId, schema.tenantBillingRequestLinks.tenantId),
            eq(schema.tenantBillingRequests.id, schema.tenantBillingRequestLinks.requestId),
          ),
        )
        .where(
          and(
            eq(schema.tenantBillingRequestLinks.tenantId, offer.tenantId),
            inArray(
              schema.tenantBillingRequestLinks.offerId,
              revisions.map((revision) => revision.id),
            ),
          ),
        )
        .orderBy(
          sql`case when ${schema.tenantBillingRequestLinks.offerId} = ${offer.id} then 0 else 1 end`,
          desc(schema.tenantBillingRequestLinks.createdAt),
          desc(schema.tenantBillingRequestLinks.id),
        )
        .limit(1),
    ]);
    const { sellerTaxId, ...parties } = partySource;
    const currentGeneration = revisions.find((revision) => revision.status !== "draft");
    const latestRevision = revisions[0];
    const canWrite = actor.capabilities.includes("billing.write");
    const isCurrentGeneration = currentGeneration?.id === offer.id;
    const isLatestRevision = latestRevision?.id === offer.id;
    const accepted = decision?.decision === "accepted";
    const isUnexpired = offer.expiresAt === null || offer.expiresAt.getTime() > Date.now();
    const changesRequested = decision?.decision === "changes_requested";
    const sellerCanBeSigned = sellerTaxId === SIGNED_PRINT_SELLER_TAX_ID;
    const draftIsPublishable =
      parties.seller?.confirmedAt != null &&
      parties.buyer?.confirmedAt != null &&
      parties.sellerBankAccount != null;
    const request = requestRows[0];

    return {
      offer: { ...offer, lines },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      parties,
      revisions,
      decision,
      documents,
      request: request ? { id: request.id, number: request.number, status: request.status } : null,
      actions: {
        publish:
          canWrite &&
          offer.status === "draft" &&
          isLatestRevision &&
          draftIsPublishable &&
          isUnexpired,
        cancel: canWrite && offer.status === "published" && isCurrentGeneration,
        revise:
          canWrite &&
          offer.status === "published" &&
          isCurrentGeneration &&
          changesRequested &&
          !revisions.some((revision) => revision.status === "draft"),
        pay:
          canWrite &&
          offer.status === "published" &&
          isCurrentGeneration &&
          accepted &&
          isUnexpired,
        createInvoice: canWrite && offer.status === "published" && isCurrentGeneration && accepted,
        addSignedVariant:
          canWrite &&
          (offer.status === "paid" || (offer.status === "published" && isUnexpired)) &&
          isCurrentGeneration &&
          sellerCanBeSigned,
      },
    };
  }

  private async snapshotParties(offer: OfferRecord) {
    const [snapshot] = await this.db
      .select({
        seller: schema.commercialOfferPrintSnapshots.sellerSnapshot,
        buyer: schema.commercialOfferPrintSnapshots.buyerSnapshot,
        sellerBankAccount: schema.commercialOfferPrintSnapshots.sellerBankAccountSnapshot,
        buyerBankAccount: schema.commercialOfferPrintSnapshots.buyerBankAccountSnapshot,
      })
      .from(schema.commercialOfferPrintSnapshots)
      .where(
        and(
          eq(schema.commercialOfferPrintSnapshots.tenantId, offer.tenantId),
          eq(schema.commercialOfferPrintSnapshots.offerId, offer.id),
          eq(schema.commercialOfferPrintSnapshots.revision, offer.revision),
        ),
      )
      .limit(1);
    return {
      seller: parseParty(snapshot?.seller),
      sellerTaxId: printSellerTaxId(snapshot?.seller),
      buyer: parseParty(snapshot?.buyer),
      sellerBankAccount: parseBankAccount(snapshot?.sellerBankAccount),
      buyerBankAccount: parseBankAccount(snapshot?.buyerBankAccount),
    };
  }

  private async currentParties(offer: OfferRecord) {
    const [sellerRows, buyerRows, sellerAccountRows, buyerAccountRows] = await Promise.all([
      this.db
        .select()
        .from(schema.operatorBillingProfiles)
        .where(eq(schema.operatorBillingProfiles.isCurrent, true))
        .limit(1),
      this.db
        .select()
        .from(schema.tenantBillingProfiles)
        .where(
          and(
            eq(schema.tenantBillingProfiles.tenantId, offer.tenantId),
            eq(schema.tenantBillingProfiles.isCurrent, true),
          ),
        )
        .limit(1),
      this.db
        .select()
        .from(schema.operatorBankAccounts)
        .where(
          offer.sellerBankAccountId
            ? and(
                eq(schema.operatorBankAccounts.id, offer.sellerBankAccountId),
                eq(schema.operatorBankAccounts.status, "active"),
              )
            : and(
                eq(schema.operatorBankAccounts.status, "active"),
                eq(schema.operatorBankAccounts.isDefault, true),
              ),
        )
        .limit(1),
      this.db
        .select()
        .from(schema.tenantBankAccounts)
        .where(
          and(
            eq(schema.tenantBankAccounts.tenantId, offer.tenantId),
            eq(schema.tenantBankAccounts.status, "active"),
            eq(schema.tenantBankAccounts.isDefault, true),
          ),
        )
        .limit(1),
    ]);
    return {
      seller: sellerRows[0] ? parseParty(billingProfileSnapshot(sellerRows[0])) : null,
      sellerTaxId: null,
      buyer: buyerRows[0] ? parseParty(billingProfileSnapshot(buyerRows[0])) : null,
      sellerBankAccount: sellerAccountRows[0]
        ? parseBankAccount(bankAccountSnapshot(sellerAccountRows[0]))
        : null,
      buyerBankAccount: buyerAccountRows[0]
        ? parseBankAccount(bankAccountSnapshot(buyerAccountRows[0]))
        : null,
    };
  }
}

function registryPredicates(query: OfferRegistryQuery): SQL[] {
  const predicates: SQL[] = [];
  if (query.tenantId) predicates.push(eq(schema.commercialOffers.tenantId, query.tenantId));
  if (query.status) predicates.push(eq(schema.commercialOffers.status, query.status));
  if (query.createdFrom) {
    predicates.push(gte(schema.commercialOffers.createdAt, new Date(query.createdFrom)));
  }
  if (query.createdTo) {
    predicates.push(lt(schema.commercialOffers.createdAt, new Date(query.createdTo)));
  }
  if (query.search) {
    const pattern = `%${escapeLikePattern(query.search.trim())}%`;
    predicates.push(sql`(
      ${schema.commercialOffers.number} ilike ${pattern} escape '\\'
      or ${schema.organization.name} ilike ${pattern} escape '\\'
      or ${schema.organization.slug} ilike ${pattern} escape '\\'
      or ${schema.tenantBillingProfiles.fullName} ilike ${pattern} escape '\\'
      or ${schema.tenantBillingProfiles.displayName} ilike ${pattern} escape '\\'
      or ${schema.tenantBillingProfiles.inn} ilike ${pattern} escape '\\'
      or exists (
        select 1 from ${schema.commercialOfferLines}
        where ${schema.commercialOfferLines.offerId} = ${schema.commercialOffers.id}
          and ${schema.commercialOfferLines.tenantId} = ${schema.commercialOffers.tenantId}
          and (
            ${schema.commercialOfferLines.nameRu} ilike ${pattern} escape '\\'
            or ${schema.commercialOfferLines.nameEn} ilike ${pattern} escape '\\'
          )
      )
    )`);
  }
  return predicates;
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function parseParty(value: unknown) {
  const parsed = offerWorkspacePartyV2Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseBankAccount(value: unknown) {
  const parsed = offerWorkspaceBankAccountSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
