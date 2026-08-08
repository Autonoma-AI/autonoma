-- Record whether an organization's name has ever been confirmed by a human.
--
-- An organization created from a personal email address is named after whoever signed up first
-- (`ensureOrgMembership` uses their display name), and that person is not necessarily whose
-- organization it is - the first person through the door may be an engineer setting things up for
-- a team. Those organizations now ask for a name once; this column is what stops the prompt
-- reappearing afterwards.
--
-- Nullable with no default and no backfill, on purpose: NULL means "never confirmed", which is
-- exactly right for every organization that already exists. Existing personal-email orgs will be
-- asked to name themselves the next time someone signs in, which is the intended behaviour rather
-- than a migration artefact. Orgs derived from a real email domain never prompt regardless of this
-- column - the check also requires the domain to be an address rather than a domain - so the
-- absence of a backfill cannot surprise a company organization.
ALTER TABLE "organization" ADD COLUMN "name_confirmed_at" TIMESTAMP(3);

-- Remember which organization an account chose to act as.
--
-- An account can belong to several organizations, and which one a session acts as is session state
-- (`session.active_organization_id`). Without a durable choice, every new session fell back to the
-- oldest membership, so a multi-organization user was dropped back into the wrong one on every
-- sign-in and had to re-pick. This is that choice: written whenever someone switches or picks, read
-- when a session is created.
--
-- ON DELETE SET NULL rather than CASCADE - deleting an organization must not delete the users who
-- happened to have it selected. Application code additionally re-points this when a membership is
-- lost, so it can never name an organization the user is no longer in; the constraint only covers
-- the organization ceasing to exist.
ALTER TABLE "user" ADD COLUMN "last_organization_id" TEXT;

CREATE INDEX "user_last_organization_id_idx" ON "user"("last_organization_id");

ALTER TABLE "user"
    ADD CONSTRAINT "user_last_organization_id_fkey"
    FOREIGN KEY ("last_organization_id") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
