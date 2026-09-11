import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  isAgreementEditable,
  isAgreementTransitionAllowed,
  type AgreementDetail,
  type AgreementListQuery,
  type AgreementStatus,
  type AgreementSummary,
  type CreateAgreementInput,
  type UpdateAgreementInput,
} from "@markiro/platform-contracts";

import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { AgreementDocumentsService } from "./agreement-documents.service";
import { nextAgreementNumber } from "./agreement-numbering";
import {
  buildStoredTerms,
  isUniqueViolation,
  parseRequisites,
  parseSignatory,
  parseTerms,
  type AgreementRequisitesInput,
} from "./agreement-state";

const NUMBER_CONSTRAINT = "platform_agreements_number_uq";

type AgreementRow = typeof schema.platformAgreements.$inferSelect;
type AgreementDocumentRow = typeof schema.platformAgreementDocuments.$inferSelect;

@Injectable()
export class PlatformAgreementsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
    private readonly documents: AgreementDocumentsService,
  ) {}

  async list(query: AgreementListQuery): Promise<{ agreements: readonly AgreementSummary[] }> {
    const filters = [
      query.status ? eq(schema.platformAgreements.status, query.status) : undefined,
      query.withoutTenant ? isNull(schema.platformAgreements.tenantId) : undefined,
      query.search ? searchFilter(query.search) : undefined,
    ].filter((filter) => filter !== undefined);

    const rows = await this.db
      .select()
      .from(schema.platformAgreements)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(schema.platformAgreements.createdAt));
    return { agreements: rows.map(toSummary) };
  }

  async detail(id: string): Promise<{ agreement: AgreementDetail }> {
    const agreement = await this.requireAgreement(id);
    return { agreement: await this.withDocuments(agreement) };
  }

  async create(
    actor: PlatformPrincipal,
    input: CreateAgreementInput,
  ): Promise<{ agreement: AgreementDetail }> {
    const contractor = await this.loadContractorRequisites();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const row = await this.db.transaction(async (tx) => {
          const number = input.number ?? (await allocateNumber(tx));
          const [stored] = await tx
            .insert(schema.platformAgreements)
            .values({
              number,
              status: "draft",
              conclusionDate: input.conclusionDate ?? null,
              city: input.city ?? null,
              documentForm: input.documentForm ?? "ru",
              counterpartyInn: input.counterparty.inn ?? null,
              counterparty: input.counterparty,
              contractor,
              terms: buildStoredTerms(input.terms, input.signatory),
              signedSnapshot: null,
              createdByPlatformUserId: actor.userId,
            })
            .returning();
          if (!stored) throw new Error("Agreement insert returned no row");

          await this.audit.record(tx, {
            actorPlatformUserId: actor.userId,
            actorRole: actor.role,
            action: "platform.agreement.created",
            outcome: "success",
            tenantId: null,
            targetType: "platform_agreement",
            targetId: stored.id,
            reason: null,
            before: null,
            after: { number: stored.number, status: stored.status },
            requestId: null,
          });
          return stored;
        });
        return { agreement: await this.withDocuments(row) };
      } catch (error) {
        // Two operators creating at the same second is the only way this
        // races; the constraint decides and the loser retries once.
        if (attempt === 0 && !input.number && isUniqueViolation(error, NUMBER_CONSTRAINT)) continue;
        if (isUniqueViolation(error, NUMBER_CONSTRAINT)) {
          throw new ConflictException("Agreement number is already taken");
        }
        throw error;
      }
    }
    throw new ConflictException("Could not allocate an agreement number");
  }

  async update(
    actor: PlatformPrincipal,
    id: string,
    input: UpdateAgreementInput,
  ): Promise<{ agreement: AgreementDetail }> {
    const existing = await this.requireAgreement(id);
    this.assertEditable(existing);

    const run = async () =>
      this.db.transaction(async (tx) => {
        const terms = input.terms ?? parseTerms(existing.terms);
        const signatory = input.signatory ?? parseSignatory(existing.terms);
        const [updated] = await tx
          .update(schema.platformAgreements)
          .set({
            ...(input.number === undefined ? {} : { number: input.number }),
            ...(input.conclusionDate === undefined ? {} : { conclusionDate: input.conclusionDate }),
            ...(input.city === undefined ? {} : { city: input.city }),
            ...(input.documentForm === undefined ? {} : { documentForm: input.documentForm }),
            ...(input.counterparty === undefined
              ? {}
              : {
                  counterparty: input.counterparty,
                  counterpartyInn: input.counterparty.inn ?? null,
                }),
            terms: buildStoredTerms(terms, signatory),
            updatedAt: new Date(),
          })
          .where(eq(schema.platformAgreements.id, id))
          .returning();
        if (!updated) throw new NotFoundException("Agreement not found");

        await this.audit.record(tx, {
          actorPlatformUserId: actor.userId,
          actorRole: actor.role,
          action: "platform.agreement.updated",
          outcome: "success",
          tenantId: updated.tenantId,
          targetType: "platform_agreement",
          targetId: updated.id,
          reason: null,
          before: { number: existing.number },
          after: { number: updated.number },
          requestId: null,
        });
        return updated;
      });

    let row;
    try {
      row = await run();
    } catch (error) {
      // Same rule as create: the constraint decides who owns a number.
      if (isUniqueViolation(error, NUMBER_CONSTRAINT)) {
        throw new ConflictException("Agreement number is already taken");
      }
      throw error;
    }
    return { agreement: await this.withDocuments(row) };
  }

  async transition(
    actor: PlatformPrincipal,
    id: string,
    target: AgreementStatus,
    terminationReason: string | undefined,
  ): Promise<{ agreement: AgreementDetail }> {
    const existing = await this.requireAgreement(id);
    const from = existing.status;
    this.assertTransition(from, target);

    // Rendering and uploading happen first: the transaction below must not
    // stay open across object-store round trips.
    const rendered = target === "signed" ? await this.documents.renderSignedObject(existing) : null;

    const row = await this.db.transaction(async (tx) => {
      const now = new Date();
      // Signing freezes the printed document: the snapshot and the stored
      // DOCX are written in the same transaction as the status change.
      const signing =
        target === "signed"
          ? {
              signedAt: now,
              signedSnapshot: {
                number: existing.number,
                conclusionDate: existing.conclusionDate,
                city: existing.city,
                documentForm: existing.documentForm,
                counterparty: existing.counterparty,
                contractor: existing.contractor,
                terms: existing.terms,
              },
            }
          : {};
      const termination =
        target === "terminated"
          ? { terminatedAt: now, terminationReason: terminationReason ?? null }
          : {};

      // Re-read under a row lock: the status may have moved while the
      // document was rendered and uploaded.
      const [current] = await tx
        .select({ status: schema.platformAgreements.status })
        .from(schema.platformAgreements)
        .where(eq(schema.platformAgreements.id, id))
        .for("update");
      if (!current) throw new NotFoundException("Agreement not found");
      if (current.status !== from) {
        throw new ConflictException("Agreement status changed while the document was rendered");
      }
      if (rendered) {
        await this.documents.recordSignedDocument(tx, existing, rendered);
      }

      const [updated] = await tx
        .update(schema.platformAgreements)
        .set({ status: target, updatedAt: now, ...signing, ...termination })
        .where(eq(schema.platformAgreements.id, id))
        .returning();
      if (!updated) throw new NotFoundException("Agreement not found");

      await this.audit.record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action: "platform.agreement.status_changed",
        outcome: "success",
        tenantId: updated.tenantId,
        targetType: "platform_agreement",
        targetId: id,
        reason: terminationReason ?? null,
        before: { status: from },
        after: { status: target },
        requestId: null,
      });
      return updated;
    });
    return { agreement: await this.withDocuments(row) };
  }

  async linkTenant(
    actor: PlatformPrincipal,
    id: string,
    tenantId: string,
  ): Promise<{ agreement: AgreementDetail }> {
    const existing = await this.requireAgreement(id);
    const [tenant] = await this.db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundException("Tenant not found");

    // Linking is registry bookkeeping, not contract text, so a signed
    // agreement may still be linked and its frozen snapshot is untouched.
    const row = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(schema.platformAgreements)
        .set({ tenantId, updatedAt: new Date() })
        .where(eq(schema.platformAgreements.id, id))
        .returning();
      if (!updated) throw new NotFoundException("Agreement not found");
      await this.audit.record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action: "platform.agreement.tenant_linked",
        outcome: "success",
        tenantId,
        targetType: "platform_agreement",
        targetId: id,
        reason: null,
        before: { tenantId: existing.tenantId },
        after: { tenantId },
        requestId: null,
      });
      return updated;
    });
    return { agreement: await this.withDocuments(row) };
  }

  async unlinkTenant(
    actor: PlatformPrincipal,
    id: string,
  ): Promise<{ agreement: AgreementDetail }> {
    const existing = await this.requireAgreement(id);
    const row = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(schema.platformAgreements)
        .set({ tenantId: null, updatedAt: new Date() })
        .where(eq(schema.platformAgreements.id, id))
        .returning();
      if (!updated) throw new NotFoundException("Agreement not found");
      await this.audit.record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action: "platform.agreement.tenant_unlinked",
        outcome: "success",
        tenantId: existing.tenantId,
        targetType: "platform_agreement",
        targetId: id,
        reason: null,
        before: { tenantId: existing.tenantId },
        after: { tenantId: null },
        requestId: null,
      });
      return updated;
    });
    return { agreement: await this.withDocuments(row) };
  }

  async tenantCandidates(id: string): Promise<{
    candidates: readonly { tenantId: string; name: string; inn: string | null }[];
  }> {
    const agreement = await this.requireAgreement(id);
    if (!agreement.counterpartyInn) return { candidates: [] };
    const rows = await this.db
      .select({
        tenantId: schema.tenantBillingProfiles.tenantId,
        name: schema.tenantBillingProfiles.displayName,
        inn: schema.tenantBillingProfiles.inn,
      })
      .from(schema.tenantBillingProfiles)
      .where(
        and(
          eq(schema.tenantBillingProfiles.inn, agreement.counterpartyInn),
          eq(schema.tenantBillingProfiles.isCurrent, true),
        ),
      );
    return { candidates: rows };
  }

  async requireAgreement(id: string): Promise<AgreementRow> {
    const [row] = await this.db
      .select()
      .from(schema.platformAgreements)
      .where(eq(schema.platformAgreements.id, id))
      .limit(1);
    if (!row) throw new NotFoundException("Agreement not found");
    return row;
  }

  assertEditable(row: AgreementRow): void {
    if (!isAgreementEditable(row.status)) {
      throw new ConflictException("A signed agreement cannot be edited");
    }
  }

  assertTransition(from: AgreementStatus, to: AgreementStatus): void {
    if (!isAgreementTransitionAllowed(from, to)) {
      throw new ConflictException(`Transition ${from} -> ${to} is not allowed`);
    }
  }

  async withDocuments(row: AgreementRow): Promise<AgreementDetail> {
    const documents = await this.db
      .select()
      .from(schema.platformAgreementDocuments)
      .where(eq(schema.platformAgreementDocuments.agreementId, row.id))
      .orderBy(desc(schema.platformAgreementDocuments.createdAt));
    return toDetail(row, documents);
  }

  private async loadContractorRequisites(): Promise<AgreementRequisitesInput> {
    const [profile] = await this.db
      .select()
      .from(schema.operatorBillingProfiles)
      .where(eq(schema.operatorBillingProfiles.isCurrent, true))
      .limit(1);
    if (!profile) {
      throw new ConflictException(
        "Operator billing profile is not configured; fill Настройки → Наша организация first",
      );
    }
    const bank = readBankDetails(profile.bankDetails);
    const contact = readContact(profile.contact);
    const base = {
      name: profile.displayName,
      address: profile.legalAddressRaw,
      email: contact.email,
      phone: contact.phone,
      bankName: bank.bankName,
      bic: bank.bic,
      settlementAccount: bank.settlementAccount,
      correspondentAccount: bank.correspondentAccount,
    };
    if (profile.kind === "legal_entity") {
      return {
        ...base,
        kind: "legal_entity",
        inn: profile.inn ?? "",
        kpp: profile.kpp ?? "",
        ogrn: profile.ogrn ?? "",
      };
    }
    if (profile.kind === "sole_proprietor") {
      return {
        ...base,
        kind: "sole_proprietor",
        inn: profile.inn ?? "",
        ogrnip: profile.ogrnip ?? "",
      };
    }
    if (profile.kind === "self_employed") {
      return { ...base, kind: "self_employed", inn: profile.inn ?? "" };
    }
    return { ...base, kind: "individual", inn: profile.inn };
  }
}

