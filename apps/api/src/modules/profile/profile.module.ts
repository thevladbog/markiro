import { Module } from "@nestjs/common";
import { MediaModule } from "../media/media.module";
import { ProfileController } from "./profile.controller";
import { ProfileService } from "./profile.service";
import { ProfileSessionGuard } from "./profile-session.guard";

@Module({
  imports: [MediaModule],
  controllers: [ProfileController],
  providers: [ProfileService, ProfileSessionGuard],
  exports: [ProfileService],
})
export class ProfileModule {}
