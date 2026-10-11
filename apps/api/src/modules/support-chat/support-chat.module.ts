import { Module, type DynamicModule } from "@nestjs/common";
import type { Env } from "../../env";
import { ChatwootClient, CHATWOOT_CONFIG, chatwootConfigFromEnv } from "./chatwoot.client";
import { SupportChatController } from "./support-chat.controller";
import { SupportChatDeliveryService } from "./support-chat-delivery.service";
import { SupportChatRepository } from "./support-chat.repository";
import { SupportChatService, SUPPORT_CHAT_ENABLED } from "./support-chat.service";
import { PlatformSupportChatController } from "./platform-support-chat.controller";
import { SupportChatProposalsService } from "./support-chat-proposals.service";
import { SupportChatEscalationService } from "./support-chat-escalation.service";
import { SupportChatSyncService } from "./support-chat-sync.service";
import { SupportChatJobsService } from "./support-chat-jobs.service";
import {
  SupportChatTranscriptController,
  PlatformSupportChatTranscriptController,
  SupportChatTranscriptReader,
} from "./support-chat-transcript.controller";

@Module({})
export class SupportChatModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: SupportChatModule,
      controllers: [
        SupportChatController,
        PlatformSupportChatController,
        SupportChatTranscriptController,
        PlatformSupportChatTranscriptController,
      ],
      providers: [
        SupportChatRepository,
        ChatwootClient,
        SupportChatDeliveryService,
        SupportChatService,
        SupportChatProposalsService,
        SupportChatEscalationService,
        SupportChatSyncService,
        SupportChatJobsService,
        SupportChatTranscriptReader,
        { provide: SUPPORT_CHAT_ENABLED, useValue: env.SUPPORT_CHAT_ENABLED },
        { provide: CHATWOOT_CONFIG, useValue: chatwootConfigFromEnv(env) },
      ],
      exports: [SupportChatSyncService, SupportChatJobsService],
    };
  }
}
