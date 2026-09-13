import { PublicApiModule } from "../public-api/public-api.module";
import { Module } from "@nestjs/common";
import { JournalService } from "../integrations/journal.service";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeysService } from "./api-keys.service";

@Module({
  imports: [PublicApiModule],
  controllers: [ApiKeysController],
  providers: [ApiKeysService, JournalService],
})
export class ApiKeysModule {}
