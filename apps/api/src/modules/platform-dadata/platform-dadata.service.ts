import { Injectable } from "@nestjs/common";

import { DadataClient } from "../../integrations/dadata/dadata.client";
import {
  type DadataAddressResult,
  type DadataBankResult,
  DadataConfig,
  type DadataOrganizationResult,
} from "../../integrations/dadata/dadata.types";

@Injectable()
export class PlatformDadataService {
  constructor(
    private readonly client: DadataClient,
    private readonly config: DadataConfig,
  ) {}

  organizations(query: string): Promise<DadataOrganizationResult> {
    return this.client.suggestOrganizations(query);
  }

  addresses(query: string): Promise<DadataAddressResult> {
    return this.client.suggestAddresses(query);
  }

  banks(query: string): Promise<DadataBankResult> {
    return this.client.suggestBanks(query);
  }

  status(): { status: "ready" | "unconfigured" } {
    return { status: this.config.configured ? "ready" : "unconfigured" };
  }
}
