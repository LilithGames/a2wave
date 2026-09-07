CREATE TABLE "saml_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "saml_requests_created_at_idx" ON "saml_requests" USING btree ("created_at");