import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { ApiBody, ApiConsumes, ApiTags } from "@nestjs/swagger";
import type { RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  updateProfileSchema,
  type AvatarUrlDto,
  type UpdateProfileDto,
  type UserProfileDto,
} from "./dto";
import { ProfileService } from "./profile.service";
import { ProfileSessionGuard } from "./profile-session.guard";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

@ApiTags("profile")
@Controller("profile")
@UseGuards(ProfileSessionGuard)
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Get()
  getProfile(@Req() request: RequestWithTenant): Promise<UserProfileDto> {
    return this.profiles.getProfile(request.userId!);
  }

  @Patch()
  updateProfile(
    @Req() request: RequestWithTenant,
    @Body(new ZodValidationPipe(updateProfileSchema)) body: UpdateProfileDto,
  ): Promise<UserProfileDto> {
    return this.profiles.updateProfile(request.userId!, body);
  }

  @Post("avatar")
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["avatar"],
      properties: { avatar: { type: "string", format: "binary" } },
    },
  })
  @UseInterceptors(
    FileInterceptor("avatar", {
      storage: memoryStorage(),
      limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
    }),
  )
  uploadAvatar(
    @Req() request: RequestWithTenant,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<UserProfileDto> {
    if (!file) throw new BadRequestException("Avatar file is required");
    return this.profiles.uploadAvatar(request.userId!, file.buffer);
  }

  @Delete("avatar")
  @HttpCode(204)
  deleteAvatar(@Req() request: RequestWithTenant): Promise<void> {
    return this.profiles.deleteAvatar(request.userId!);
  }

  @Get("avatar-url")
  getAvatarUrl(@Req() request: RequestWithTenant): Promise<AvatarUrlDto> {
    return this.profiles.getAvatarUrl(request.userId!);
  }
}
