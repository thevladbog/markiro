import type { NationalCatalogLinkRefreshService } from "./national-catalog-link-refresh.service";
import { summaryForCatalogLink } from "./national-catalog-summary";
import { catalogLocalStateSelection } from "./national-catalog-observation-projection";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { CABINET_CAPABILITY } from "@markiro/domain";
import type { ChzLinkDetail, ChzSummary } from "@markiro/platform-contracts";
import type { AuthorizationService } from "../../authorization/authorization.service";
import type { EntitlementsService } from "../../subscriptions/entitlements.service";
import { lockTenantSubscriptionTimeline } from "../../subscriptions/subscription-locks";
import { closeNationalCatalogLinkInTransaction } from "./national-catalog-link-writer";
import type { ImportActor, LinkChange } from "./national-catalog-import.types";

export class NationalCatalogLinkService {
  constructor(
    private readonly db: Db,
    private readonly authorization: AuthorizationService,
    private readonly entitlements: EntitlementsService,
    private readonly refreshes?: Pick<NationalCatalogLinkRefreshService, "request">,
  ) {}
  async refresh(actor: ImportActor, productId: string): Promise<ChzSummary> {
    if (!this.refreshes) throw new ForbiddenException("refresh_disabled");
    await this.refreshes.request(actor, productId);
    return this.read(actor.tenantId, productId);
  }
  async read(tenantId: string, productId: string): Promise<ChzSummary> {
    return (await this.readDetail(tenantId, productId)).summary;
  }
  async readDetail(tenantId: string, productId: string): Promise<ChzLinkDetail> {
    const [row] = await this.db
      .select({
        product: schema.products,
        link: schema.nationalCatalogProductLinks,
        imageChecksum: schema.mediaAssets.checksum,
        localState: catalogLocalStateSelection,
      })
      .from(schema.products)
      .leftJoin(
        schema.nationalCatalogProductLinks,
        and(
          eq(schema.nationalCatalogProductLinks.tenantId, schema.products.tenantId),
          eq(schema.nationalCatalogProductLinks.productId, schema.products.id),
          isNull(schema.nationalCatalogProductLinks.closedAt),
        ),
      )
      .leftJoin(
        schema.productImages,
        and(
          eq(schema.productImages.tenantId, schema.products.tenantId),
          eq(schema.productImages.productId, schema.products.id),
        ),
      )
      .leftJoin(
        schema.mediaAssets,
        and(
          eq(schema.mediaAssets.ownerTenantId, schema.products.tenantId),
          eq(schema.mediaAssets.id, schema.productImages.assetId),
          eq(schema.mediaAssets.status, "active"),
        ),
      )
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)));
    if (!row) throw new NotFoundException("product_not_found");
    const link = row.link;
    return {
      summary: summaryForCatalogLink(link, row.product, row.imageChecksum, row.localState),
      link: link
        ? {
            id: link.id,
            revision: link.revision,
            cardId: link.cardId,
            environment: link.environment,
            boundGtin14: link.boundGtin14,
            confirmedAt: link.confirmedAt.toISOString(),
          }
        : null,
    };
  }
  async remove(actor: ImportActor, productId: string, body: LinkChange): Promise<ChzSummary> {
    await this.db.transaction(async (tx) => {
      await lockTenantSubscriptionTimeline(tx, actor.tenantId);
      const principal = await this.authorization.resolvePrincipal(actor.userId, actor.tenantId, tx);
      if (!principal?.capabilities.includes(CABINET_CAPABILITY.OPERATIONS_WRITE))
        throw new ForbiddenException("permission_denied");
      await this.entitlements.assertWriteAccess(actor.tenantId, tx);
      const [product] = await tx
        .select({ id: schema.products.id })
        .from(schema.products)
        .where(and(eq(schema.products.tenantId, actor.tenantId), eq(schema.products.id, productId)))
        .for("update");
      if (!product) throw new NotFoundException("product_not_found");
      await closeNationalCatalogLinkInTransaction(
        tx,
        actor,
        productId,
        body.expectedRevision,
        "removed",
      );
    });
    return this.read(actor.tenantId, productId);
  }
}
