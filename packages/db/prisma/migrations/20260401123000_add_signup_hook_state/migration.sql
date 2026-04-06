-- Track onboarding side effects so premium onboarding can be retried after upgrade.
CREATE TABLE "signup_hook_state" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "newsletter_added_at" TIMESTAMP(3),
    "default_welcome_email_sent_at" TIMESTAMP(3),
    "premium_welcome_email_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signup_hook_state_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "signup_hook_state_user_id_organization_id_key"
ON "signup_hook_state"("user_id", "organization_id");

ALTER TABLE "signup_hook_state"
ADD CONSTRAINT "signup_hook_state_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "signup_hook_state"
ADD CONSTRAINT "signup_hook_state_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
