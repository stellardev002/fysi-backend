CREATE TYPE "public"."otp_purpose" AS ENUM('verify_email', 'reset_password', 'withdrawal');--> statement-breakpoint
CREATE TYPE "public"."moderation_status" AS ENUM('visible', 'hidden', 'removed');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('active', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('customer', 'vendor', 'admin', 'super_admin');--> statement-breakpoint
CREATE TYPE "public"."director_id_type" AS ENUM('nin', 'bvn');--> statement-breakpoint
CREATE TYPE "public"."vendor_document_kind" AS ENUM('cac_certificate', 'director_id', 'proof_of_address', 'sustainability_certificate', 'sustainability_evidence');--> statement-breakpoint
CREATE TYPE "public"."vendor_status" AS ENUM('draft', 'pending', 'approved', 'rejected', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."escrow_status" AS ENUM('pending', 'held', 'disputed', 'released', 'paid_out', 'refunded', 'void');--> statement-breakpoint
CREATE TYPE "public"."fulfilment_status" AS ENUM('awaiting_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('awaiting_payment', 'paid', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('matched', 'overpaid', 'unmatched', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."transfer_status" AS ENUM('queued', 'submitted', 'confirmed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_state" AS ENUM('awaiting_confirmation', 'cancelled', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."wallet_kind" AS ENUM('vendor', 'customer', 'settlement');--> statement-breakpoint
CREATE TYPE "public"."wallet_status" AS ENUM('pending', 'active');--> statement-breakpoint
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
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vendor_order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"title" text NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"quantity" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "order_status" DEFAULT 'awaiting_payment' NOT NULL,
	"total_cents" bigint NOT NULL,
	"paid_stroops" bigint DEFAULT 0 NOT NULL,
	"delivery_address" jsonb NOT NULL,
	"pay_link_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_number_unique" UNIQUE("number"),
	CONSTRAINT "orders_payLinkHash_unique" UNIQUE("pay_link_hash")
);
--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "vendor_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"status" "fulfilment_status" DEFAULT 'awaiting_payment' NOT NULL,
	"subtotal_cents" bigint NOT NULL,
	"commission_bps" integer NOT NULL,
	"commission_cents" bigint NOT NULL,
	"payout_cents" bigint NOT NULL,
	"escrow_status" "escrow_status" DEFAULT 'pending' NOT NULL,
	"carrier" text,
	"tracking_number" text,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"auto_release_at" timestamp with time zone,
	"problem_reported_at" timestamp with time zone,
	"problem_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vendor_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "chain_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"cursor" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chain_cursors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"tx_hash" text NOT NULL,
	"ledger" integer NOT NULL,
	"from_address" text NOT NULL,
	"asset_id" text NOT NULL,
	"amount_stroops" bigint NOT NULL,
	"memo" text,
	"order_id" uuid,
	"status" "payment_status" NOT NULL,
	"refundable_stroops" bigint DEFAULT 0 NOT NULL,
	"note" text,
	"closed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_operationId_unique" UNIQUE("operation_id")
);
--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"destination" text NOT NULL,
	"amount_stroops" bigint NOT NULL,
	"memo" text NOT NULL,
	"status" "transfer_status" DEFAULT 'queued' NOT NULL,
	"tx_hash" text,
	"tx_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vendor_order_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	CONSTRAINT "payouts_txHash_unique" UNIQUE("tx_hash"),
	CONSTRAINT "payouts_vendorOrderId_unique" UNIQUE("vendor_order_id")
);
--> statement-breakpoint
ALTER TABLE "payouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"destination" text NOT NULL,
	"amount_stroops" bigint NOT NULL,
	"memo" text NOT NULL,
	"status" "transfer_status" DEFAULT 'queued' NOT NULL,
	"tx_hash" text,
	"tx_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payment_id" uuid,
	"vendor_order_id" uuid,
	"reason" text NOT NULL,
	"requested_by" uuid NOT NULL,
	CONSTRAINT "refunds_txHash_unique" UNIQUE("tx_hash")
);
--> statement-breakpoint
ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"destination" text NOT NULL,
	"amount_stroops" bigint NOT NULL,
	"memo" text NOT NULL,
	"status" "transfer_status" DEFAULT 'queued' NOT NULL,
	"tx_hash" text,
	"tx_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"state" "withdrawal_state" DEFAULT 'awaiting_confirmation' NOT NULL,
	"confirm_by" timestamp with time zone NOT NULL,
	CONSTRAINT "withdrawals_txHash_unique" UNIQUE("tx_hash")
);
--> statement-breakpoint
ALTER TABLE "withdrawals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "wallet_kind" NOT NULL,
	"user_id" uuid,
	"public_key" text NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"status" "wallet_status" DEFAULT 'pending' NOT NULL,
	"activation_error" text,
	"activation_attempts" integer DEFAULT 0 NOT NULL,
	"activated_at" timestamp with time zone,
	"kyc_tier" smallint,
	"pin_hash" text,
	"pin_failures" integer DEFAULT 0 NOT NULL,
	"pin_locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_publicKey_unique" UNIQUE("public_key")
);
--> statement-breakpoint
ALTER TABLE "wallets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_vendor_order_id_vendor_orders_id_fk" FOREIGN KEY ("vendor_order_id") REFERENCES "public"."vendor_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_orders" ADD CONSTRAINT "vendor_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_orders" ADD CONSTRAINT "vendor_orders_vendor_id_vendors_user_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_vendor_order_id_vendor_orders_id_fk" FOREIGN KEY ("vendor_order_id") REFERENCES "public"."vendor_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_vendor_order_id_vendor_orders_id_fk" FOREIGN KEY ("vendor_order_id") REFERENCES "public"."vendor_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
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
CREATE INDEX "vendors_status_idx" ON "vendors" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "order_lines_vendor_order_idx" ON "order_lines" USING btree ("vendor_order_id");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_open_idx" ON "orders" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "vendor_orders_order_idx" ON "vendor_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "vendor_orders_vendor_idx" ON "vendor_orders" USING btree ("vendor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "vendor_orders_release_idx" ON "vendor_orders" USING btree ("escrow_status","auto_release_at");--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_created_idx" ON "payments" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payouts_status_idx" ON "payouts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "refunds_status_idx" ON "refunds" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "withdrawals_user_idx" ON "withdrawals" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_user_kind_idx" ON "wallets" USING btree ("user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_single_settlement_idx" ON "wallets" USING btree ("kind") WHERE "wallets"."kind" = 'settlement';--> statement-breakpoint
CREATE INDEX "wallets_status_idx" ON "wallets" USING btree ("status");