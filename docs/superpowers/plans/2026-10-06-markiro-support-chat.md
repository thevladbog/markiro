# Markiro Support Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Implement task-by-task, with an independent review after each task. Steps use checkbox syntax for tracking.

**Goal:** Реализовать приватный чат кабинета и ручную эскалацию в существующее обращение после подтверждения клиента.

**Architecture:** Markiro backend — единственная клиентская граница доступа к отдельному API inbox Chatwoot. PostgreSQL хранит identity mapping, согласия, связи обращений и импортированные сообщения; существующий pg-boss будит durable reconciliation. Кабинет не получает Chatwoot credentials, SaaS-admin инициирует предложение, Chatwoot остаётся интерфейсом ответа оператора.

**Tech Stack:** Существующие TypeScript/NestJS/Drizzle/PostgreSQL/pg-boss/Zod/React/TanStack Query/Vitest, Corepack pnpm и Node 24+. Установленный Chatwoot v4.17.0-ce; новая зависимость или изменение версии не входит в план.

**Spec:** `../specs/2026-10-06-markiro-support-chat-design.md`, согласована пользователем 2026-10-06.

Статус плана: для проверки пользователем. Метод исполнения уже выбран: отдельный исполнитель и проверка этапов. Никакие product tasks ещё не выполнены.

## Global Constraints

- Каждый read/send/consent проверяет действующую cabinet-session и актуальное членство.
- station/handheld API keys и platform-session не заменяют cabinet-session.
- Browser не выбирает Chatwoot account/inbox/contact/conversation ID.
- В браузер не передаются Chatwoot API key, contact source ID, widget JWT, pubsub token или HMAC secret.
- Прямые анонимные Client API этого inbox закрыты на внешней границе. До доказательства отсутствия обхода публикация чата запрещена.
- Первая версия: текст, максимум 2000 символов, опрос раз в 5 секунд в открытом чате; в скрытой вкладке опрос приостанавливается.
- Нет файлов в чате, typing, автоматической эскалации, автоматического закрытия/переоткрытия заявки или Twenty-дубликата.
- Полная публичная текстовая переписка переносится без внутренних заметок и молчаливого обрезания.
- Tenant reply сохраняет текущий clarification_required gate; импорт transcript не использует этот endpoint.
- Чат доступен всем действующим участникам; billing-доступ owner/admin не расширяется.
- RU/EN через существующий i18n, компоненты @markiro/ui, без hand-edit generatedClient.
- Production, общие DB и пользовательские .env не изменять; commit/push/PR/deploy — только при отдельном разрешении.

## Review Focus

1. Неоднозначный POST Chatwoot: сообщение могло сохраниться до таймаута; повтор не должен слепо посылать его ещё раз (Task 2).
2. Consent гоняется с membership revocation/изменением proposal: транзакция не должна разрешать перенос устаревшему principal (Task 3).
3. Imported private note может находиться между публичными сообщениями на границе страниц: cursor не должен потерять следующее публичное сообщение (Task 4).
4. Manager/member видит собственный status, но не billing detail, чужой transcript или коммерческие metadata (Tasks 3, 5).
5. Support enum попадает старому strict consumer: rollout сначала обновляет чтение всех потребителей, только затем включает создание support-заявок (Task 6).

## База, ограничения среды и рабочий журнал

Исследован `/Users/thevladbog/PRSOME/q` HEAD `d9dc626531a432588d6766201677db78879dce43`; его незакоммиченные изменения не включать и не чистить. Перед исполнением read-only сравнить эту базу с актуальной целевой веткой; если база существенно изменилась, показать различия до создания task worktree. Не считать исследованную task-ветку автоматически актуальным main.

- [ ] Получить файловые права только на task checkout и нужные docs, если sandbox не позволяет запись. Не запрашивать сетевые/production права для локальной разработки.
- [ ] Прочитать root/scoped AGENTS, skills using-git-worktrees и subagent-driven-development; создать изолированный managed worktree после проверки базы. Не запускать изменения в dirty primary checkout.
- [ ] Перенести spec/plan в `docs/superpowers/` task checkout через apply_patch, сохранив утверждённое содержимое. В `.superpowers/sdd/2026-10-06-markiro-support-chat/progress.md` фиксировать RED/GREEN, review, SHA базы, ограничения каждого этапа.
- [ ] На каждого исполнителя передавать обе спецификации интерфейсов своего этапа и зависимости, а не только краткое описание. Следующий этап начинается после исправления замечаний и проверки предыдущего; commit не обязателен и не разрешён этим планом.

