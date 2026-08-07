-- Index every single-column ON DELETE CASCADE foreign key that had no index.
--
-- Postgres does not index a referencing column automatically, so each cascade
-- delete sequentially scanned the whole child table. Deleting one organization
-- scanned ~4.6 GB across step_output, step_attempt, step_input, webhook_call and
-- scenario_instance, which is why the SDK teardown ran 22-138s against its 60s
-- budget and why deleting an application or an organization is slow in the app.
--
-- IF NOT EXISTS so this is a no-op against a database where an operator already
-- built the same indexes CONCURRENTLY (see index-cascade-foreign-keys.concurrent.sql
-- next to this migration). Plain CREATE INDEX takes a SHARE lock and blocks writes
-- to the table for the length of the build - fine on a small database, not on
-- production's largest tables.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "account_user_id_idx" ON "account"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "affected_test_organization_id_idx" ON "affected_test"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "affected_test_test_case_id_idx" ON "affected_test"("test_case_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "analysis_job_organization_id_idx" ON "analysis_job"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "analysis_report_organization_id_idx" ON "analysis_report"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "application_setup_user_id_idx" ON "application_setup"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "branch_organization_id_idx" ON "branch"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "branch_deployment_organization_id_idx" ON "branch_deployment"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bug_organization_id_idx" ON "bug"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "diffs_job_organization_id_idx" ON "diffs_job"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "folder_organization_id_idx" ON "folder"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "generation_review_organization_id_idx" ON "generation_review"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "investigation_report_organization_id_idx" ON "investigation_report"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "invitation_inviter_id_idx" ON "invitation"("inviter_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "invitation_organization_id_idx" ON "invitation"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "issue_organization_id_idx" ON "issue"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "member_organization_id_idx" ON "member"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "mobile_deployment_organization_id_idx" ON "mobile_deployment"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "refinement_iteration_input_plan_id_idx" ON "refinement_iteration_input"("plan_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "refinement_loop_organization_id_idx" ON "refinement_loop"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "run_organization_id_idx" ON "run"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "run_review_organization_id_idx" ON "run_review"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "scenario_organization_id_idx" ON "scenario"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "scenario_instance_application_id_idx" ON "scenario_instance"("application_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "scenario_instance_organization_id_idx" ON "scenario_instance"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "scenario_instance_scenario_id_idx" ON "scenario_instance"("scenario_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "session_user_id_idx" ON "session"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "signup_hook_state_organization_id_idx" ON "signup_hook_state"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "step_attempt_organization_id_idx" ON "step_attempt"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "step_input_organization_id_idx" ON "step_input"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "step_input_list_organization_id_idx" ON "step_input_list"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "step_input_list_plan_id_idx" ON "step_input_list"("plan_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "step_output_organization_id_idx" ON "step_output"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "step_output_step_input_id_idx" ON "step_output"("step_input_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "step_output_list_organization_id_idx" ON "step_output_list"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tag_application_id_idx" ON "tag"("application_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tag_organization_id_idx" ON "tag"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "test_case_organization_id_idx" ON "test_case"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "test_case_assignment_test_case_id_idx" ON "test_case_assignment"("test_case_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "test_generation_organization_id_idx" ON "test_generation"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "test_generation_test_plan_id_idx" ON "test_generation"("test_plan_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "test_plan_organization_id_idx" ON "test_plan"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "test_tag_tag_id_idx" ON "test_tag"("tag_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "vercel_installation_organization_id_idx" ON "vercel_installation"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "vercel_installation_user_id_idx" ON "vercel_installation"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "vercel_project_vercel_installation_id_idx" ON "vercel_project"("vercel_installation_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "web_deployment_organization_id_idx" ON "web_deployment"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webhook_call_application_id_idx" ON "webhook_call"("application_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webhook_call_instance_id_idx" ON "webhook_call"("instance_id");
