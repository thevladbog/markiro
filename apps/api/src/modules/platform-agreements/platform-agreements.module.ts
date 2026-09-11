import { Module } from "@nestjs/common";

import { AgreementDocumentsService } from "./agreement-documents.service";
import { PlatformAgreementsController } from "./platform-agreements.controller";
import { PlatformAgreementsService } from "./platform-agreements.service";

@Module({
  controllers: [PlatformAgreementsController],
  providers: [PlatformAgreementsService, AgreementDocumentsService],
})
export class PlatformAgreementsModule {}
