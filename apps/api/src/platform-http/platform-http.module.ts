import {
  Global,
  Module,
  RequestMethod,
  type MiddlewareConsumer,
  type NestModule,
} from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";

import { PlatformExceptionFilter } from "./platform-exception.filter";
import { PlatformRequestContextMiddleware } from "./platform-request-context.middleware";

@Global()
@Module({
  providers: [
    PlatformRequestContextMiddleware,
    PlatformExceptionFilter,
    { provide: APP_FILTER, useExisting: PlatformExceptionFilter },
  ],
  exports: [PlatformRequestContextMiddleware],
})
export class PlatformHttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(PlatformRequestContextMiddleware)
      .forRoutes({ path: "{*platformRequestPath}", method: RequestMethod.ALL });
  }
}