## Зафиксированные интерфейсы между этапами

Новые имена ниже — проектируемые exports, не утверждение об их наличии в текущем коде.

```ts
type SupportOwner = { tenantId: string; userId: string };
type SupportMessage = {
  id: string;
  direction: "customer" | "operator";
  text: string;
  occurredAt: string;
  delivery: "pending" | "sent" | "uncertain" | "failed";
};
type SupportRequestRef = {
  id: string;
  number: string;
  status: BillingRequestStatus;
};
type SupportProposal = {
  id: string;
  revision: number;
  title: string;
  summary: string;
  noticeVersion: "support-transcript-v1";
  state: "pending" | "accepted" | "declined";
};
type SupportEpisodeView = {
  id: string;
  messages: SupportMessage[];
  nextCursor: string | null;
  proposal: SupportProposal | null;
  request: SupportRequestRef | null;
  sync: { state: "pending" | "healthy" | "error"; lastSyncedAt: string | null };
};
type SupportTranscriptPage = {
  items: SupportMessage[];
  nextCursor: string | null;
  sync: SupportEpisodeView["sync"];
};
```

`BillingRequestStatus` экспортировать из contracts как inferred type существующей status schema. Публичный `id` сообщения — локальный UUID; remote IDs остаются в server adapter и БД. Transcript выводит только delivery=sent и исходный timestamp.

Проектируемые routes:

| Domain          | Method/path                                                      | Input                                                            | Output / policy                      |
| --------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| Cabinet         | GET `/support-chat/episodes`                                     | cursor, limit 1..100                                             | собственные эпизоды, membership      |
| Cabinet         | POST `/support-chat/episodes`                                    | idempotencyKey UUID                                              | новый собственный эпизод, membership |
| Cabinet         | GET `/support-chat/episodes/:id`                                 | message cursor, limit 1..100                                     | SupportEpisodeView, ownership        |
| Cabinet         | POST `/support-chat/episodes/:id/messages`                       | text 1..2000, idempotencyKey                                     | SupportMessage, ownership            |
| Cabinet         | POST `/support-chat/episodes/:id/proposals/:proposalId/decision` | decision accept/decline, revision, noticeVersion, idempotencyKey | SupportEpisodeView, ownership        |
| Cabinet billing | GET `/billing/requests/:id/transcript`                           | cursor, limit 1..100                                             | SupportTranscriptPage, billing.read  |
| Platform        | GET `/platform/support-chat/episodes`                            | tenantId optional, cursor, limit                                 | operator summaries, billing.read     |
| Platform        | GET `/platform/support-chat/episodes/:id`                        | message cursor, limit                                            | public-message view, billing.read    |
| Platform        | POST `/platform/support-chat/episodes/:id/proposals`             | title 1..200, summary 1..4000, idempotencyKey                    | SupportProposal, billing.write       |
| Platform        | GET `/platform/billing/requests/:id/transcript`                  | cursor, limit                                                    | SupportTranscriptPage, billing.read  |

GET не создаёт удалённый contact/conversation. Кабинетным routes явно объявить read-only recovery subscription policy. Все response headers `Cache-Control: private, no-store`; наружу нет request description/events в ограниченном SupportRequestRef.

## Task 1: Schema и strict-контракты

**Files:** создать `packages/db/src/schema/support-chat.ts`, `packages/db/test/support-chat-schema.test.ts`, `packages/db/test/support-chat-migration.test.ts`, `packages/platform-contracts/src/support-chat.ts`, `packages/platform-contracts/test/support-chat.test.ts`. Изменить `packages/db/src/schema.ts`, `packages/db/drizzle.config.ts`, `packages/db/src/schema/tenant-billing.ts`, `packages/db/test/tenant-billing-schema.test.ts`, `packages/platform-contracts/src/index.ts`, `packages/platform-contracts/src/commercial.ts`. Новые migration SQL/snapshot/journal получать штатным Drizzle generation, номер выбирать по текущему journal; не резервировать 0166 без проверки.

**Produces:** schema exports `supportChatOwners`, `supportChatEpisodes`, `supportChatMessages`, `supportChatProposals`, `supportChatConsents`, `supportChatJobs`; contracts `supportChatContracts`, `platformSupportChatContracts`, `supportTranscriptContracts`, перечисленные выше types.

