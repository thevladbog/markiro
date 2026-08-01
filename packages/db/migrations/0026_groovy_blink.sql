ALTER TABLE "box_exceptions" DROP CONSTRAINT "box_exceptions_kind_payload_check";--> statement-breakpoint
ALTER TABLE "box_exceptions" ADD COLUMN "target_scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "box_exceptions" ADD CONSTRAINT "box_exceptions_kind_payload_check" CHECK (("box_exceptions"."kind" = 'undo' AND "box_exceptions"."code_hash" IS NOT NULL AND "box_exceptions"."target_scanned_at" IS NOT NULL AND "box_exceptions"."reason" IS NULL)
          OR ("box_exceptions"."kind" = 'clear' AND "box_exceptions"."code_hash" IS NULL AND "box_exceptions"."target_scanned_at" IS NULL AND "box_exceptions"."reason" IS NULL)
          OR ("box_exceptions"."kind" IN ('disassemble', 'reprint') AND "box_exceptions"."code_hash" IS NULL AND "box_exceptions"."target_scanned_at" IS NULL AND "box_exceptions"."reason" IS NOT NULL)) NOT VALID;
