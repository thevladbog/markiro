import { Module } from "@nestjs/common";
import { IntegrationsController, ProductExternalLinkController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";
import { JournalService } from "./journal.service";

@Module({
  controllers: [IntegrationsController, ProductExternalLinkController],
  providers: [IntegrationsService, JournalService],
})
export class IntegrationsModule {}
