CREATE TYPE "public"."otp_purpose" AS ENUM('verify_email', 'reset_password');--> statement-breakpoint
CREATE TYPE "public"."moderation_status" AS ENUM('visible', 'hidden', 'removed');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('active', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('customer', 'vendor', 'admin', 'super_admin');--> statement-breakpoint
CREATE TYPE "public"."director_id_type" AS ENUM('nin', 'bvn');--> statement-breakpoint
CREATE TYPE "public"."vendor_document_kind" AS ENUM('cac_certificate', 'director_id', 'proof_of_address', 'sustainability_certificate', 'sustainability_evidence');--> statement-breakpoint
CREATE TYPE "public"."vendor_status" AS ENUM('draft', 'pending', 'approved', 'rejected', 'suspended');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"request_id" text,
	"trace_id" text,
	"ip" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"before" jsonb,
	"after" jsonb
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_name_unique" UNIQUE("name"),
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "otps" (
	"user_id" uuid NOT NULL,
	"purpose" "otp_purpose" NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otps_user_id_purpose_pk" PRIMARY KEY("user_id","purpose")
);
--> statement-breakpoint
ALTER TABLE "otps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cart_items" (
	"user_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_items_user_id_product_id_pk" PRIMARY KEY("user_id","product_id"),
	CONSTRAINT "cart_items_quantity_range" CHECK ("cart_items"."quantity" between 1 and 99)
);
--> statement-breakpoint
ALTER TABLE "cart_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vendor_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"description" text NOT NULL,
	"price_cents" bigint NOT NULL,
	"stock" integer NOT NULL,
	"certifications" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "product_status" DEFAULT 'active' NOT NULL,
	"moderation_status" "moderation_status" DEFAULT 'visible' NOT NULL,
	"moderation_reason" text,
	"moderated_by" uuid,
	"moderated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce("title", '')), 'A') || setweight(to_tsvector('english', coalesce("description", '')), 'B')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_unique" UNIQUE("slug"),
	CONSTRAINT "products_price_positive" CHECK ("products"."price_cents" > 0),
	CONSTRAINT "products_stock_non_negative" CHECK ("products"."stock" >= 0)
);
--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"mfa" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "used_refresh_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "used_refresh_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_suspensions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"suspended_by" uuid NOT NULL,
	"suspended_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_suspensions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "role" NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"avatar_key" text,
	"email_verified_at" timestamp with time zone,
	"totp_secret" text,
	"totp_enabled_at" timestamp with time zone,
	"totp_last_step" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "vendor_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vendor_id" uuid NOT NULL,
	"kind" "vendor_document_kind" NOT NULL,
	"certification" text,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vendor_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "vendors" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"status" "vendor_status" DEFAULT 'draft' NOT NULL,
	"business_name" text,
	"slug" text,
	"description" text,
	"phone" text,
	"address_line" text,
	"city" text,
	"state" text,
	"category_id" uuid,
	"cac_number" text,
	"director_id_type" "director_id_type",
	"director_id_encrypted" text,
	"director_id_last4" text,
	"logo_key" text,
	"verified_certifications" text[] DEFAULT '{}'::text[] NOT NULL,
	"decision_reason" text,
	"founding_vendor" boolean DEFAULT false NOT NULL,
	"submission_count" integer DEFAULT 0 NOT NULL,
	"submitted_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendors_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "vendors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "otps" ADD CONSTRAINT "otps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_vendor_id_vendors_user_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_suspensions" ADD CONSTRAINT "user_suspensions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_documents" ADD CONSTRAINT "vendor_documents_vendor_id_vendors_user_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_resource_idx" ON "audit_log" USING btree ("resource_type","resource_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "product_images_product_idx" ON "product_images" USING btree ("product_id","position");--> statement-breakpoint
CREATE INDEX "products_vendor_idx" ON "products" USING btree ("vendor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "products_price_idx" ON "products" USING btree ("price_cents");--> statement-breakpoint
CREATE INDEX "products_search_idx" ON "products" USING gin ("search");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "vendor_documents_vendor_idx" ON "vendor_documents" USING btree ("vendor_id","created_at");--> statement-breakpoint
CREATE INDEX "vendors_status_idx" ON "vendors" USING btree ("status","submitted_at");