function searchFilter(search: string) {
  const pattern = `%${search.replace(/[%_]/g, (character) => `\\${character}`)}%`;
  return or(
    sql`${schema.platformAgreements.number} ilike ${pattern}`,
    sql`${schema.platformAgreements.counterpartyInn} ilike ${pattern}`,
    sql`${schema.platformAgreements.counterparty} ->> 'name' ilike ${pattern}`,
  );
}

async function allocateNumber(tx: Pick<Db, "select">): Promise<string> {
  const rows = await tx
    .select({ number: schema.platformAgreements.number })
    .from(schema.platformAgreements);
  return nextAgreementNumber(
    rows.map((row) => row.number),
    new Date().getUTCFullYear(),
  );
}

function readBankDetails(value: unknown): {
  bankName: string | null;
  bic: string | null;
  settlementAccount: string | null;
  correspondentAccount: string | null;
} {
  const source =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const text = (key: string): string | null =>
    typeof source[key] === "string" && source[key] !== "" ? source[key] : null;
  return {
    bankName: text("bankName") ?? text("name"),
    bic: text("bic"),
    settlementAccount: text("settlementAccount") ?? text("account"),
    correspondentAccount: text("correspondentAccount"),
  };
}

function readContact(value: unknown): { email: string | null; phone: string | null } {
  const source =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const text = (key: string): string | null =>
    typeof source[key] === "string" && source[key] !== "" ? source[key] : null;
  return { email: text("email"), phone: text("phone") };
}

function toSummary(row: AgreementRow): AgreementSummary {
  const counterparty = parseRequisites(row.counterparty, "counterparty");
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    documentForm: row.documentForm,
    counterpartyName: counterparty.name,
    counterpartyInn: row.counterpartyInn,
    conclusionDate: row.conclusionDate,
    tenantId: row.tenantId,
    signedAt: row.signedAt ? row.signedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toDetail(row: AgreementRow, documents: readonly AgreementDocumentRow[]): AgreementDetail {
  return {
    ...toSummary(row),
    city: row.city,
    counterparty: parseRequisites(row.counterparty, "counterparty"),
    contractor: parseRequisites(row.contractor, "contractor"),
    signatory: parseSignatory(row.terms),
    terms: parseTerms(row.terms),
    terminatedAt: row.terminatedAt ? row.terminatedAt.toISOString() : null,
    terminationReason: row.terminationReason,
    editable: isAgreementEditable(row.status),
    documents: documents.map((document) => ({
      id: document.id,
      kind: document.kind,
      filename: document.filename,
      mediaType: document.mediaType,
      sha256: document.sha256,
      byteSize: document.byteSize,
      createdAt: document.createdAt.toISOString(),
    })),
  };
}
