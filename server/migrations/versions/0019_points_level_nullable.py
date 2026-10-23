"""点位难度允许为空：不评级是真实状态，不该被默认写成 mid。

`0007_segment_difficulty_nullable` 已经把 route_segments.level 放开；点位难度是从
所在分段抄过来的，分段不评级时点位也就没有难度。回填峰点（seeds/backfill_peak_points.py）
会写 NULL，这里放开约束，否则整批导入直接 IntegrityError。
"""
from alembic import op

revision = "0019_points_level_nullable"
down_revision = "0018_trailhead_review_audit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE points ALTER COLUMN level DROP NOT NULL")


def downgrade() -> None:
    raise RuntimeError("This migration is restored from a pre-release backup")
