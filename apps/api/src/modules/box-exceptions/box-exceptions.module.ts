import { Module } from "@nestjs/common";
import { BoxExceptionsController } from "./box-exceptions.controller";
import { BoxExceptionsService } from "./box-exceptions.service";

@Module({
  controllers: [BoxExceptionsController],
  providers: [BoxExceptionsService],
})
export class BoxExceptionsModule {}
