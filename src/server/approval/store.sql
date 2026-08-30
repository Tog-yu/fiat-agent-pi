-- 审批工单表（阶段 5 / P5-19）—— L2 PostgreSQL
-- token 明文不落库，只存 sha256；status 机：pending → approved/rejected → applied（或 expired）

CREATE TABLE IF NOT EXISTS fiat_approval_tickets (
    ticket_id       TEXT PRIMARY KEY,
    tool            TEXT NOT NULL,                       -- 底层 L4 工具名（cashback_reconcile 等）
    subject         JSONB NOT NULL,                      -- { userId, role, environment }
    payload         JSONB NOT NULL,                      -- 待执行的变更计划
    status          TEXT NOT NULL
                    CHECK (status IN ('pending','approved','rejected','applied','expired')),
    idempotency_key TEXT NOT NULL,                       -- 相同键不重复建单
    token_hash      TEXT NOT NULL,                       -- sha256(一次性 token)
    expires_at      BIGINT NOT NULL,                     -- ms epoch，过期单无法 apply
    created_at      BIGINT NOT NULL,
    approved_at     BIGINT,
    applied_at      BIGINT,
    lark_message_id TEXT,                                -- Lark 审批卡 message id
    UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_tickets_idempotency ON fiat_approval_tickets (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON fiat_approval_tickets (status);
