-- The github_webhook_event table was dropped (20260622120000_drop_github_webhook_event);
-- its enum type lingered but is no longer referenced by any column. The webhook
-- handler now derives its event-name union locally, so the Postgres type can go.
DROP TYPE IF EXISTS "github_webhook_event_type";
