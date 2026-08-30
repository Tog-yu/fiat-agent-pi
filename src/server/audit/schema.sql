-- fiat_agent 审计表（L2 PostgreSQL）
-- 写入时机：每次工具调用经三道闸门裁决后，由 audit-hook 经 AuditClient 落库。
-- 读取：L2 审计后台 / 合规查询。

CREATE TABLE IF NOT EXISTS fiat_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id  TEXT        NOT NULL,
  user_id     TEXT        NOT NULL,
  role        TEXT        NOT NULL,
  environment TEXT        NOT NULL,
  tool        TEXT        NOT NULL,
  input       JSONB       NOT NULL,
  is_error    BOOLEAN     NOT NULL,
  outcome     TEXT        NOT NULL CHECK (outcome IN ('allowed', 'blocked', 'error')),
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_session ON fiat_audit_log (session_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts     ON fiat_audit_log (ts);
CREATE INDEX IF NOT EXISTS idx_audit_user   ON fiat_audit_log (user_id, role);
