import { Module } from "@nestjs/common";
import { ChzCodeStatusReadService } from "../chz-code-statuses/chz-code-status-read.service";
import { IntegrationsController, ProductExternalLinkController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";
import { JournalService } from "./journal.service";

@Module({
  controllers: [IntegrationsController, ProductExternalLinkController],
  providers: [IntegrationsService, JournalService, ChzCodeStatusReadService],
})
export class IntegrationsModule {}
