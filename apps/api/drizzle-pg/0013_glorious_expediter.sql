CREATE TABLE "device_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" text,
	"client_ip" text,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_polled_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "device_authorizations_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "device_authorizations_user_code_unique" UNIQUE("user_code")
);
--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_authorizations_expires_at_idx" ON "device_authorizations" USING btree ("expires_at");