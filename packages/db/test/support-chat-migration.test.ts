import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";
import { supportTranscriptNotice } from "../../platform-contracts/src/support-chat.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describe.skipIf(!databaseUrl)("support chat forward migration", () => {
  const databaseName = `markiro_support_chat_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  const oldRequestId = randomUUID();
  const episodeId = randomUUID();
  const ownerId = randomUUID();
  const historicalConsentId = randomUUID();
  const historicalProposalId = randomUUID();
  let created = false;
  let temporaryRoot = "";
  let preNoticeRoot = "";

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-support-chat-migration-"));
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: temporaryRoot,
      lastIncludedIndex: 176,
    });
    await runRuntimeMigrations({
      databaseUrl: scratchUrl.toString(),
      migrationsFolder: temporaryRoot,
      log: () => undefined,
    });
    await pool.query(`INSERT INTO organization (id, name, slug, created_at)
      VALUES ('support-a', 'Support A', 'support-a', now()),
             ('support-b', 'Support B', 'support-b', now())`);
    await pool.query(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('support-user', 'Support User', 'support-user@example.invalid', true, now(), now())`);
    await pool.query(
      `INSERT INTO tenant_billing_requests
      (id, tenant_id, number, type, description, idempotency_key, created_by_user_id)
      VALUES ($1, 'support-b', 'BR-SUPPORT-OLD', 'other', 'Existing request', $2, 'support-user')`,
      [oldRequestId, randomUUID()],
    );
    preNoticeRoot = await mkdtemp(join(tmpdir(), "markiro-support-chat-pre-notice-"));
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: preNoticeRoot,
      lastIncludedIndex: 177,
    });
    await runRuntimeMigrations({
      databaseUrl: scratchUrl.toString(),
      migrationsFolder: preNoticeRoot,
      log: () => undefined,
    });
    const historicalOwnerId = randomUUID();
    const historicalEpisodeId = randomUUID();
    await pool.query(
      `INSERT INTO platform_users (id, name, email, role, status) VALUES ('support-history-operator', 'History', 'history@example.invalid', 'platform_admin', 'active')`,
    );
    await pool.query(
      `INSERT INTO support_chat_owners (id, tenant_id, user_id) VALUES ($1, 'support-b', 'support-user')`,
      [historicalOwnerId],
    );
    await pool.query(
      `INSERT INTO support_chat_episodes (id, tenant_id, owner_id, creation_key) VALUES ($1, 'support-b', $2, $3)`,
      [historicalEpisodeId, historicalOwnerId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO support_chat_proposals (id, tenant_id, episode_id, revision, title, summary, operator_id, idempotency_key) VALUES ($1, 'support-b', $2, 1, 'History', 'Old consent', 'support-history-operator', $3)`,
      [historicalProposalId, historicalEpisodeId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO support_chat_consents (id, tenant_id, episode_id, proposal_id, revision, user_id, decision, notice_version, accepted_title, accepted_summary, operator_id, idempotency_key, snapshot_through) VALUES ($1, 'support-b', $2, $3, 1, 'support-user', 'accept', 'support-transcript-v1', 'History', 'Old consent', 'support-history-operator', $4, now())`,
      [historicalConsentId, historicalEpisodeId, historicalProposalId, randomUUID()],
    );
    await runRuntimeMigrations({
      databaseUrl: scratchUrl.toString(),
      migrationsFolder,
      log: () => undefined,
    });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    if (preNoticeRoot) await rm(preNoticeRoot, { recursive: true, force: true });
  });

  it("preserves a populated legacy request and adds the support type", async () => {
    const result = await pool.query(
      `SELECT type, description FROM tenant_billing_requests WHERE id = $1`,
      [oldRequestId],
    );
    expect(result.rows).toEqual([{ type: "other", description: "Existing request" }]);
    const enumResult = await pool.query(
      `SELECT unnest(enum_range(NULL::billing_request_type)) AS type`,
    );
    expect(enumResult.rows.map((row: { type: string }) => row.type)).toContain("support");
    const empty = await pool.query(
      `SELECT count(*)::int AS count FROM support_chat_episodes WHERE tenant_id = 'support-a'`,
    );
    expect(empty.rows).toEqual([{ count: 0 }]);
    const historical = await pool.query(
      `SELECT notice_locale, notice_text FROM support_chat_consents WHERE id = $1`,
      [historicalConsentId],
    );
    expect(historical.rows).toEqual([{ notice_locale: null, notice_text: null }]);
    const oldProposal = await pool.query(
      `SELECT operator_access_audit_ids FROM support_chat_proposals WHERE id = $1`,
      [historicalProposalId],
    );
    expect(oldProposal.rows).toEqual([{ operator_access_audit_ids: null }]);
  });

  it("rejects a foreign-tenant request link and duplicate owner", async () => {
    await pool.query(
      `INSERT INTO support_chat_owners (id, tenant_id, user_id)
      VALUES ($1, 'support-a', 'support-user')`,
      [ownerId],
    );
    await expect(
      pool.query(`INSERT INTO support_chat_owners (tenant_id, user_id)
      VALUES ('support-a', 'support-user')`),
    ).rejects.toMatchObject({ code: "23505" });
    await pool.query(
      `INSERT INTO support_chat_episodes (id, tenant_id, owner_id, creation_key)
      VALUES ($1, 'support-a', $2, $3)`,
      [episodeId, ownerId, randomUUID()],
    );
    await expect(
      pool.query(`UPDATE support_chat_episodes SET request_id = $1 WHERE id = $2`, [
        oldRequestId,
        episodeId,
      ]),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "support_chat_episodes_tenant_request_fk",
    });
  });

  it("cannot reassign established contact or conversation identity without messages", async () => {
    await pool.query(
      `UPDATE support_chat_owners
      SET remote_contact_id = 'contact-1', remote_contact_source_id = 'source-1'
      WHERE id = $1`,
      [ownerId],
    );
    await expect(
      pool.query(
        `UPDATE support_chat_owners
      SET remote_contact_id = 'contact-2', remote_contact_source_id = 'source-2'
      WHERE id = $1`,
        [ownerId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      `UPDATE support_chat_episodes
      SET remote_account_id = 1, remote_inbox_id = 2, remote_conversation_id = 3
      WHERE id = $1`,
      [episodeId],
    );
    await expect(
      pool.query(
        `UPDATE support_chat_episodes
      SET remote_conversation_id = 4 WHERE id = $1`,
        [episodeId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `UPDATE support_chat_episodes
      SET remote_account_id = NULL, remote_inbox_id = NULL, remote_conversation_id = NULL
      WHERE id = $1`,
        [episodeId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects consent for a mismatched episode or proposal revision", async () => {
    const operatorId = "support-platform-operator";
    await pool.query(
      `INSERT INTO platform_users (id, name, email, role, status)
      VALUES ($1, 'Support Operator', 'support-operator@example.invalid', 'platform_admin', 'active')`,
      [operatorId],
    );
    await pool.query(`INSERT INTO platform_users (id, name, email, role, status)
      VALUES ('support-other-operator', 'Other Operator', 'support-other@example.invalid', 'platform_admin', 'active')`);
    const otherEpisodeId = randomUUID();
    await pool.query(
      `INSERT INTO support_chat_episodes (id, tenant_id, owner_id, creation_key)
      VALUES ($1, 'support-a', $2, $3)`,
      [otherEpisodeId, ownerId, randomUUID()],
    );
    const proposalId = randomUUID();
    await expect(
      pool.query(
        `INSERT INTO support_chat_proposals
      (tenant_id, episode_id, revision, title, summary, operator_id, idempotency_key)
      VALUES ('support-a', $1, 1, 'Help', 'Summary', $2, $3)`,
        [episodeId, operatorId, randomUUID()],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "support_chat_proposals_access_snapshot",
    });
    await pool.query(
      `INSERT INTO support_chat_proposals
      (id, tenant_id, episode_id, revision, title, summary, operator_id, operator_access_audit_ids, idempotency_key)
      VALUES ($1, 'support-a', $2, 1, 'Help', 'Summary', $3, '[]'::jsonb, $4)`,
      [proposalId, episodeId, operatorId, randomUUID()],
    );
    const insertConsent = (
      linkedEpisodeId: string,
      revision: number,
      title = "Help",
      summary = "Summary",
      actor = operatorId,
    ) =>
      pool.query(
        `INSERT INTO support_chat_consents
      (tenant_id, episode_id, proposal_id, revision, user_id, decision,
       notice_version, notice_locale, notice_text, accepted_title, accepted_summary, operator_id, idempotency_key, snapshot_through)
      VALUES ('support-a', $1, $2, $3, 'support-user', 'accept',
       'support-transcript-v1', 'ru', $8, $4, $5, $6, $7, now())`,
        [
          linkedEpisodeId,
          proposalId,
          revision,
          title,
          summary,
          actor,
          randomUUID(),
          supportTranscriptNotice("ru").text,
        ],
      );
    await expect(insertConsent(otherEpisodeId, 1)).rejects.toMatchObject({
      code: "23503",
      constraint: "support_chat_consents_tenant_proposal_fk",
    });
    await expect(insertConsent(episodeId, 2)).rejects.toMatchObject({
      code: "23503",
      constraint: "support_chat_consents_tenant_proposal_fk",
    });
    for (const [title, summary, actor] of [
      ["Altered", "Summary", operatorId],
      ["Help", "Altered", operatorId],
      ["Help", "Summary", "support-other-operator"],
    ]) {
      await expect(insertConsent(episodeId, 1, title, summary, actor)).rejects.toMatchObject({
        code: "23514",
      });
    }
    await expect(
      pool.query(
        `INSERT INTO support_chat_consents
      (tenant_id, episode_id, proposal_id, revision, user_id, decision,
       notice_version, notice_locale, notice_text, accepted_title, accepted_summary, operator_id, idempotency_key, snapshot_through)
      VALUES ('support-a', $1, $2, 1, 'support-user', 'accept',
       'support-transcript-v1', 'de', 'altered', 'Help', 'Summary', $3, $4, now())`,
        [episodeId, proposalId, operatorId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO support_chat_consents
      (tenant_id, episode_id, proposal_id, revision, user_id, decision,
       notice_version, notice_locale, notice_text, accepted_title, accepted_summary, operator_id, idempotency_key, snapshot_through)
      VALUES ('support-a', $1, $2, 1, 'support-user', 'accept',
       'support-transcript-v1', 'ru', 'altered', 'Help', 'Summary', $3, $4, now())`,
        [episodeId, proposalId, operatorId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await insertConsent(episodeId, 1);
    const [notice] = (
      await pool.query(
        `SELECT notice_locale, notice_text FROM support_chat_consents WHERE proposal_id = $1`,
        [proposalId],
      )
    ).rows;
    expect(notice).toEqual({
      notice_locale: "ru",
      notice_text: supportTranscriptNotice("ru").text,
    });
    await expect(
      pool.query(
        `UPDATE support_chat_consents SET notice_text = 'altered' WHERE proposal_id = $1`,
        [proposalId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(insertConsent(episodeId, 1)).rejects.toMatchObject({
      code: "23505",
      constraint: "support_chat_consents_proposal_revision_uq",
    });
    for (const update of [
      `accepted_title = 'Altered'`,
      `accepted_summary = 'Altered'`,
      `operator_id = 'support-other-operator'`,
      `decision = 'decline'`,
      `snapshot_through = now() + interval '1 hour'`,
    ]) {
      await expect(
        pool.query(`UPDATE support_chat_consents SET ${update} WHERE proposal_id = $1`, [
          proposalId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    }
    await expect(
      pool.query(`DELETE FROM support_chat_consents WHERE proposal_id = $1`, [proposalId]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(`UPDATE support_chat_proposals SET title = 'Altered' WHERE id = $1`, [proposalId]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `UPDATE support_chat_proposals SET operator_access_audit_ids = '["${randomUUID()}"]'::jsonb WHERE id = $1`,
        [proposalId],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "support_chat_proposals_facts_immutable",
    });
    const transition = await pool.query(
      `UPDATE support_chat_proposals SET state = 'accepted', decided_at = now()
       WHERE id = $1 RETURNING state, decided_at IS NOT NULL AS decided`,
      [proposalId],
    );
    expect(transition.rows).toEqual([{ state: "accepted", decided: true }]);
  });

  it("accepts complete long public text and rejects a mismatched remote conversation", async () => {
    await pool.query(
      `UPDATE support_chat_episodes SET remote_account_id = 1,
      remote_inbox_id = 2, remote_conversation_id = 3 WHERE id = $1`,
      [episodeId],
    );
    const send = (conversationId: number, remoteMessageId: number) =>
      pool.query(
        `INSERT INTO support_chat_messages
      (tenant_id, episode_id, direction, text, occurred_at, delivery,
       remote_account_id, remote_inbox_id, remote_conversation_id, remote_message_id)
      VALUES ('support-a', $1, 'operator', $2, now(), 'sent', 1, 2, $3, $4)`,
        [episodeId, "x".repeat(4_001), conversationId, remoteMessageId],
      );
    await expect(send(4, 51)).rejects.toMatchObject({
      code: "23503",
      constraint: "support_chat_messages_remote_episode_fk",
    });
    await send(3, 51);
    await expect(send(3, 51)).rejects.toMatchObject({
      code: "23505",
      constraint: "support_chat_messages_remote_uq",
    });
    const result = await pool.query(
      `SELECT char_length(text) AS length FROM support_chat_messages WHERE remote_message_id = 51`,
    );
    expect(result.rows).toEqual([{ length: 4_001 }]);
  });

  it("rejects a job referencing a message in another episode of the same tenant", async () => {
    const otherEpisodeId = randomUUID();
    const messageId = randomUUID();
    await pool.query(
      `INSERT INTO support_chat_episodes (id, tenant_id, owner_id, creation_key)
      VALUES ($1, 'support-a', $2, $3)`,
      [otherEpisodeId, ownerId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO support_chat_messages
      (id, tenant_id, episode_id, direction, text, occurred_at, delivery)
      VALUES ($1, 'support-a', $2, 'customer', 'hello', now(), 'pending')`,
      [messageId, otherEpisodeId],
    );
    await expect(
      pool.query(
        `INSERT INTO support_chat_jobs (tenant_id, episode_id, kind, message_id)
      VALUES ('support-a', $1, 'send', $2)`,
        [episodeId, messageId],
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "support_chat_jobs_tenant_message_fk",
    });
  });
});
