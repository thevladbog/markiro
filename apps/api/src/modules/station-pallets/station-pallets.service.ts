import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type { LabelTemplateSpec } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import {
  PALLET_EXTENSION_DIGIT,
  SsccCapacityExhaustedException,
  SsccService,
} from "../sscc/sscc.service";
import type { StationPalletBootstrapDto } from "./dto";

/** Same size the shift bundle uses; see `PALLET_BLOCK_SIZE` in shifts.service.ts. */
const PALLET_BLOCK_SIZE = 200;

@Injectable()
export class StationPalletsService {
  private readonly logger = new Logger(StationPalletsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly sscc: SsccService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async bootstrap(tenantId: string, deviceId: string): Promise<StationPalletBootstrapDto> {
    const [products, operators, profile, categoryDefaults] = await Promise.all([
      this.db
        .select({
          id: schema.products.id,
          gtin14: schema.products.gtin14,
          name: schema.products.name,
          printName: schema.products.printName,
          shelfLifeDays: schema.products.shelfLifeDays,
          palletBoxCapacity: schema.products.palletBoxCapacity,
          chzProductGroupCode: schema.products.chzProductGroupCode,
        })
        .from(schema.products)
        .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.archived, false))),
      this.db
        .select({
          employeeId: schema.employeePickupPolicies.employeeId,
          canBuildPallets: schema.employeePickupPolicies.canBuildPallets,
        })
        .from(schema.employeePickupPolicies)
        .where(eq(schema.employeePickupPolicies.tenantId, tenantId)),
      this.db
        .select({ templateId: schema.orgProfiles.defaultPalletLabelTemplateId })
        .from(schema.orgProfiles)
        .where(eq(schema.orgProfiles.tenantId, tenantId))
        .then((rows) => rows[0] ?? null),
      this.db
        .select({
          chzProductGroupCode: schema.orgPalletLabelTemplateDefaults.chzProductGroupCode,
          templateId: schema.orgPalletLabelTemplateDefaults.templateId,
        })
        .from(schema.orgPalletLabelTemplateDefaults)
        .where(eq(schema.orgPalletLabelTemplateDefaults.tenantId, tenantId)),
    ]);

    const templateIds = [
      ...new Set(
        [profile?.templateId ?? null, ...categoryDefaults.map((d) => d.templateId)].filter(
          (id): id is string => id !== null,
        ),
      ),
    ];
    const specs = new Map<string, LabelTemplateSpec>();
    if (templateIds.length > 0) {
      const rows = await this.db
        .select({
          id: schema.labelTemplates.id,
          spec: schema.labelTemplates.spec,
          enabled: schema.labelTemplates.enabled,
        })
        .from(schema.labelTemplates)
        .where(eq(schema.labelTemplates.tenantId, tenantId));
      for (const row of rows) {
        if (row.enabled && templateIds.includes(row.id))
          specs.set(row.id, row.spec as LabelTemplateSpec);
      }
    }

    const block = await this.palletBlock(tenantId, deviceId);
    return {
      generatedAt: new Date().toISOString(),
      products,
      operators,
      ...block,
      palletLabelTemplates: {
        organisation: profile?.templateId ? (specs.get(profile.templateId) ?? null) : null,
        byCategory: categoryDefaults.flatMap((d) => {
          const template = specs.get(d.templateId);
          return template ? [{ chzProductGroupCode: d.chzProductGroupCode, template }] : [];
        }),
      },
    };
  }

  /** Mirrors `ShiftsService.bundleSscc`'s pallet half, without a shift. */
  private async palletBlock(
    tenantId: string,
    deviceId: string,
  ): Promise<Pick<StationPalletBootstrapDto, "palletSscc" | "palletSsccRevokedFrom">> {
    const none = { palletSscc: null, palletSsccRevokedFrom: [] as number[] };
    return this.db.transaction(async (tx) => {
      const access = await this.entitlements.resolveRecovery(tenantId, tx, new Date());
      if (access.access === "read_only") return none;
      let issuerPrefix: string;
      try {
        issuerPrefix = await this.sscc.resolveOrganisationIssuerPrefix(tenantId, tx);
      } catch (error) {
        if (!(error instanceof BadRequestException)) throw error;
        this.logger.warn(
          `Tenant ${tenantId} pallet bootstrap has no serial block -- ${error.message}`,
        );
        return none;
      }
      try {
        const palletSscc = await this.sscc.allocateForBundle(
          tenantId,
          issuerPrefix,
          PALLET_EXTENSION_DIGIT,
          deviceId,
          PALLET_BLOCK_SIZE,
          tx,
        );
        const palletSsccRevokedFrom = await this.sscc.revokedFromSerials(
          tenantId,
          issuerPrefix,
          PALLET_EXTENSION_DIGIT,
          deviceId,
          tx,
        );
        return { palletSscc, palletSsccRevokedFrom };
      } catch (error) {
        if (!(error instanceof SsccCapacityExhaustedException)) throw error;
        this.logger.warn(
          `Tenant ${tenantId} pallet bootstrap has no serial block -- ${error.message}`,
        );
        return none;
      }
    });
  }
}
