-- FixFlow — initial schema (Flyway V1)
-- PostgreSQL 15+. Enums are VARCHAR + CHECK (easier with JPA @Enumerated(STRING) than PG enum types).
-- gen_random_uuid() is built into PG13+.

-- ─────────────────────────────────────────────────────────────
-- Identity
-- ─────────────────────────────────────────────────────────────
CREATE TABLE app_user (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email          VARCHAR(255) NOT NULL UNIQUE,
    password_hash  VARCHAR(255) NOT NULL,
    full_name      VARCHAR(200) NOT NULL,
    role           VARCHAR(20)  NOT NULL CHECK (role IN ('MANAGER', 'TECHNICIAN', 'TENANT')),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- Properties, units, assets
-- ─────────────────────────────────────────────────────────────
CREATE TABLE property (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(200) NOT NULL,
    address     VARCHAR(500) NOT NULL,
    manager_id  UUID NOT NULL REFERENCES app_user(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE unit (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id  UUID NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    label        VARCHAR(50) NOT NULL,              -- e.g. "4B"
    tenant_id    UUID REFERENCES app_user(id),
    UNIQUE (property_id, label)
);

-- Shared category list for assets, requests, work orders, technician skills
-- PLUMBING | ELECTRICAL | HVAC | APPLIANCE | STRUCTURAL | PEST | GENERAL
CREATE TABLE asset (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id    UUID NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    unit_id        UUID REFERENCES unit(id) ON DELETE SET NULL,   -- NULL = common area / building-level
    category       VARCHAR(20) NOT NULL CHECK (category IN ('PLUMBING','ELECTRICAL','HVAC','APPLIANCE','STRUCTURAL','PEST','GENERAL')),
    name           VARCHAR(200) NOT NULL,                         -- "Water heater", "Kitchen sink"
    make           VARCHAR(100),
    model          VARCHAR(100),
    serial_number  VARCHAR(100),
    installed_on   DATE,
    notes          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_asset_property_unit ON asset(property_id, unit_id);

-- ─────────────────────────────────────────────────────────────
-- Technicians
-- ─────────────────────────────────────────────────────────────
CREATE TABLE technician (
    user_id               UUID PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    phone                 VARCHAR(30),
    max_open_work_orders  INT NOT NULL DEFAULT 5 CHECK (max_open_work_orders > 0),
    active                BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE technician_skill (
    technician_id  UUID NOT NULL REFERENCES technician(user_id) ON DELETE CASCADE,
    category       VARCHAR(20) NOT NULL CHECK (category IN ('PLUMBING','ELECTRICAL','HVAC','APPLIANCE','STRUCTURAL','PEST','GENERAL')),
    PRIMARY KEY (technician_id, category)
);

CREATE TABLE technician_property (          -- which buildings a tech covers
    technician_id  UUID NOT NULL REFERENCES technician(user_id) ON DELETE CASCADE,
    property_id    UUID NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    PRIMARY KEY (technician_id, property_id)
);

CREATE TABLE technician_unavailability (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    technician_id  UUID NOT NULL REFERENCES technician(user_id) ON DELETE CASCADE,
    starts_at      TIMESTAMPTZ NOT NULL,
    ends_at        TIMESTAMPTZ NOT NULL,
    reason         VARCHAR(200),
    CHECK (ends_at > starts_at)
);
CREATE INDEX idx_tech_unavail ON technician_unavailability(technician_id, starts_at, ends_at);

-- ─────────────────────────────────────────────────────────────
-- Maintenance requests (what tenants/staff submit)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE maintenance_request (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id      UUID NOT NULL REFERENCES property(id),
    unit_id          UUID REFERENCES unit(id),
    submitted_by     UUID NOT NULL REFERENCES app_user(id),
    title            VARCHAR(200) NOT NULL,
    description      TEXT NOT NULL,
    status           VARCHAR(20) NOT NULL DEFAULT 'NEW'
                     CHECK (status IN ('NEW','TRIAGING','TRIAGED','CONVERTED','DUPLICATE','REJECTED')),
    -- filled by the agent (or a manager)
    category         VARCHAR(20) CHECK (category IN ('PLUMBING','ELECTRICAL','HVAC','APPLIANCE','STRUCTURAL','PEST','GENERAL')),
    urgency          VARCHAR(20) CHECK (urgency IN ('LOW','NORMAL','HIGH','EMERGENCY')),
    asset_id         UUID REFERENCES asset(id),
    duplicate_of_id  UUID REFERENCES maintenance_request(id),
    triage_rationale TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_request_property_created ON maintenance_request(property_id, created_at DESC);
CREATE INDEX idx_request_unit_category    ON maintenance_request(unit_id, category, created_at DESC);
CREATE INDEX idx_request_asset            ON maintenance_request(asset_id);

CREATE TABLE request_attachment (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id    UUID NOT NULL REFERENCES maintenance_request(id) ON DELETE CASCADE,
    storage_key   VARCHAR(500) NOT NULL,       -- S3/MinIO object key
    content_type  VARCHAR(100) NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
    size_bytes    BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- Agent runs (also the job queue: workers poll with FOR UPDATE SKIP LOCKED)
-- Declared before work_order so work_order can reference it.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE agent_run (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_type       VARCHAR(30) NOT NULL CHECK (run_type IN ('TRIAGE','NIGHTLY_DIGEST','MANUAL')),
    trigger_ref    UUID,                         -- request id for TRIAGE, property id for NIGHTLY_DIGEST
    status         VARCHAR(20) NOT NULL DEFAULT 'QUEUED'
                   CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
    attempts       INT NOT NULL DEFAULT 0,
    max_attempts   INT NOT NULL DEFAULT 3,
    locked_until   TIMESTAMPTZ,                  -- lease; expired lease = worker died, job can be retaken
    model          VARCHAR(100),
    input_tokens   INT NOT NULL DEFAULT 0,
    output_tokens  INT NOT NULL DEFAULT 0,
    tool_calls     INT NOT NULL DEFAULT 0,
    summary        TEXT,                         -- agent's final message, shown in UI
    error          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at     TIMESTAMPTZ,
    finished_at    TIMESTAMPTZ
);
CREATE INDEX idx_agent_run_queue   ON agent_run(created_at) WHERE status = 'QUEUED';
CREATE INDEX idx_agent_run_trigger ON agent_run(run_type, trigger_ref);
-- Idempotency: one active triage run per request
CREATE UNIQUE INDEX uq_agent_run_active_triage
    ON agent_run(trigger_ref) WHERE run_type = 'TRIAGE' AND status IN ('QUEUED','RUNNING');

-- Full trace of every model turn and tool call: this IS the audit log UI
CREATE TABLE agent_step (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id       UUID NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
    seq          INT  NOT NULL,
    step_type    VARCHAR(20) NOT NULL CHECK (step_type IN ('MODEL_TEXT','TOOL_CALL','TOOL_RESULT','ERROR')),
    tool_name    VARCHAR(100),
    tool_use_id  VARCHAR(100),                   -- Claude's tool_use id, links call ↔ result
    tool_input   JSONB,
    tool_output  JSONB,
    text         TEXT,
    duration_ms  INT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, seq)
);

-- ─────────────────────────────────────────────────────────────
-- Work orders
-- ─────────────────────────────────────────────────────────────
CREATE TABLE work_order (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id               UUID UNIQUE REFERENCES maintenance_request(id),   -- NULL for preventive WOs
    pm_schedule_id           UUID,                                             -- FK added below
    property_id              UUID NOT NULL REFERENCES property(id),
    unit_id                  UUID REFERENCES unit(id),
    asset_id                 UUID REFERENCES asset(id),
    title                    VARCHAR(200) NOT NULL,
    description              TEXT NOT NULL,
    category                 VARCHAR(20) NOT NULL CHECK (category IN ('PLUMBING','ELECTRICAL','HVAC','APPLIANCE','STRUCTURAL','PEST','GENERAL')),
    priority                 VARCHAR(20) NOT NULL CHECK (priority IN ('LOW','NORMAL','HIGH','EMERGENCY')),
    status                   VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                             CHECK (status IN ('OPEN','ASSIGNED','IN_PROGRESS','ON_HOLD','COMPLETED','CANCELLED')),
    assigned_technician_id   UUID REFERENCES technician(user_id),
    due_at                   TIMESTAMPTZ,
    created_by_user_id       UUID REFERENCES app_user(id),
    created_by_agent_run_id  UUID REFERENCES agent_run(id),
    resolution_notes         TEXT,
    completed_at             TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (created_by_user_id IS NOT NULL OR created_by_agent_run_id IS NOT NULL),
    CHECK (status <> 'ASSIGNED' OR assigned_technician_id IS NOT NULL)
);
CREATE INDEX idx_wo_status_due      ON work_order(status, due_at);
CREATE INDEX idx_wo_technician_open ON work_order(assigned_technician_id)
    WHERE status IN ('ASSIGNED','IN_PROGRESS','ON_HOLD');
CREATE INDEX idx_wo_asset           ON work_order(asset_id, created_at DESC);

-- Timeline shown on each work order (status changes, comments, agent actions)
CREATE TABLE work_order_event (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_order_id  UUID NOT NULL REFERENCES work_order(id) ON DELETE CASCADE,
    actor_type     VARCHAR(10) NOT NULL CHECK (actor_type IN ('USER','AGENT','SYSTEM')),
    actor_user_id  UUID REFERENCES app_user(id),
    agent_run_id   UUID REFERENCES agent_run(id),
    event_type     VARCHAR(40) NOT NULL,        -- CREATED, ASSIGNED, STATUS_CHANGED, COMMENT, ...
    payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (actor_type = 'USER'   AND actor_user_id IS NOT NULL) OR
        (actor_type = 'AGENT'  AND agent_run_id  IS NOT NULL) OR
        (actor_type = 'SYSTEM')
    )
);
CREATE INDEX idx_wo_event_wo ON work_order_event(work_order_id, created_at);

-- ─────────────────────────────────────────────────────────────
-- Preventive maintenance
-- ─────────────────────────────────────────────────────────────
CREATE TABLE pm_schedule (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id           UUID NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
    title              VARCHAR(200) NOT NULL,     -- "Flush water heater"
    description        TEXT,
    interval_days      INT NOT NULL CHECK (interval_days > 0),
    next_due_on        DATE NOT NULL,
    active             BOOLEAN NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pm_due ON pm_schedule(next_due_on) WHERE active;

ALTER TABLE work_order
    ADD CONSTRAINT fk_wo_pm_schedule FOREIGN KEY (pm_schedule_id) REFERENCES pm_schedule(id);
-- One open WO per PM occurrence: prevents the nightly job generating duplicates on retry
CREATE UNIQUE INDEX uq_wo_open_pm
    ON work_order(pm_schedule_id) WHERE pm_schedule_id IS NOT NULL AND status NOT IN ('COMPLETED','CANCELLED');

-- ─────────────────────────────────────────────────────────────
-- Human-in-the-loop approvals (gated tools write here instead of acting)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE approval (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id         UUID NOT NULL REFERENCES agent_run(id),
    property_id    UUID NOT NULL REFERENCES property(id),
    action_type    VARCHAR(40) NOT NULL
                   CHECK (action_type IN ('SEND_VENDOR_EMAIL','CLOSE_WORK_ORDER','CANCEL_WORK_ORDER','REASSIGN_IN_PROGRESS')),
    target_id      UUID,                         -- usually a work_order id
    payload        JSONB NOT NULL,               -- exact arguments that will execute on approval
    rationale      TEXT NOT NULL,
    status         VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','EXECUTED','FAILED')),
    decided_by     UUID REFERENCES app_user(id),
    decided_at     TIMESTAMPTZ,
    decision_note  TEXT,
    expires_at     TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_approval_pending ON approval(property_id, created_at) WHERE status = 'PENDING';

-- ─────────────────────────────────────────────────────────────
-- Notifications + digests
-- ─────────────────────────────────────────────────────────────
CREATE TABLE notification (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id  UUID NOT NULL REFERENCES app_user(id),
    kind          VARCHAR(30) NOT NULL CHECK (kind IN ('EMERGENCY','ASSIGNMENT','APPROVAL_NEEDED','DIGEST','STATUS')),
    title         VARCHAR(200) NOT NULL,
    body          TEXT NOT NULL,
    link_path     VARCHAR(300),                  -- frontend route, e.g. /work-orders/{id}
    agent_run_id  UUID REFERENCES agent_run(id),
    read_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notification_unread ON notification(recipient_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE digest (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id  UUID NOT NULL REFERENCES property(id),
    run_id       UUID NOT NULL REFERENCES agent_run(id),
    digest_date  DATE NOT NULL,
    summary      TEXT NOT NULL,
    items        JSONB NOT NULL,                 -- [{type, severity, title, detail, ref_type, ref_id}]
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (property_id, digest_date)
);