- [ ] RED: contract тест отвергает text='', text длиной 2001, remote IDs в body, неизвестные поля, invalid UUID, limit=101; проверяет SupportRequestRef не допускает description/events. Schema-тест требует enum support и tenant-composite FK на request/episode/owner.

```ts
expect(
  supportChatContracts.message.body.safeParse({
    text: "x",
    idempotencyKey: crypto.randomUUID(),
    conversationId: 123,
  }).success,
).toBe(false);
expect(schema.BILLING_REQUEST_TYPES).toContain("support");
expect(getTableConfig(schema.supportChatEpisodes).foreignKeys.length).toBeGreaterThan(0);
```

- [ ] Запустить `corepack pnpm --filter @markiro/platform-contracts exec vitest run test/support-chat.test.ts` и соответствующий DB schema test; подтвердить отсутствие новых exports как RED, не продолжать на случайном env/import failure.
- [ ] Реализовать schema/DTO: owner unique(tenant,user); episode local UUID + owner composite FK + immutable remote mapping; messages local UUID + unique(episode,idempotencyKey) + unique(account,inbox,conversation,remoteMessageId); proposal revision, operator identity и неизменяемый accepted payload; consent unique(proposal,revision); request link unique(episode), composite tenant FK. Jobs хранят attempt token, lease expiry, retries/nextAttemptAt и checkpoint. Nullable remote IDs не означают готовую identity.

```sql
-- Required invariants; express names in Drizzle and inspect generated SQL.
UNIQUE (tenant_id, user_id)
UNIQUE (tenant_id, episode_id, idempotency_key)
FOREIGN KEY (tenant_id, request_id)
  REFERENCES tenant_billing_requests (tenant_id, id)
```

- [ ] Schema exact-enum tests адаптировать намеренно, добавляя только support. Новый enum value не использовать в том же migration transaction для DML; existing rows не переписывать. Migration integration проверяет upgrade populated DB, сохранность old requests и невозможность foreign-tenant связей.
- [ ] GREEN: оба пакета test/typecheck/lint/build, migration DB gate без skips. Если isolated PostgreSQL недоступен, отметить blocker DB-proof, не считать этап полностью принятым. Reviewer проверяет constraints и строгие contracts.

## Task 2: Private gateway, Chatwoot adapter и durable отправка

**Files:** создать `apps/api/src/modules/support-chat/{support-chat.module.ts,support-chat.controller.ts,support-chat.service.ts,support-chat.repository.ts,chatwoot.client.ts,chatwoot-message.schema.ts,support-chat-delivery.service.ts}`; `apps/api/test/{support-chat-access.e2e.test.ts,chatwoot.client.test.ts,support-chat-delivery.test.ts}`. Изменить `apps/api/src/{app.module.ts,env.ts}` и `apps/api/test/subscription-route-inventory.test.ts`. При OpenAPI обновлении использовать generation command, не редактировать generated client вручную.

**Consumes:** Task 1 schema/contracts и действующие TenantGuard/AuthorizationGuard membership policy. **Produces:** `SupportChatService.list(owner,query)`, `create(owner,{idempotencyKey})`, `detail(owner,episodeId,query)`, `send(owner,episodeId,{text,idempotencyKey})`; `ChatwootClient.ensureConversation(episodeId)` и `listMessages(mapping,page)`/`sendMessage(mapping,intent)`; immutable server-only Mapping содержит accountId/inboxId/contactId/conversationId.

- [ ] RED: два пользователя одного тенанта, один пользователь двух тенантов, foreign episode, revoked membership, device key, platform-cookie вместо cabinet-cookie, read-only subscription. Использовать реальный Nest/guards с isolated DB и local HTTP fake upstream; тестовые utilities только в test/support/support-chat-fixture.ts, не в production.

```ts
const response = await customerB.get(`/support-chat/episodes/${episodeA.id}`);
expect(response.status).toBe(404);
expect(upstream.requests).toHaveLength(0);
```

