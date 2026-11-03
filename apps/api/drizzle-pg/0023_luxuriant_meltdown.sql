CREATE TABLE "provider_oauth_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"email" text,
	"subject" text NOT NULL,
	"client_id" text NOT NULL,
	"host_id" text NOT NULL,
	"created_by_user_id" text,
	"tokens_enc" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"earliest_refresh_at" timestamp with time zone,
	"reauth_required" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"refresh_lease_id" text,
	"refresh_lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_oauth_logins" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text,
	"created_by_user_id" text NOT NULL,
	"label" text,
	"token_hash" text NOT NULL,
	"pending_enc" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "provider_oauth_account_id" text;--> statement-breakpoint
ALTER TABLE "provider_oauth_accounts" ADD CONSTRAINT "provider_oauth_accounts_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_oauth_accounts" ADD CONSTRAINT "provider_oauth_accounts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_oauth_logins" ADD CONSTRAINT "provider_oauth_logins_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_oauth_logins" ADD CONSTRAINT "provider_oauth_logins_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_oauth_accounts_registration_unique" ON "provider_oauth_accounts" USING btree ("provider_id","client_id","subject");