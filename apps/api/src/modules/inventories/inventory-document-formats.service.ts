import { Injectable } from "@nestjs/common";

import { inventoryDocumentRegistry } from "@markiro/domain";

import {
  inventoryDocumentFormatsResponseSchema,
  type InventoryDocumentFormatsResponseDto,
} from "./inventory-document-formats.dto";

@Injectable()
export class InventoryDocumentFormatsService {
  list(): InventoryDocumentFormatsResponseDto {
    return inventoryDocumentFormatsResponseSchema.parse({
      items: inventoryDocumentRegistry.listAvailable(),
    });
  }
}