- [ ] Запустить focused e2e/adapter tests и подтвердить RED по отсутствующему route/поведению. Создать fixture exports `createSupportChatFixture()` с isolated DB/auth, `customerA/customerB`, `upstream.requests` и cleanup; credential values не печатать.
- [ ] GREEN: guard principal → owner-scoped queries; parser допускает только known public text incoming/outgoing expected inbox/conversation. Контакт identifier стабилен для пары tenant/user, без email-based identity merge. Перед удалённой операцией durable intent, после неё persist mapping. Creation timeout не порождает второй contact/conversation без reconcile.
- [ ] Mock upstream возвращает private=true, activity type, HTML-only payload, foreign inbox, неверную message shape; ни один не попадает в SupportEpisodeView. Fetch timeout 10s, redirect disabled, configured trusted HTTPS origin, bearer/token redacted. Feature flag `SUPPORT_CHAT_ENABLED=false` по умолчанию; выключенный route fail-closed, никакого fallback website widget.
- [ ] RED/GREEN uncertain send: upstream сохраняет сообщение и обрывает ответ. Durable intent становится uncertain, повтор того же UUID возвращает ту же локальную запись и не посылает POST. В contract fixture подтвердить возможность correlation metadata на pinned API; если надёжный lookup отсутствует, сохранять uncertain и не resend автоматически, показывая ручную проверку оператору.

```ts
expect(first.delivery).toBe("uncertain");
expect(retry.id).toBe(first.id);
expect(upstream.messagePostCount).toBe(1);
```

- [ ] API focused tests + standard API gates. Reviewer отдельно проверяет fail-closed auth и отсутствие удалённых identifiers в response/логах.

## Task 3: Proposal, consent и атомарная эскалация

**Files:** создать `apps/api/src/modules/support-chat/{platform-support-chat.controller.ts,support-chat-proposals.service.ts,support-chat-escalation.service.ts}`, `apps/api/test/{support-chat-escalation.test.ts,support-chat-platform-access.e2e.test.ts}`; изменить module и `apps/api/test/{platform-route-contracts.ts,platform-contract-openapi.test.ts}`. TenantBillingRequestsService не вызывать вне нужной общей транзакции и не подменять platform actor tenant user.

**Consumes:** owner/episode mapping, strict contracts, PlatformPrincipal/capabilities, tenant audit/platform audit. **Produces:** `SupportChatProposalsService.propose(actor,episodeId,input)`; `SupportChatEscalationService.decide(owner,episodeId,proposalId,input)` → SupportEpisodeView и durable import job.

**Уточнение по результатам Task1 review:** в этом этапе дополнить `packages/db/src/schema/support-chat.ts`, новой additive migration, `packages/platform-contracts/src/support-chat.ts` и их тестами. Consent сохраняет `noticeText` и `noticeLocale`; тело decision требует `noticeLocale: 'ru' | 'en'`. Export `supportTranscriptNotice(locale)` возвращает неизменяемые version/locale/text из серверного и клиентского общего реестра. Клиент не присылает сам текст предупреждения. Для возможных старых фактов новые поля nullable без выдуманного backfill; новый insert guard требует оба поля и точное совпадение canonical notice для версии и языка. Новые записи append-only, существующие неизвестные notice facts не объявляются подтверждёнными.

```ts
const notice = supportTranscriptNotice("en");
await fixture.accept(proposal, { noticeLocale: "en" });
expect(await fixture.consent(proposal.id)).toMatchObject({
  noticeLocale: "en",
  noticeText: notice.text,
  noticeVersion: notice.version,
});
```

Task5 использует этот же export при показе предупреждения и передаёт выбранный язык в decision. Migration test отклоняет неизвестный locale, изменённый текст и изменение уже сохранённого notice; upgrade оставляет исторические nullable-поля неизвестными, а не подставляет фиктивный текст. `support-transcript-v1` RU-текст берётся дословно из spec, EN-перевод фиксируется в том же реестре и миграционном guard.

**Уточнение реализации защиты от отзыва оператора:** proposal хранит неизменяемый отсортированный набор UUID релевантных audit-фактов изменения доступа оператора, снятый под row lock. Acceptance сравнивает актуальный набор под тем же lock и проверяет текущие role/status/verified2FA. Не использовать JS/SQL timestamp как гарантию порядка отзыва/восстановления. Добавить nullable внутреннее поле и отдельную additive migration0179 после уже применённой0178, guard для новых proposal и сохранение исторического неизвестного NULL; старому pending proposal без snapshot нужно новое предложение. Accepted replay и отказ клиента от действующего proposal не требуют нового доступа прежнего оператора. Request decision noticeVersion — bounded непустая строка для service409 при несовпадении; canonical registry/response — literalv1. Включить shared operator-auth helper и regression tests с equal/older audit timestamp и реальными canonical actions.

