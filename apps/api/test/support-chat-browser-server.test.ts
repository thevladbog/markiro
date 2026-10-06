import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { expect, it } from "vitest";
import { createSupportChatFixture } from "./support/support-chat-fixture";
import { SupportChatSyncService } from "../src/modules/support-chat/support-chat-sync.service";

it.skipIf(!process.env.SUPPORT_CHAT_BROWSER_CONTROL_DIR)(
  "serves the isolated support browser journey until its parent closes it",
  async () => {
    const control = process.env.SUPPORT_CHAT_BROWSER_CONTROL_DIR;
    if (
      !control ||
      process.env.SUPPORT_CHAT_ISOLATED_DB !== "1" ||
      process.env.SUPPORT_CHAT_TEST_MAINTENANCE_URL !==
        "postgresql://postgres@127.0.0.1:40061/postgres"
    ) {
      throw new Error("Browser fixture requires its own explicit local control directory and DB");
    }
    const adminPort = Number(process.env.SUPPORT_CHAT_BROWSER_ADMIN_PORT);
    const platformPort = Number(process.env.SUPPORT_CHAT_BROWSER_PLATFORM_PORT);
    if (
      !Number.isInteger(adminPort) ||
      !Number.isInteger(platformPort) ||
      adminPort < 1024 ||
      platformPort < 1024 ||
      adminPort > 65535 ||
      platformPort > 65535 ||
      adminPort === platformPort
    )
      throw new Error("Invalid local browser ports");
    const fixture = await createSupportChatFixture({
      adminOrigin: `http://localhost:${adminPort}`,
      platformOrigin: `http://localhost:${platformPort}`,
    });
    try {
      const address = fixture.app.getHttpServer().address();
      if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
        throw new Error("API fixture must listen on loopback");
      }
      await writeFile(join(control, "ready.json"), JSON.stringify({ port: address.port }));
      let remoteMessageSequence = 10_000;
      const remoteTimeBase = Math.floor(Date.now() / 1_000) - 3_600;
      while (!existsSync(join(control, "stop"))) {
        const requestPath = join(control, "platform-role-request.json");
        if (existsSync(requestPath)) {
          const raw = await readFile(requestPath, "utf8");
          const parsed = JSON.parse(raw) as { userId: string; nonce: string };
          if (
            !/^[A-Za-z0-9_-]{8,128}$/.test(parsed.userId) ||
            !/^[0-9a-f-]{36}$/i.test(parsed.nonce)
          ) {
            throw new Error("Invalid test-only platform role request");
          }
          const changed = await fixture.db
            .update(schema.platformUsers)
            .set({ status: "active", role: "platform_admin" })
            .where(eq(schema.platformUsers.id, parsed.userId))
            .returning({ id: schema.platformUsers.id });
          expect(changed).toHaveLength(1);
          await unlink(requestPath);
          await writeFile(join(control, `platform-role-ack-${parsed.nonce}`), "1");
        }
        const commandPath = join(control, "support-command.json");
        if (existsSync(commandPath)) {
          const parsed = JSON.parse(await readFile(commandPath, "utf8")) as {
            nonce: string;
            kind: "addMember" | "revokeMember" | "seedRemote" | "sync" | "failNextRead";
            tenantId?: string;
            userId?: string;
            episodeId?: string;
            messages?: Array<{ text: string; private: boolean; activity?: boolean }>;
          };
          const uuid = /^[0-9a-f-]{36}$/i;
          if (!uuid.test(parsed.nonce)) throw new Error("Invalid browser command nonce");
          if (parsed.kind === "addMember" && parsed.tenantId && parsed.userId) {
            await fixture.db.insert(schema.member).values({
              id: randomUUID(),
              organizationId: parsed.tenantId,
              userId: parsed.userId,
              role: "member",
              createdAt: new Date(),
            });
          } else if (parsed.kind === "revokeMember" && parsed.tenantId && parsed.userId) {
            await fixture.db
              .delete(schema.member)
              .where(
                and(
                  eq(schema.member.organizationId, parsed.tenantId),
                  eq(schema.member.userId, parsed.userId),
                ),
              );
          } else if (parsed.kind === "seedRemote" && parsed.episodeId && parsed.messages) {
            const [episode] = await fixture.db
              .select()
              .from(schema.supportChatEpisodes)
              .where(eq(schema.supportChatEpisodes.id, parsed.episodeId));
            if (!episode?.remoteConversationId) throw new Error("Mapped episode required");
            for (const message of parsed.messages) {
              const remoteId = remoteMessageSequence++;
              fixture.upstream.addMessage({
                id: remoteId,
                conversation_id: episode.remoteConversationId,
                inbox_id: 17,
                content: message.text,
                content_type: "text",
                message_type: message.activity ? 2 : 1,
                private: message.private,
                created_at: remoteTimeBase + remoteId - 10_000,
                source_id: null,
              });
            }
          } else if (parsed.kind === "failNextRead") {
            fixture.upstream.failMessageListAfter(0);
          } else if (parsed.kind === "sync" && parsed.episodeId) {
            const [job] = await fixture.db
              .select()
              .from(schema.supportChatJobs)
              .where(
                and(
                  eq(schema.supportChatJobs.episodeId, parsed.episodeId),
                  eq(schema.supportChatJobs.kind, "import"),
                ),
              );
            if (!job) throw new Error("Import job required");
            await fixture.app.get(SupportChatSyncService).run(job.id, randomUUID());
          } else {
            throw new Error("Unsupported browser command");
          }
          await unlink(commandPath);
          await writeFile(join(control, `support-command-ack-${parsed.nonce}`), "1");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      await fixture.cleanup();
    }
  },
  600_000,
);
