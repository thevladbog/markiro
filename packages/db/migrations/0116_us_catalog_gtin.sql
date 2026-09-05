ALTER TABLE "products" ALTER COLUMN "gtin14" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;