import { Module } from "@nestjs/common";
import { JournalService } from "../integrations/journal.service";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeysService } from "./api-keys.service";

@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeysService, JournalService],
})
export class ApiKeysModule {}
