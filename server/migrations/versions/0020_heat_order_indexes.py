"""山头热度排序要用的两个索引。

`GET /api/routes` 与 `GET /api/summits` 现在按"互联网热度档"排序（数据来自
名山资料库 `mountains.heat_tier`）。线路没有自己的热度字段，热度取自线路峰点
1.5 km 内最近的有资料山头，所以要对 `mountains.geom` 做空间检索；
`/api/summits` 还要按线路取峰点。两个索引都只是加速，不改变任何数据。
"""
from alembic import op

revision = "0020_heat_order_indexes"
down_revision = "0019_points_level_nullable"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE INDEX IF NOT EXISTS idx_mountains_geom ON mountains USING GIST (geom)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_points_route_type "
               "ON points (route_id, type)")


def downgrade() -> None:
    raise RuntimeError("This migration is restored from a pre-release backup")
