import { Inject, Injectable } from "@nestjs/common";

import { schema, type Db } from "@markiro/db";

import { DB } from "../../auth/auth.module";

export interface ChzProductGroupDto {
  code: number;
  alias: string;
  name: string;
}

export interface ListChzProductGroupsResponseDto {
  items: ChzProductGroupDto[];
}

@Injectable()
export class ProductGroupsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Global reference data: the same rows for every tenant, so there is no
   * tenant predicate here by design.
   */
  async list(): Promise<ListChzProductGroupsResponseDto> {
    const items = await this.db
      .select({
        code: schema.chzProductGroups.code,
        alias: schema.chzProductGroups.alias,
        name: schema.chzProductGroups.name,
      })
      .from(schema.chzProductGroups);

    // Sort using Russian locale collation for proper alphabetical order
    items.sort((a, b) => a.name.localeCompare(b.name, "ru"));

    return { items };
  }
}
