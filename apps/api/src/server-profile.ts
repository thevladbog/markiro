import { Global, GoneException, Module, type DynamicModule } from "@nestjs/common";
export type ServerProfile = "legacy" | "platform-only";
export const SERVER_PROFILE = Symbol("SERVER_PROFILE");
export function assertLegacyOperation(profile: ServerProfile): void {
  if (profile === "platform-only") throw new GoneException({ code: "server_profile_disabled" });
}
@Global()
@Module({})
export class ServerProfileModule {
  static forRoot(profile: ServerProfile): DynamicModule {
    return {
      module: ServerProfileModule,
      providers: [{ provide: SERVER_PROFILE, useValue: profile }],
      exports: [SERVER_PROFILE],
    };
  }
}
