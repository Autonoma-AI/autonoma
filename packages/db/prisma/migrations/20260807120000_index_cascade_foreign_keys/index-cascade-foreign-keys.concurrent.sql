-- Production pre-step for 20260807120000_index_cascade_foreign_keys.
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction, and Prisma wraps every
-- migration in one - so run this by hand against production BEFORE deploying the
-- migration. The migration itself is IF NOT EXISTS, so it then does nothing.
--
-- Run statement by statement (a failed CONCURRENTLY build leaves an INVALID index
-- that must be dropped before retrying:
--   DROP INDEX CONCURRENTLY IF EXISTS "<name>";).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "account_user_id_idx" ON "account"("user_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "affected_test_organization_id_idx" ON "affected_test"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "affected_test_test_case_id_idx" ON "affected_test"("test_case_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "analysis_job_organization_id_idx" ON "analysis_job"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "analysis_report_organization_id_idx" ON "analysis_report"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "application_setup_user_id_idx" ON "application_setup"("user_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "branch_organization_id_idx" ON "branch"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "branch_deployment_organization_id_idx" ON "branch_deployment"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "bug_organization_id_idx" ON "bug"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "diffs_job_organization_id_idx" ON "diffs_job"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "folder_organization_id_idx" ON "folder"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "generation_review_organization_id_idx" ON "generation_review"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "investigation_report_organization_id_idx" ON "investigation_report"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "invitation_inviter_id_idx" ON "invitation"("inviter_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "invitation_organization_id_idx" ON "invitation"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_organization_id_idx" ON "issue"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "member_organization_id_idx" ON "member"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "mobile_deployment_organization_id_idx" ON "mobile_deployment"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "refinement_iteration_input_plan_id_idx" ON "refinement_iteration_input"("plan_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "refinement_loop_organization_id_idx" ON "refinement_loop"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "run_organization_id_idx" ON "run"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "run_review_organization_id_idx" ON "run_review"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "scenario_organization_id_idx" ON "scenario"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "scenario_instance_application_id_idx" ON "scenario_instance"("application_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "scenario_instance_organization_id_idx" ON "scenario_instance"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "scenario_instance_scenario_id_idx" ON "scenario_instance"("scenario_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_user_id_idx" ON "session"("user_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "signup_hook_state_organization_id_idx" ON "signup_hook_state"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "step_attempt_organization_id_idx" ON "step_attempt"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "step_input_organization_id_idx" ON "step_input"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "step_input_list_organization_id_idx" ON "step_input_list"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "step_input_list_plan_id_idx" ON "step_input_list"("plan_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "step_output_organization_id_idx" ON "step_output"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "step_output_step_input_id_idx" ON "step_output"("step_input_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "step_output_list_organization_id_idx" ON "step_output_list"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "tag_application_id_idx" ON "tag"("application_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "tag_organization_id_idx" ON "tag"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "test_case_organization_id_idx" ON "test_case"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "test_case_assignment_test_case_id_idx" ON "test_case_assignment"("test_case_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "test_generation_organization_id_idx" ON "test_generation"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "test_generation_test_plan_id_idx" ON "test_generation"("test_plan_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "test_plan_organization_id_idx" ON "test_plan"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "test_tag_tag_id_idx" ON "test_tag"("tag_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "vercel_installation_organization_id_idx" ON "vercel_installation"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "vercel_installation_user_id_idx" ON "vercel_installation"("user_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "vercel_project_vercel_installation_id_idx" ON "vercel_project"("vercel_installation_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "web_deployment_organization_id_idx" ON "web_deployment"("organization_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_call_application_id_idx" ON "webhook_call"("application_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_call_instance_id_idx" ON "webhook_call"("instance_id");