- [ ] RED: proposal не создаёт request; decline не переносит ни одного сообщения; accept старой revision/noticeVersion отклоняется 409; чужой user/tenant 404; platform billing.read не разрешает proposal; обычная Chatwoot identity не разрешает platform route.

```ts
expect(await countRequests()).toBe(0);
await fixture.accept(proposal, { revision: proposal.revision - 1 });
expect(await countRequests()).toBe(0);
```

- [ ] Запустить focused escalation tests, зафиксировать RED. Затем locks в стабильном порядке: membership → episode → proposal; при accept повторно проверить membership в той же транзакции с блокировкой. Проверить актуальность инициировавшего platform principal/capability перед фактической эскалацией; revoked operator proposal нельзя завершать без нового предложения.
- [ ] Подтверждение атомарно записывает consent(version,text,summary,owner,operator,time), BR request(type=support), created event, separate audit facts и import job. Client — initiator/customer, operator — proposing platform actor; не приписывать клиенту billing.request, которого у manager/member нет. Request создаётся отдельной support-domain командой, не общим bypass guard.

```ts
const [a, b] = await Promise.all([fixture.accept(proposal), fixture.accept(proposal)]);
expect(a.request?.id).toBe(b.request?.id);
expect(await fixture.requestCount(episode.id)).toBe(1);
expect(await fixture.consentCount(proposal.id)).toBe(1);
```

- [ ] Отдельно проверить exact actor/tenant/action/target/outcome audit, ambiguous DB commit replay, simultaneous decline/accept, revoked membership и active proposal uniqueness. Retry с тем же key другим payload →409; accepted replay возвращает прежнюю ссылку без новых фактов.
- [ ] Manager/member получает только собственный BR номер/status через SupportRequestRef; GET billing request остаётся403. Standard API + DB-backed gates, independent review.

## Task 4: Durable transcript import и job repair

**Files:** создать `apps/api/src/modules/support-chat/{support-chat-sync.service.ts,support-chat-jobs.service.ts,support-chat-transcript.controller.ts}`, `apps/api/test/{support-chat-sync.test.ts,support-chat-jobs.test.ts,support-chat-transcript-access.e2e.test.ts}`; изменить `apps/api/src/jobs/jobs.module.ts`, tenant/platform route inventories. Использовать существующий PgBoss wakeup; PostgreSQL job row — lifecycle authority.

**Consumes:** `ChatwootClient.listMessages`, persistent proposal consent, request link и schema jobs. **Produces:** `SupportChatSyncService.run(jobId,attemptToken)`; `SupportChatJobsService.repairAndWake()`; transcript page readers с billing.read и tenant/platform trust domains.

**Ограниченные исправления по ревью предшествующих этапов:** cabinet episodeList также требует UUID cursor до DB query (same owner-scoped lookup сохраняется), как уже исправленный platform list; opaque message/transcript cursor не ограничивать UUID. Добавить actual route400 и positive pagination regression. Не запускать импорт при неизвестных исторических noticeText/locale: NULL не заменять сегодняшним текстом, показывать actionable error/operator review, не менять сохранённые факты. После genuinely accepted consent последующий отзыв доступа оператора не аннулирует исторический перенос. Финальный общий API/DB/contracts gate последней схемы выполняется в Task6; targeted/worker/access/static gates обязательны перед task-review.

- [ ] RED: remote история >4000 символов, несколько страниц, public/private/activity перемежаются; simulated restart перед cursor commit; re-read overlap; два конкурентных worker; expired lease; сообщение на границе страниц; callback/queue wakeup lost.

```ts
await fixture.runSync();
await fixture.restartWorker();
await fixture.runSync();
expect(await fixture.importedSourceIds()).toEqual(["101", "103", "105"]);
expect((await fixture.transcript()).items.map((x) => x.text).join("")).toContain(longPublicText);
expect(await fixture.requestStatus()).toBe("clarification_required");
```

