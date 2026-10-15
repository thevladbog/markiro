-- One transport call, five sequential locking reads. The function deliberately
-- returns private facts rather than an authorization decision.
CREATE FUNCTION public.us_development_owner_provenance_v1(
  p_tenant pg_catalog.text, p_actor pg_catalog.jsonb
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY INVOKER
CALLED ON NULL INPUT SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization RECORD;
  v_user RECORD;
  v_membership RECORD;
  v_credential RECORD;
  v_audit RECORD;
  v_membership_count pg_catalog.int8 := 0;
  v_credential_count pg_catalog.int8 := 0;
  v_audit_count pg_catalog.int8 := 0;
  v_sole_role pg_catalog.text;
  v_sole_account_id pg_catalog.text;
  v_nonempty_password pg_catalog.bool := false;
  v_audit_actor pg_catalog.text;
  v_audit_outcome pg_catalog.text;
  v_audit_target_type pg_catalog.text;
  v_audit_target_id pg_catalog.text;
  v_audit_before pg_catalog.jsonb;
  v_audit_after pg_catalog.jsonb;
BEGIN
  -- Keep the original database selector's collation semantics. The subsequent
  -- identity gates use C for deterministic byte-exact JavaScript equality.
  SELECT o.id, o.name, o.metadata INTO v_organization
    FROM public.organization AS o
   WHERE o.id = p_tenant AND o.slug = 'us-development-demo'
   FOR SHARE;
  IF NOT FOUND OR
     (v_organization.name COLLATE "C") IS DISTINCT FROM ('Synthetic US development' COLLATE "C") OR
     (v_organization.metadata COLLATE "C") IS DISTINCT FROM ('{"synthetic":true,"seedVersion":"us-development-owner-v1"}' COLLATE "C")
  THEN
    RETURN NULL;
  END IF;

  SELECT u.id, u.name INTO v_user
    FROM public."user" AS u
   WHERE u.email = 'owner@us-development.example.test'
   FOR SHARE;
  IF NOT FOUND OR
     (v_user.name COLLATE "C") IS DISTINCT FROM ('Synthetic US development owner' COLLATE "C")
  THEN
    RETURN NULL;
  END IF;
  IF p_actor IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_actor) IS DISTINCT FROM 'string' OR
       (v_user.id COLLATE "C") IS DISTINCT FROM ((p_actor #>> '{}') COLLATE "C")
    THEN
      RETURN NULL;
    END IF;
  END IF;

  -- A FOR loop consumes every matching row of one SELECT and retains each
  -- FOR SHARE lock until the caller ends its transaction.
  FOR v_membership IN
    SELECT m.role FROM public.member AS m
     WHERE m.organization_id = p_tenant AND m.user_id = v_user.id
     FOR SHARE
  LOOP
    v_membership_count := v_membership_count + 1;
    IF v_membership_count = 1 THEN v_sole_role := v_membership.role; END IF;
  END LOOP;
  IF v_membership_count IS DISTINCT FROM 1 OR
     (v_sole_role COLLATE "C") IS DISTINCT FROM ('owner' COLLATE "C")
  THEN
    RETURN NULL;
  END IF;

  FOR v_credential IN
    SELECT a.account_id, a.password FROM public.account AS a
     WHERE a.user_id = v_user.id AND a.provider_id = 'credential'
     FOR SHARE
  LOOP
    v_credential_count := v_credential_count + 1;
    IF v_credential_count = 1 THEN
      v_sole_account_id := v_credential.account_id;
      v_nonempty_password := v_credential.password IS NOT NULL AND v_credential.password <> '';
    END IF;
  END LOOP;
  IF v_credential_count IS DISTINCT FROM 1 OR
     (v_sole_account_id COLLATE "C") IS DISTINCT FROM (v_user.id COLLATE "C") OR
     v_nonempty_password IS DISTINCT FROM true
  THEN
    RETURN NULL;
  END IF;

  FOR v_audit IN
    SELECT e.actor_user_id, e.outcome, e.target_type, e.target_id,
           e."before", e."after"
      FROM public.tenant_audit_events AS e
     WHERE e.organization_id = p_tenant
       AND e.action = 'us.development.owner.provisioned'
     FOR SHARE
  LOOP
    v_audit_count := v_audit_count + 1;
    IF v_audit_count = 1 THEN
      v_audit_actor := v_audit.actor_user_id;
      v_audit_outcome := v_audit.outcome;
      v_audit_target_type := v_audit.target_type;
      v_audit_target_id := v_audit.target_id;
      v_audit_before := v_audit."before";
      v_audit_after := v_audit."after";
    END IF;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'codec', 'us-development-owner-provenance-v1',
    'organization', pg_catalog.jsonb_build_object(
      'id', v_organization.id, 'name', v_organization.name, 'metadata', v_organization.metadata
    ),
    'user', pg_catalog.jsonb_build_object('id', v_user.id, 'name', v_user.name),
    'memberships', pg_catalog.jsonb_build_object(
      'count', v_membership_count,
      'soleRole', CASE WHEN v_membership_count = 1 THEN v_sole_role ELSE NULL END
    ),
    'credentials', pg_catalog.jsonb_build_object(
      'count', v_credential_count,
      'soleAccountId', CASE WHEN v_credential_count = 1 THEN v_sole_account_id ELSE NULL END,
      'nonemptyPassword', CASE WHEN v_credential_count = 1 THEN v_nonempty_password ELSE false END
    ),
    'audits', pg_catalog.jsonb_build_object(
      'count', v_audit_count,
      'sole', CASE WHEN v_audit_count = 1 THEN pg_catalog.jsonb_build_object(
        'actorUserId', v_audit_actor, 'outcome', v_audit_outcome,
        'targetType', v_audit_target_type, 'targetId', v_audit_target_id,
        'before', v_audit_before, 'after', v_audit_after
      ) ELSE NULL END
    )
  );
END
$function$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.us_development_owner_provenance_v1(
  pg_catalog.text, pg_catalog.jsonb
) FROM PUBLIC;
--> statement-breakpoint
-- Default privileges may add an unexpected nonowner grantee at CREATE time.
-- Abort the same migration transaction instead of silently revoking it.
DO $acl$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS p
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
      ) AS a
     WHERE p.oid = 'public.us_development_owner_provenance_v1(pg_catalog.text,pg_catalog.jsonb)'::pg_catalog.regprocedure
       AND a.privilege_type = 'EXECUTE'
       AND a.grantee <> p.proowner
  ) THEN
    RAISE EXCEPTION 'us_owner_provenance_unexpected_execute_acl' USING ERRCODE = '42501';
  END IF;
END
$acl$;
