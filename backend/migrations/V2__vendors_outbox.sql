-- V2: service vendor contact per asset, and an email outbox.
-- Approved vendor emails are written to the outbox; a mailer (SMTP in prod, log in dev) drains it.

ALTER TABLE asset ADD COLUMN vendor_name  VARCHAR(200);
ALTER TABLE asset ADD COLUMN vendor_email VARCHAR(255);

CREATE TABLE outbox_email (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    to_address     VARCHAR(255) NOT NULL,
    subject        VARCHAR(300) NOT NULL,
    body           TEXT NOT NULL,
    work_order_id  UUID REFERENCES work_order(id),
    approval_id    UUID REFERENCES approval(id),
    status         VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
    sent_at        TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_pending ON outbox_email(created_at) WHERE status = 'PENDING';

-- Agent runs: when a retry is allowed to start again (backoff)
ALTER TABLE agent_run ADD COLUMN run_after TIMESTAMPTZ NOT NULL DEFAULT now();
DROP INDEX idx_agent_run_queue;
CREATE INDEX idx_agent_run_queue ON agent_run(run_after) WHERE status = 'QUEUED';
