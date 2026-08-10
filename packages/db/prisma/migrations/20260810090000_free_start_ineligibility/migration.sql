-- The free starting credits are an entitlement per person, so the record of who has spent one has to
-- outlive the rows that happen to represent them. Keyed on the email address: a user id does not
-- survive deleting an account and signing up again, which is the cheapest way to reset a per-user cap.
CREATE TABLE "free_start_ineligibility" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "organization_ids" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "free_start_ineligibility_pkey" PRIMARY KEY ("id")
);

-- Every read is "is this address on the list?", so the unique index is the whole access pattern.
CREATE UNIQUE INDEX "free_start_ineligibility_email_key" ON "free_start_ineligibility"("email");
