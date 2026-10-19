"""注册邮箱验证与平台审核角色管理。新增短期邮箱令牌、角色变更审计，保证系统审核权限不由注册或山头申请自动获得。"""
from alembic import op

revision = "0019_email_and_platform_roles"
down_revision = "0018_trailhead_review_audit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ")
    # Existing accounts predate mandatory email confirmation; grandfather them so this rollout
    # does not lock out users who already had an optional email on file.
    op.execute("UPDATE users SET email_verified_at=now() WHERE email IS NOT NULL AND email_verified_at IS NULL")
    op.execute("""
        CREATE TABLE IF NOT EXISTS email_verification_tokens (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TIMESTAMPTZ NOT NULL,
          consumed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_tokens (user_id, created_at DESC)")
    op.execute("ALTER TABLE system_roles DROP CONSTRAINT IF EXISTS system_roles_role_check")
    op.execute("""
        ALTER TABLE system_roles ADD CONSTRAINT system_roles_role_check CHECK (role IN (
          'ad_reviewer', 'place_curator', 'collaboration_reviewer', 'content_reviewer', 'platform_admin'
        ))
    """)
    op.execute("""
        CREATE TABLE IF NOT EXISTS platform_role_audit_logs (
          id BIGSERIAL PRIMARY KEY,
          actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
          target_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
          role TEXT NOT NULL CHECK (role IN ('ad_reviewer','place_curator','collaboration_reviewer','content_reviewer')),
          action TEXT NOT NULL CHECK (action IN ('grant','revoke')),
          reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 4 AND 500),
          ip_address TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_platform_role_audit_created ON platform_role_audit_logs (created_at DESC)")


def downgrade() -> None:
    raise RuntimeError("This migration is restored from a pre-release backup")
