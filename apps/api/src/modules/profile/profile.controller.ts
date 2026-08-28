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
import { ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodBody,
  ApiZodValidationError,
} from "../../lib/openapi";
import type { RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  avatarUrlOpenApiSchema,
  updateProfileSchema,
  userProfileOpenApiSchema,
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
@ApiCabinetAuth()
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Get()
  @ApiOperation({ summary: "Get the signed-in user's profile" })
  @ApiResponse({ status: 200, schema: userProfileOpenApiSchema })
  @ApiHttpErrors(401)
  getProfile(@Req() request: RequestWithTenant): Promise<UserProfileDto> {
    return this.profiles.getProfile(request.userId!);
  }

  @Patch()
  @ApiOperation({ summary: "Update the signed-in user's profile" })
  @ApiZodBody(updateProfileSchema)
  @ApiResponse({ status: 200, schema: userProfileOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 409)
  updateProfile(
    @Req() request: RequestWithTenant,
    @Body(new ZodValidationPipe(updateProfileSchema)) body: UpdateProfileDto,
  ): Promise<UserProfileDto> {
    return this.profiles.updateProfile(request.userId!, body);
  }

  @Post("avatar")
  @ApiOperation({ summary: "Upload a profile avatar" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["avatar"],
      properties: { avatar: { type: "string", format: "binary" } },
    },
  })
  @ApiResponse({ status: 201, schema: userProfileOpenApiSchema })
  @ApiHttpErrors(400, 401, 409, 413, 503)
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
  @ApiOperation({ summary: "Delete the profile avatar" })
  @ApiResponse({ status: 204, description: "The avatar is removed (idempotent)." })
  @ApiHttpErrors(401, 409)
  deleteAvatar(@Req() request: RequestWithTenant): Promise<void> {
    return this.profiles.deleteAvatar(request.userId!);
  }

  @Get("avatar-url")
  @ApiOperation({ summary: "Get a presigned avatar URL" })
  @ApiResponse({ status: 200, schema: avatarUrlOpenApiSchema })
  @ApiHttpErrors(401)
  getAvatarUrl(@Req() request: RequestWithTenant): Promise<AvatarUrlDto> {
    return this.profiles.getAvatarUrl(request.userId!);
  }
}
