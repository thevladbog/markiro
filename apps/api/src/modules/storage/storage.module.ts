import { Global, Module, type DynamicModule } from "@nestjs/common";
import type { Env } from "../../env";
import { ObjectStorageService } from "./object-storage.service";

@Global()
@Module({})
export class StorageModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: StorageModule,
      providers: [
        {
          provide: ObjectStorageService,
          useFactory: () => new ObjectStorageService(env),
        },
      ],
      exports: [ObjectStorageService],
    };
  }
}