- [ ] Запустить focused sync tests, подтвердить RED. Реализовать claim с attempt fence/lease 60s, heartbeat при длительной pagination; remote HTTP вне DB transaction. Upsert public messages и checkpoint в одной короткой транзакции с fence check. Canonical ordering `(original timestamp, remote ID)`, public pagination opaque cursor scoped to episode/request.
- [ ] Не доверять фильтру public при cursor advancement: checkpoint относится к fetched remote page, а insert только к public messages. Backfill consent snapshot до устойчивой source boundary; overlap recent pages для доставки с задержкой; full reconciliation периодически по retained episode history. Source deletion/edit не обещает синхронное удаление локальной истории: snapshot неизменяемый, при detected edit можно сохранять audited revision отдельно, не переписывая provenance молча.
- [ ] pg-boss tick раз в 30s обнаруживает due jobs; failure backoff 5s,10s,20s,… cap5min; после 12 подряд failures состояние error, дальнейшая проверка раз в15min и operator retry доступны. Success сбрасывает failure streak; jobs linked episode живут после завершения заявки, пока продолжается тот же эпизод. Queue send failure не теряет job row.
- [ ] Оформить предусмотренный operator retry как `POST /platform/support-chat/episodes/:id/retry-sync` с `billing.write`, strict пустым body и ответом `SupportEpisodeView`. Добавить общий `platformSupportChatContracts.retrySync`, OpenAPI/inventory и access tests. Команда только планирует import/reconciliation, не повторяет uncertain message POST; активную lease не крадёт, повторный вызов не создаёт дублирующий job. Зафиксировать точный operator audit и отклонение отозванного доступа. Task5 использует этот route для кнопки повторной синхронизации.
- [ ] Проверить private/foreign payload не сохраняется в transcript/metadata/logs; lost lease не коммитит cursor или healthy state. Snapshot неполон →pending/error, lastSyncedAt не утверждает completeness. Closed Chatwoot и completed/cancelled request не меняют друг друга.
- [ ] Подписанные storage URLs не используются для transcript. Access тестирует foreign request и manager/member denial; API/DB/job gates, independent review.

## Task 5: Cabinet и SaaS-admin UI

**Files:** создать `apps/admin/src/pages/support/{SupportChatPage.tsx,SupportConsentCard.tsx,api.ts}`, `apps/admin/test/{support-chat.test.tsx,support-chat-context.test.tsx,support-consent.test.tsx}`, `apps/saas-admin/src/pages/support/{SupportEpisodesPage.tsx,SupportEpisodePage.tsx,api.ts}`, `apps/saas-admin/test/support-episodes.test.tsx`. Изменить `apps/admin/src/{app.tsx,layout/AppShell.tsx,i18n/ru.json,i18n/en.json,pages/billing/RequestDetailPage.tsx}`, `apps/saas-admin/src/{app.tsx,layout/AppShell.tsx,i18n/ru.json,i18n/en.json,pages/billing-requests/BillingRequestsPage.tsx}`. Transcript UI выделить в небольшие компоненты, не расширять монолитный request workspace без необходимости.

**Consumes:** все strict DTO/routes Tasks1–4. **Produces:** кабинет route `/support`, SaaS-admin `/support` и `/support/:episodeId`; public transcript panels в existing request detail; RU/EN support type label на всех enum consumers.

- [ ] RED: отправка, pending/uncertain/error states, operator reply, consent accept/decline, скрытая вкладка stops polling, вкладка открыта polling5s, disconnected retry. Testing Library проверяет экранное поведение, не число mock вызовов вместо результата.

```tsx
expect(screen.getByText(/Переписка.*владельц/)).toBeVisible();
await user.click(screen.getByRole("button", { name: "Подтвердить перенос" }));
expect(await screen.findByText("BR-000001")).toBeVisible();
```

- [ ] Запустить новые component tests до реализации, подтвердить RED. Затем useActiveOrg + session user формируют query keys `(support,tenant,user,episode)`; switch/logout cancel+remove старые queries, generation guard предотвращает позднее rendering. UI не отправляет remote IDs и не хранит secrets в localStorage.
- [ ] Test deferred promise: открыть tenantA → switchB → resolveA; экран не содержит A message. Lost membership403 очищает messages/compose. Manager/member видит чат/status, но не billing-ссылку; owner/admin видит ссылку на detail.
- [ ] Operator billing.read открывает список/историю, billing.write даёт proposal; error/empty/loading keyboard accessible. «Новый вопрос» создаёт новый episode после явного действия; не переносит автоматически сообщения в старую заявку. Chatwoot link допустим только operator UI, не customer UI.
- [ ] Request detail transcript read-only, grouped author/time, пагинация и sync lag. Existing tenant reply condition clarification_required сохранён; transcript не становится обычными events. RU/EN длинный текст не ломает layout.
- [ ] Standard admin/saas-admin test/typecheck/lint/build; API-client contracts; browser verification с screenshots в обоих языках. Independent review UI/security, отсутствие browser proof обозначить явно.

