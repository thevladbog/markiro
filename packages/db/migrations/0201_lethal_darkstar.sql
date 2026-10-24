CREATE TABLE "release_catalog_channel_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product" text NOT NULL,
	"channel" text NOT NULL,
	"expected_revision" bigint NOT NULL,
	"revision" bigint NOT NULL,
	"previous_publication_id" uuid,
	"publication_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"receipt_id" uuid NOT NULL,
	"pointer" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rc_event_revision_uq" UNIQUE("product","channel","revision"),
	CONSTRAINT "rc_event_shape_ck" CHECK ("release_catalog_channel_events"."expected_revision">=0 and "release_catalog_channel_events"."expected_revision"<9223372036854775807 and "release_catalog_channel_events"."revision"="release_catalog_channel_events"."expected_revision"+1 and "release_catalog_channel_events"."kind" in ('forward','rollback') and jsonb_typeof("release_catalog_channel_events"."pointer")='object')
);
--> statement-breakpoint
CREATE TABLE "release_catalog_channels" (
	"product" text NOT NULL,
	"channel" text NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"publication_id" uuid,
	"readable" boolean DEFAULT false NOT NULL,
	CONSTRAINT "release_catalog_channels_product_channel_pk" PRIMARY KEY("product","channel"),
	CONSTRAINT "rc_channel_shape_ck" CHECK ("release_catalog_channels"."product" in ('station','handheld','standalone','signer') and "release_catalog_channels"."channel" in ('beta','stable') and ("release_catalog_channels"."product"<>'signer' or "release_catalog_channels"."channel"='stable') and "release_catalog_channels"."revision">=0 and (("release_catalog_channels"."revision"=0 and "release_catalog_channels"."publication_id" is null) or ("release_catalog_channels"."revision">0 and "release_catalog_channels"."publication_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "release_catalog_epochs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product" text NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rc_epochs_scope_uq" UNIQUE("id","product","channel"),
	CONSTRAINT "rc_epochs_scope_ck" CHECK ("release_catalog_epochs"."product" in ('station','handheld','standalone','signer') and "release_catalog_epochs"."channel" in ('beta','stable') and ("release_catalog_epochs"."product"<>'signer' or "release_catalog_epochs"."channel"='stable'))
);
--> statement-breakpoint
CREATE TABLE "release_catalog_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"epoch_id" uuid NOT NULL,
	"owner_fingerprint" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"product" text NOT NULL,
	"channel" text NOT NULL,
	"version" text NOT NULL,
	"request" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rc_intent_owner_key_uq" UNIQUE("owner_fingerprint","idempotency_key"),
	CONSTRAINT "rc_intent_version_uq" UNIQUE("product","channel","version"),
	CONSTRAINT "rc_intent_scope_uq" UNIQUE("id","product","channel","version"),
	CONSTRAINT "rc_intent_shape_ck" CHECK ("release_catalog_intents"."owner_fingerprint" ~ '^[0-9a-f]{64}$' and "release_catalog_intents"."request_digest" ~ '^[0-9a-f]{64}$' and "release_catalog_intents"."version" ~ '^[0-9][0-9A-Za-z.+-]{0,127}$' and jsonb_typeof("release_catalog_intents"."request")='object' and "release_catalog_intents"."state" in ('pending','verified','committed','failed'))
);
--> statement-breakpoint
CREATE TABLE "release_catalog_objects" (
	"public_path" text PRIMARY KEY NOT NULL,
	"publication_id" uuid NOT NULL,
	"product" text NOT NULL,
	"channel" text NOT NULL,
	"version" text NOT NULL,
	"name" text NOT NULL,
	"bucket" text NOT NULL,
	"key" text NOT NULL,
	"version_id" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_type" text NOT NULL,
	CONSTRAINT "rc_object_path_ck" CHECK ("release_catalog_objects"."name" ~ '^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$' and "release_catalog_objects"."public_path" = '/' || "release_catalog_objects"."product" || '/' || "release_catalog_objects"."channel" || case when "release_catalog_objects"."product"='standalone' then '' else '/releases' end || '/' || "release_catalog_objects"."version" || '/' || "release_catalog_objects"."name"),
	CONSTRAINT "rc_object_shape_ck" CHECK ("release_catalog_objects"."sha256" ~ '^[0-9a-f]{64}$' and "release_catalog_objects"."size_bytes" between 1 and 536870912 and "release_catalog_objects"."bucket" ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' and left("release_catalog_objects"."key",length("release_catalog_objects"."product")+1)="release_catalog_objects"."product" || '/' and octet_length("release_catalog_objects"."key") between 1 and 1024 and octet_length("release_catalog_objects"."version_id") between 1 and 1024 and lower(btrim("release_catalog_objects"."version_id"))<>'null' and btrim("release_catalog_objects"."version_id")<>'' and "release_catalog_objects"."version_id" !~ '[[:cntrl:]]' and "release_catalog_objects"."content_type" in ('application/octet-stream','application/zip','application/json','application/vnd.android.package-archive','text/plain','text/plain; charset=utf-8','text/markdown'))
);
--> statement-breakpoint
CREATE TABLE "release_catalog_oidc_bindings" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"intent_id" uuid NOT NULL,
	"principal_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rc_oidc_hash_ck" CHECK ("release_catalog_oidc_bindings"."token_hash" ~ '^[0-9a-f]{64}$' and "release_catalog_oidc_bindings"."principal_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "release_catalog_publications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"intent_id" uuid NOT NULL,
	"product" text NOT NULL,
	"channel" text NOT NULL,
	"version" text NOT NULL,
	"request_digest" text NOT NULL,
	"source_sha" text NOT NULL,
	"file_count" integer NOT NULL,
	"metadata" jsonb NOT NULL,
	"receipt_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rc_publication_intent_uq" UNIQUE("intent_id"),
	CONSTRAINT "rc_publication_version_uq" UNIQUE("product","channel","version"),
	CONSTRAINT "rc_publication_scope_uq" UNIQUE("id","product","channel"),
	CONSTRAINT "rc_publication_file_scope_uq" UNIQUE("id","product","channel","version"),
	CONSTRAINT "rc_publication_shape_ck" CHECK ("release_catalog_publications"."request_digest" ~ '^[0-9a-f]{64}$' and "release_catalog_publications"."source_sha" ~ '^[0-9a-f]{40}$' and "release_catalog_publications"."file_count" between 1 and 16 and jsonb_typeof("release_catalog_publications"."metadata")='object')
);
--> statement-breakpoint
CREATE TABLE "release_catalog_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"sha256" text NOT NULL,
	"ledger_key" text NOT NULL,
	"ledger_version_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rc_receipt_shape_ck" CHECK ("release_catalog_receipts"."kind" in ('publication','reservation','channel','confirmation') and "release_catalog_receipts"."sha256" ~ '^[0-9a-f]{64}$' and "release_catalog_receipts"."ledger_key" = '_publication-ledger/' || "release_catalog_receipts"."id"::text || '.json' and octet_length("release_catalog_receipts"."ledger_version_id") between 1 and 1024 and lower(btrim("release_catalog_receipts"."ledger_version_id")) <> 'null' and "release_catalog_receipts"."ledger_version_id" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
CREATE TABLE "release_catalog_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product" text NOT NULL,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"version" text,
	"public_path" text,
	"upper_bound" text,
	"request_digest" text,
	"receipt_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rc_reservation_scope_ck" CHECK ("release_catalog_reservations"."product" in ('station','handheld','standalone','signer') and "release_catalog_reservations"."channel" in ('beta','stable') and ("release_catalog_reservations"."product"<>'signer' or "release_catalog_reservations"."channel"='stable')),
	CONSTRAINT "rc_reservation_shape_ck" CHECK (("release_catalog_reservations"."kind"='path' and "release_catalog_reservations"."public_path" is not null and "release_catalog_reservations"."version" is not null and "release_catalog_reservations"."upper_bound" is null) or ("release_catalog_reservations"."kind"='version' and "release_catalog_reservations"."public_path" is null and "release_catalog_reservations"."version" is not null and "release_catalog_reservations"."upper_bound" is null) or ("release_catalog_reservations"."kind"='range' and "release_catalog_reservations"."public_path" is null and "release_catalog_reservations"."version" is null and "release_catalog_reservations"."upper_bound" is not null) or ("release_catalog_reservations"."kind"='closed' and "release_catalog_reservations"."public_path" is null and "release_catalog_reservations"."version" is null and "release_catalog_reservations"."upper_bound" is null))
);
--> statement-breakpoint
ALTER TABLE "release_catalog_channel_events" ADD CONSTRAINT "release_catalog_channel_events_receipt_id_release_catalog_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."release_catalog_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_catalog_channel_events" ADD CONSTRAINT "rc_event_publication_fk" FOREIGN KEY ("publication_id","product","channel") REFERENCES "public"."release_catalog_publications"("id","product","channel") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_catalog_channel_events" ADD CONSTRAINT "rc_event_previous_fk" FOREIGN KEY ("previous_publication_id","product","channel") REFERENCES "public"."release_catalog_publications"("id","product","channel") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_catalog_channels" ADD CONSTRAINT "rc_channel_publication_fk" FOREIGN KEY ("publication_id","product","channel") REFERENCES "public"."release_catalog_publications"("id","product","channel") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_catalog_intents" ADD CONSTRAINT "rc_intent_epoch_fk" FOREIGN KEY ("epoch_id","product","channel") REFERENCES "public"."release_catalog_epochs"("id","product","channel") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_catalog_objects" ADD CONSTRAINT "rc_object_publication_fk" FOREIGN KEY ("publication_id","product","channel","version") REFERENCES "public"."release_catalog_publications"("id","product","channel","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_catalog_oidc_bindings" ADD CONSTRAINT "release_catalog_oidc_bindings_intent_id_release_catalog_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."release_catalog_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_catalog_publications" ADD CONSTRAINT "release_catalog_publications_receipt_id_release_catalog_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."release_catalog_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_catalog_publications" ADD CONSTRAINT "rc_publication_intent_fk" FOREIGN KEY ("intent_id","product","channel","version") REFERENCES "public"."release_catalog_intents"("id","product","channel","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_catalog_reservations" ADD CONSTRAINT "release_catalog_reservations_receipt_id_release_catalog_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."release_catalog_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rc_active_epoch_uq" ON "release_catalog_epochs" USING btree ("product","channel") WHERE "release_catalog_epochs"."enabled";--> statement-breakpoint
CREATE UNIQUE INDEX "rc_object_name_uq" ON "release_catalog_objects" USING btree ("publication_id",lower("name"));
--> statement-breakpoint
-- Hand-reviewed guards for the new catalog. No pre-existing tables or data change.
CREATE FUNCTION public.release_catalog_reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Immutable release catalog record' USING ERRCODE = '55000';
END $$;
--> statement-breakpoint
CREATE FUNCTION public.release_catalog_guard_intent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state')
     OR (OLD.state IN ('committed','failed') AND NEW.state <> OLD.state)
     OR (OLD.state = 'verified' AND NEW.state = 'pending') THEN
    RAISE EXCEPTION 'Immutable release intent identity' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.release_catalog_require_complete_set() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  publication uuid;
  expected_count integer;
  actual_count bigint;
  total_bytes numeric;
BEGIN
  IF TG_TABLE_NAME = 'release_catalog_publications' THEN publication := NEW.id;
  ELSE publication := NEW.publication_id;
  END IF;
  SELECT file_count INTO STRICT expected_count FROM public.release_catalog_publications WHERE id=publication;
  SELECT count(*),coalesce(sum(size_bytes),0) INTO actual_count,total_bytes FROM public.release_catalog_objects WHERE publication_id=publication;
  IF actual_count <> expected_count OR total_bytes > 2147483648 THEN
    RAISE EXCEPTION 'Incomplete release file set' USING ERRCODE = '23514';
  END IF;
  IF EXISTS(SELECT 1 FROM public.release_catalog_publications p JOIN public.release_catalog_intents i ON i.id=p.intent_id WHERE p.id=publication AND p.request_digest<>i.request_digest) THEN
    RAISE EXCEPTION 'Release intent digest mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER rc_publication_complete AFTER INSERT ON public.release_catalog_publications
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.release_catalog_require_complete_set();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER rc_objects_complete AFTER INSERT ON public.release_catalog_objects
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.release_catalog_require_complete_set();
--> statement-breakpoint
DO $guards$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['release_catalog_publications','release_catalog_objects','release_catalog_reservations','release_catalog_channel_events','release_catalog_receipts','release_catalog_oidc_bindings'] LOOP
    EXECUTE format('CREATE TRIGGER rc_immutable_row BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.release_catalog_reject_mutation()',table_name);
    EXECUTE format('CREATE TRIGGER rc_immutable_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.release_catalog_reject_mutation()',table_name);
    EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON public.%I FROM PUBLIC',table_name);
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='markiro_app') THEN
      EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON public.%I FROM markiro_app',table_name);
      EXECUTE format('GRANT SELECT,INSERT ON public.%I TO markiro_app',table_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='markiro_app') THEN
    GRANT SELECT,INSERT,UPDATE ON public.release_catalog_intents,public.release_catalog_channels,public.release_catalog_epochs TO markiro_app;
    REVOKE DELETE,TRUNCATE ON public.release_catalog_intents FROM markiro_app;
  END IF;
  REVOKE DELETE,TRUNCATE ON public.release_catalog_intents FROM PUBLIC;
END $guards$;
--> statement-breakpoint
CREATE TRIGGER rc_intent_identity BEFORE UPDATE ON public.release_catalog_intents FOR EACH ROW EXECUTE FUNCTION public.release_catalog_guard_intent();
--> statement-breakpoint
CREATE TRIGGER rc_intent_retained BEFORE DELETE ON public.release_catalog_intents FOR EACH ROW EXECUTE FUNCTION public.release_catalog_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER rc_intent_no_truncate BEFORE TRUNCATE ON public.release_catalog_intents FOR EACH STATEMENT EXECUTE FUNCTION public.release_catalog_reject_mutation();
