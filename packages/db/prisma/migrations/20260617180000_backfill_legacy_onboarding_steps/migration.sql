UPDATE "onboarding_state"
SET "step" = 'webhook_configuring'
WHERE "step" IN ('install', 'configure', 'working');
