import {
  Controller,
  Get,
  Header,
  Module,
  ServiceUnavailableException,
  type DynamicModule,
} from "@nestjs/common";
import { allowedInterfaceLocales } from "@markiro/domain";
import { UsRuntime } from "./us-runtime";
import { UsProfileController, UsSessionGuard } from "./us-profile.controller";

@Controller()
class UsDevelopmentController {
  @Get("deployment")
  @Header("Cache-Control", "no-store")
  deployment() {
    return {
      edition: "US",
      releaseEnabled: false,
      interfaceLocales: allowedInterfaceLocales("US"),
      defaultInterfaceLocale: "en-US",
    };
  }

  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  @Get("health/ready")
  ready(): never {
    throw new ServiceUnavailableException({
      status: "unavailable",
      reason: "us_business_modules_not_ready",
    });
  }
}

/** Explicit US allowlist: no RU routes, auth adapters, jobs or outbound clients. */
@Module({})
export class UsDevelopmentModule {
  static register(runtime: UsRuntime): DynamicModule {
    return {
      module: UsDevelopmentModule,
      controllers: [UsDevelopmentController, UsProfileController],
      providers: [{ provide: UsRuntime, useValue: runtime }, UsSessionGuard],
    };
  }
}