## Task 6: Release gates и Fucina deployment package

**Files:** создать q `docs/operations/support-chat.md`, `tools/production-browser/support-chat-tests/{fixture.ts,support-chat.spec.ts}` с isolated seeded environment; интегрировать workspace/browser configuration по существующим production-browser patterns. В отдельном Fucina task checkout создать `docs/support-chat-api-inbox.md`, `tests/test_support_api_boundary.py`, пример конфигурации без secrets; определить actual compose/Caddy/env paths из актуальной Yandex ветки, не из старого sourcecraft-foundation worktree.

**Consumes:** предыдущие endpoints, feature flags и tested parser/worker. **Produces:** проверяемый release bundle + runbook; live deploy не входит в разрешение на локальную реализацию.

- [ ] RED: локальные boundary tests требуют запрета API inbox Client API read/create/send при сохранении website Sales routes и authenticated operator/server Application API. Test encoded path/query, trailing slash и alternative published public routes pinned Chatwoot; не полагаться на CORS или секретность inbox ID.
- [ ] Подготовить точечный matcher на actual API inbox identifier либо изолированный private ingress; если существующая Caddy topology не позволяет различать эти routes безопасно, boundary gate FAIL и чат остаётся disabled. Не закрывать Sales глобальным wildcard запретом.
- [ ] Runbook: server-only CHATWOOT_BASE_URL/ACCOUNT_ID/API_INBOX_ID/token secret, feature flag defaultoff, no callback/webhook requirement firstrelease. Application API workflow сверять с pinned source и официальным guide: https://www.chatwoot.com/hc/user-guide/articles/1677839703-how-to-create-an-api-channel-inbox . Inbox ID не назначать до actual creation, секретов нет в примере.
- [ ] Проверить redaction логов Caddy для нестандартных Chatwoot token headers в request/response (включая нормализованные api_access_token/access-token и aliases) на локальном Caddy с искусственными значениями. Текущий dirty main filter скрывает Authorization/Cookie/Set-Cookie, но этого недостаточно для custom token headers. Дополнить локальный deployment example/runbook, без чтения production logs или самостоятельной ротации credentials. До enable нужен отдельный live redaction gate; возможные старые логи/ротация требуют отдельного security review, факт утечки не утверждать.
- [ ] Enum rollout: migrate additive enum/tables → обновить API/contracts/admin/saas-admin readers с flagoff → smoke старых billing flows → configure new inbox/boundary → negative read/send probe → enable только после отдельного разрешения. Rollback flagoff и предыдущий совместимый reader; enum/table down/drop не выполнять, сохранённые заявки не терять.
- [ ] Browser isolated tests подтверждают tenant/user isolation, revocation, consent, full import и операторский reply; реальный live отрицательный probe — отдельный deployment gate и не заменяется unit test Caddy text.
- [ ] Проверить git diff --check, scoped standard gates всех изменённых пакетов, generated OpenAPI parity, subscription/platform inventories, production bundle contracts. Rootwide gates и graphify update запускать в task checkout, фиксируя unrelated failures/skips; no claim green при DB skips.
- [ ] Независимый whole-change review проверяет spec coverage, race/error paths, секреты и полный diff. Итог: список файлов, RED/GREEN/test counts, DB/browser/live status, deployment prerequisites. Не коммитить/пушить автоматически.

## Self-review и handoff

Spec coverage: schema/contracts Task1; per-request admission/identity/send Task2; consent/access/idempotent BR Task3; transcript/background recovery Task4; RU/EN/context UX Task5; direct API bypass/release Task6. Все пять Review Focus имеют владельца тестов. Ограничения текущего billing reply/status и attachment behavior явно сохраняются.

Единственная внешняя зависимость локальной реализации — воспроизводимый pinned Chatwoot API contract; отсутствие надёжной remote idempotency не маскируется retry. Реальный security admission и deployment остаются отдельными gates. Разрешения sandbox, isolated DB и browser installation проверяются перед использованием, не выводятся из наличия предыдущего запуска.

После подтверждения этого плана начать Task1 в изолированном checkout; назначить отдельного исполнителя и ревьюера, отчёт по первому этапу показать перед переходом к Task2. Ни одно checkbox здесь не отмечено как выполненная реализация.
