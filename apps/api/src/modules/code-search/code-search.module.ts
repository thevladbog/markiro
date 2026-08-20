import { Module } from "@nestjs/common";
import { CodeSearchController } from "./code-search.controller";
import { CodeSearchService } from "./code-search.service";

@Module({
  controllers: [CodeSearchController],
  providers: [CodeSearchService],
})
export class CodeSearchModule {}
