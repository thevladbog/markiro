CREATE TABLE "shift_number_counters" (
	"tenant_id" text NOT NULL,
	"month_key" text NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "shift_number_counters_tenant_id_month_key_pk" PRIMARY KEY("tenant_id","month_key")
);
--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "number_month_key" text;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "number_seq" integer;--> statement-breakpoint
ALTER TABLE "shift_number_counters" ADD CONSTRAINT "shift_number_counters_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
WITH numbered AS (
	SELECT id,
		to_char(coalesce(planned_date, (created_at AT TIME ZONE 'UTC')::date), 'MONYY') AS mk,
		row_number() OVER (
			PARTITION BY tenant_id, to_char(coalesce(planned_date, (created_at AT TIME ZONE 'UTC')::date), 'MONYY')
			ORDER BY created_at, id
		) AS seq
	FROM shifts
)
UPDATE shifts s
SET number_month_key = n.mk, number_seq = n.seq
FROM numbered n
WHERE n.id = s.id;--> statement-breakpoint
INSERT INTO shift_number_counters (tenant_id, month_key, last_seq)
SELECT tenant_id, number_month_key, max(number_seq)
FROM shifts
GROUP BY tenant_id, number_month_key;--> statement-breakpoint
ALTER TABLE "shifts" ALTER COLUMN "number_month_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "shifts" ALTER COLUMN "number_seq" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_tenant_month_seq_uq" ON "shifts" USING btree ("tenant_id","number_month_key","number_seq");
