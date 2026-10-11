import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

const foreignKeys = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).foreignKeys.map((key) => key.getName());
const uniqueConstraints = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).uniqueConstraints.map((key) => key.name);

describe("support chat schema", () => {
  it("extends billing type without changing existing values", () => {
    expect(schema.BILLING_REQUEST_TYPES).toEqual([
      "renewal",
      "capacity_change",
      "additional_service",
      "documents",
      "other",
      "support",
    ]);
  });

  it("ties every episode to a tenant-owned user channel", () => {
    expect(uniqueConstraints(schema.supportChatOwners)).toContain(
      "support_chat_owners_tenant_user_uq",
    );
    expect(foreignKeys(schema.supportChatEpisodes)).toContain(
      "support_chat_episodes_tenant_owner_fk",
    );
    expect(uniqueConstraints(schema.supportChatEpisodes)).toContain(
      "support_chat_episodes_tenant_id_uq",
    );
  });

  it("deduplicates local sends and remote public messages", () => {
    expect(foreignKeys(schema.supportChatMessages)).toContain(
      "support_chat_messages_tenant_episode_fk",
    );
    expect(foreignKeys(schema.supportChatMessages)).toContain(
      "support_chat_messages_remote_episode_fk",
    );
    expect(uniqueConstraints(schema.supportChatMessages)).toContain(
      "support_chat_messages_tenant_episode_key_uq",
    );
    expect(uniqueConstraints(schema.supportChatMessages)).toContain(
      "support_chat_messages_remote_uq",
    );
  });

  it("enforces tenant-bound proposals, consents, and request linkage", () => {
    expect(foreignKeys(schema.supportChatProposals)).toContain(
      "support_chat_proposals_tenant_episode_fk",
    );
    expect(foreignKeys(schema.supportChatConsents)).toContain(
      "support_chat_consents_tenant_proposal_fk",
    );
    expect(uniqueConstraints(schema.supportChatProposals)).toContain(
      "support_chat_proposals_tenant_episode_revision_id_uq",
    );
    expect(uniqueConstraints(schema.supportChatConsents)).toContain(
      "support_chat_consents_proposal_revision_uq",
    );
    expect(foreignKeys(schema.supportChatEpisodes)).toContain(
      "support_chat_episodes_tenant_request_fk",
    );
    expect(uniqueConstraints(schema.supportChatEpisodes)).toContain(
      "support_chat_episodes_request_uq",
    );
  });

  it("stores fenced, retryable sync jobs", () => {
    expect(schema.supportChatJobs.attemptToken).toBeDefined();
    expect(schema.supportChatJobs.leaseExpiresAt).toBeDefined();
    expect(schema.supportChatJobs.retryCount).toBeDefined();
    expect(schema.supportChatJobs.nextAttemptAt).toBeDefined();
    expect(schema.supportChatJobs.checkpoint).toBeDefined();
    expect(foreignKeys(schema.supportChatJobs)).toContain("support_chat_jobs_tenant_episode_fk");
  });
});
