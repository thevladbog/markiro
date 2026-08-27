import { Inject, Injectable } from "@nestjs/common";

import {
  inventoryDocumentFormatsResponseSchema,
  type InventoryDocumentFormatsResponseDto,
} from "./inventory-document-formats.dto";
import {
  INVENTORY_DOCUMENT_GENERATOR_REGISTRY,
  InventoryDocumentGeneratorRegistry,
} from "./inventory-document-runner.service";

@Injectable()
export class InventoryDocumentFormatsService {
  constructor(
    @Inject(INVENTORY_DOCUMENT_GENERATOR_REGISTRY)
    private readonly registry: InventoryDocumentGeneratorRegistry,
  ) {}

  list(): InventoryDocumentFormatsResponseDto {
    return inventoryDocumentFormatsResponseSchema.parse({
      items: this.registry.listAvailable(),
    });
  }
}
