import { Module } from "@nestjs/common";
import { LabelTemplatesController } from "./label-templates.controller";
import { LabelTemplatesService } from "./label-templates.service";

@Module({
  controllers: [LabelTemplatesController],
  providers: [LabelTemplatesService],
})
export class LabelTemplatesModule {}
