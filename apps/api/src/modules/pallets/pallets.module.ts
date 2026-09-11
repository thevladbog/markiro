import { Module } from "@nestjs/common";
import { PalletsController } from "./pallets.controller";
import { PalletsService } from "./pallets.service";

@Module({
  controllers: [PalletsController],
  providers: [PalletsService],
})
export class PalletsModule {}
