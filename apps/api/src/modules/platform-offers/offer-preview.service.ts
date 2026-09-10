import { createHash } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, asc, eq } from "drizzle-orm";
import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import {
  bankAccountSnapshot,
  billingProfileSnapshot,
  resolveCommercialBillingDetails,
} from "../billing/commercial-snapshots";
import { toOfferPrintModel } from "../billing/print-document-model";
import { renderPrintHtml } from "../billing/print-document-html";
import { acquireBillingWorkflowLocks } from "../billing-workflow-locks";
import { calculateOfferBreakdown } from "./offer-preview-model";
import { normalizeOfferTerms } from "./offer-terms";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Resolve once under the same transaction as publication; no number or clock enters the hash. */
export async function resolveOfferPrintInput(
  tx: Transaction,
  draft: typeof schema.commercialOffers.$inferSelect,
) {
  const details = await resolveCommercialBillingDetails(
    tx,
    draft.tenantId,
    draft.sellerBankAccountId,
  );
  const lines = await tx
    .select()
    .from(schema.commercialOfferLines)
    .where(
      and(
        eq(schema.commercialOfferLines.tenantId, draft.tenantId),
        eq(schema.commercialOfferLines.offerId, draft.id),
      ),
    )
    .orderBy(asc(schema.commercialOfferLines.position))
    .for("share");
  const totals = calculateOfferBreakdown(lines, draft.total);
  const terms = normalizeOfferTerms(draft.termsMarkdown);
  const snapshot = {
    expiresAt: draft.expiresAt,
    sellerSnapshot: billingProfileSnapshot(details.seller),
    buyerSnapshot: billingProfileSnapshot(details.buyer),
    sellerBankAccountSnapshot: bankAccountSnapshot(details.sellerAccount),
    buyerBankAccountSnapshot: details.buyerAccount
      ? bankAccountSnapshot(details.buyerAccount)
      : null,
    linesSnapshot: lines.map((line, index) => ({
      ...line,
      lineTotal: totals.lineTotals[index] ?? line.lineTotal,
    })),
    subtotal: totals.subtotal,
    vatTotal: totals.vatTotal,
    total: totals.total,
    termsMarkdown: terms.markdown,
    termsHtml: terms.html,
  };
  const fingerprintInput = {
    id: draft.id,
    tenantId: draft.tenantId,
    familyId: draft.familyId,
    revision: draft.revision,
    ...snapshot,
    linesSnapshot: snapshot.linesSnapshot.map(({ createdAt: _createdAt, ...line }) => line),
  };
  return {
    details,
    snapshot,
    fingerprint: createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex"),
  };
}

@Injectable()
export class OfferPreviewService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async preview(actor: PlatformPrincipal, id: string) {
    if (!actor.capabilities.includes("billing.read")) throw new ForbiddenException();
    return this.db.transaction(async (tx) => {
      const [located] = await tx
        .select()
        .from(schema.commercialOffers)
        .where(eq(schema.commercialOffers.id, id))
        .limit(1);
      if (!located) throw new NotFoundException({ code: "offer_not_found" });
      await acquireBillingWorkflowLocks(tx, located.tenantId, [
        { kind: "offer_family", id: located.familyId },
        { kind: "offer", id },
      ]);
      const [draft] = await tx
        .select()
        .from(schema.commercialOffers)
        .where(eq(schema.commercialOffers.id, id))
        .for("share")
        .limit(1);
      if (!draft || draft.status !== "draft")
        throw new ConflictException({ code: "offer_not_draft" });
      const { snapshot, fingerprint } = await resolveOfferPrintInput(tx, draft);
      const model = toOfferPrintModel({
        ...snapshot,
        number: "",
        publishedAt: null,
        status: "draft",
      });
      return { html: renderPrintHtml(model), fingerprint };
    });
  }
}
