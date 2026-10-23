"""给每一个山顶（和每条线路的山脚）补出真正的点位。

在这之前，库里只有 12 条线路各一个扫码点——「给每一个山峰一个打卡点」这句话
在数据层根本落不了地：山顶没有点位，就没有编号、没有二维码、扫码扫不到、
留言没地方挂、山径拼图也就无从点亮。

编号规则：`{线路缩写}-{序号}`，山脚是 `-S`。例如

    SF-S    三峰连穿 山脚
    SF-01   三峰连穿 第 1 个顶
    DLS-01  东灵山主峰 第 1 个顶

可重复执行（按 code upsert）。点位 id 不变，已发的编号不会重排。

    docker compose exec api python /srv/seeds/backfill_peak_points.py
"""
import sys

sys.path.insert(0, "/srv")
from app.main import engine  # noqa: E402
from sqlalchemy import text  # noqa: E402

# 缩写要唯一、能印在标牌上。不用拼音首字母硬推——12 条里必然会撞（XBL / XZX / XTR）。
ABBR = {
    "baipusi": "BPS", "baiwala": "BWL", "donglingshan": "DLS",
    "fenghuangling": "FHL", "jiankou": "JKN", "jingxigudao": "JXG",
    "sanfeng": "SF", "taoxin": "TX", "xiangbala": "XBL",
    "xiangzhixian": "XZX", "xiaotaoren": "XTR", "yudushan": "YDS",
}

# 赛事路线（slug 形如 dajingmen-dgw100-2026）也在这里登记。
# 必须显式写：兜底的 slug[:3] 对同一场赛事的各距离组别是同一个前缀
# （dajingmen-dgw100 / dajingmen-cgw70 都取到 DAJ），编号会互相覆盖，
# 而编号一旦发出去就不该重排。
ABBR.update({
    # 缩写 + "-序号" 要印在标牌上，所以前缀压到 6 个字符以内
    "mount-yun-100m-2026": "YQ100M", "mount-yun-100k-2026": "YQ100K",
    "mount-yun-50k-2026": "YQ50K", "mount-yun-30k-2026": "YQ30K",
    "mount-yun-20k-2026": "YQ20K", "mount-yun-10k-1-2026": "YQ10KA",
    "mount-yun-10k-2-2026": "YQ10KB", "mount-yun-3k-2026": "YQ3K",
    "dajingmen-dgw100-2026": "DJGDGW", "dajingmen-cgw70-2026": "DJGCGW",
    "dajingmen-mgw50-2026": "DJGMGW", "dajingmen-ngw30-2026": "DJGNGW",
    "shudao-100k-2026": "SD100K", "shudao-70k-2026": "SD70K",
    "shudao-50k-2026": "SD50K", "shudao-20k-2026": "SD20K",
    "mogan-dmg-2026": "MGDMG", "mogan-cmg-2026": "MGCMG",
    "mogan-mmg-2026": "MGMMG", "mogan-emg-2026": "MGEMG",
    "xiamen-100k-2026": "XM100K", "xiamen-50k-2026": "XM50K", "xiamen-20k-2026": "XM20K",
    "ninghai-utnh-2026": "NHUTNH", "ninghai-cnh-2026": "NHCNH", "ninghai-ynh-2026": "NHYNH",
    "translantau-tl100-2026": "TL100", "translantau-tl50-2026": "TL50",
    "translantau-tl25-2026": "TL25", "translantau-tl15-2026": "TL15",
    "hk100-full-2027": "HKF", "hk100-half-2027": "HKH", "hk100-third-2027": "HKT",
})

# 2026-10 第二批赛事路线（微步/洛基平台官方轨迹）。
# 同一场赛事跨年份时，**当届拿干净编号，往届加 A/B 后缀**——编号要印在标牌上，
# 越短越好，而往届赛道基本不会再发牌。
ABBR.update({
    # 崇礼 168（2026 只发了云顶30，其余组别当届未发布，先用 2025/2024 的官方轨迹）
    "chongli168-yunding30-2026": "CL30", "chongli168-yunding30-2025": "CL30A",
    "chongli168-168-2025": "CL168", "chongli168-100-2025": "CL100",
    "chongli168-xueruyi70-2025": "CLXR70", "chongli168-taiwu50-2025": "CLTW50",
    "chongli168-aranya10w-2025": "CLAW10", "chongli168-aranya10y-2025": "CLAY10",
    "chongli168-utc168-2024": "CLU168", "chongli168-dtc100-2024": "CLD100",
    "chongli168-mtc70-2024": "CLM70", "chongli168-ttc50-2024": "CLT50",
    "chongli168-etc30-2024": "CLE30",
    # 柴古唐斯·括苍（2026 未发布，2025/2024 官方轨迹）
    "chaigutangs-105k-2025": "CG105", "chaigutangs-50k-2025": "CG50", "chaigutangs-25k-2025": "CG25",
    "chaigutangs-105k-2024": "CG105A", "chaigutangs-50k-2024": "CG50A", "chaigutangs-25k-2024": "CG25A",
    # 武功山（2026）
    "wugongshan-100k-2026": "WG100", "wugongshan-56k-2026": "WG56",
    "wugongshan-33k-2026": "WG33", "wugongshan-13k-2026": "WG13", "wugongshan-tj-2026": "WGTJ",
    # 龙脊梯田（2026）
    "longji-100k-2026": "LJ100", "longji-50k-2026": "LJ50", "longji-30k-2026": "LJ30",
    "longji-15k-2026": "LJ15", "longji-6k-2026": "LJ6",
    # 杭州大宋 108（2026 全套 + 2025）
    "dasong108-108k-2026": "DS108", "dasong108-72k-2026": "DS72", "dasong108-42k-2026": "DS42",
    "dasong108-21k-2026": "DS21", "dasong108-6k-2026": "DS6",
    "dasong108-42k-2025": "DS42A", "dasong108-21k-2025": "DS21A",
    # 熊猫蜀道山（2026/2025/2024）
    "panda-160k-2026": "PD160", "panda-105k-2026": "PD105", "panda-60k-2026": "PD60",
    "panda-25k-2026": "PD25",
    "panda-160k-2025": "PD160A", "panda-105k-2025": "PD105A", "panda-60k-2025": "PD60A",
    "panda-25k-2025": "PD25A",
    "panda-105k-2024": "PD105B", "panda-50k-2024": "PD50", "panda-25k-2024": "PD25B",
    # 西双版纳勐海（2026）
    "menghai-100k-2026": "MH100", "menghai-60k-2026": "MH60",
    "menghai-30k-2026": "MH30", "menghai-6k-2026": "MH6",
    # 环五台山（2025；2026 未发布）
    "wutaishan-50k-2025": "WT50", "wutaishan-21k-2025": "WT21", "wutaishan-12k-2025": "WT12",
    # 长江三峡（巫山）2025；广州 100 2024；永泰大青云 2023
    "wushan-60k-2025": "WS60", "wushan-25k-2025": "WS25",
    "guangzhou100-100k-2024": "GZ100", "guangzhou100-60k-2024": "GZ60", "guangzhou100-30k-2024": "GZ30",
    "daqingyun-40k-2023": "DQY40", "daqingyun-20k-2023": "DQY20",
})

# 六只脚那批区域线路（slug = fff-<六只脚轨迹号>）。同样必须显式登记：
# 兜底取 slug[:3] 会得到 "FFF"，52 条线路会全部撞在同一个编号空间里。
# 名字和北京那批重复的（三峰连穿、香八拉、箭扣…）在缩写后加 2——
# 它们是同一条山径的另一条轨迹，不是同一条线路。
ABBR.update({
    "fff-100015705": "LFS", "fff-100024497": "SLLD", "fff-100029741": "NJZJS",
    "fff-100030572": "SHSS", "fff-100040266": "JXG2", "fff-100042995": "QCS",
    "fff-100057534": "SMS", "fff-100067064": "SYQS", "fff-100072456": "QDH",
    "fff-100077790": "DLS2", "fff-100083889": "HTS", "fff-100103540": "GZBYS",
    "fff-100104284": "XBL2", "fff-100107939": "LQS", "fff-100116342": "YLS",
    "fff-100118636": "ZZSS", "fff-100120806": "JKN2", "fff-100122469": "FHL2",
    "fff-100123857": "EMS", "fff-100127086": "HHDQS", "fff-100129080": "YBCBS",
    "fff-100130168": "XZWTS", "fff-100130271": "XAHS", "fff-100132968": "JNTS",
    "fff-100134068": "JFS", "fff-100142081": "SF2", "fff-10051327": "ZGS",
    "fff-10073583": "YCHLS", "fff-10075401": "NBS", "fff-10090735": "SZLYS",
    "fff-10130773": "DBS", "fff-10186909": "WTS", "fff-10189971": "MGS",
    "fff-10243300": "GYQLS", "fff-332555": "DSS", "fff-3831680": "BWL2",
    "fff-8143472": "GGS", "fff-8412216": "CDD", "fff-8559686": "HXH",
    "fff-8794039": "PYS", "fff-8869357": "TTLZ", "fff-9177898": "BLS",
    "fff-9602039": "KMXS", "fff-9650040": "DXC", "fff-9652387": "CQJYS",
    "fff-9706010": "TMQJ", "fff-9793080": "LMS", "fff-9832474": "HLS",
    "fff-9845194": "QNS", "fff-99951004": "SGNS", "fff-99984929": "HHGD",
    "fff-99985936": "FZGS",
})


def abbr_for(slug: str) -> str:
    """取编号前缀：显式登记过的用登记值，其余按 slug 稳定推导。

    为什么要推导而不是 slug[:3]：赛事 slug 是「赛事-组别-年份」，
    前 3 位对同一场赛事的每个组别都一样（chongli168-* 全取到 CHO），
    编号会互相覆盖。这里取"每段前 3 个字符拼起来"，同一场赛事的不同组别自然分开：
    chongli168-utc168-2024 → CHOUTC、chongli168-dtc100-2024 → CHODTC。
    纯年份那一段跳过。推导只依赖 slug 本身，不依赖"当前有哪些线路"，
    所以以后新增线路不会让已发出的编号漂移。
    """
    import re as _re
    if slug in ABBR:
        return ABBR[slug]
    toks = [t for t in _re.findall(r"[a-z0-9]+", slug.lower())
            if not _re.fullmatch(r"20\d\d", t)]
    base = "".join(t[:3] for t in toks)[:6].upper()
    return base or slug[:3].upper()


def check_abbr(routes):
    """编号前缀撞车就直接报错退出——宁可不发编号，也不能让两个顶共用一个码。"""
    seen = {}
    for r in routes:
        key = abbr_for(r["slug"])
        if key in seen:
            raise SystemExit(
                f"编号前缀撞车：{key} 同时属于 {seen[key]} 和 {r['slug']}，"
                f"请在 ABBR 里显式登记其中一个")
        seen[key] = r["slug"]


def main():
    n_start = n_peak = 0
    with engine.begin() as c:
        routes = c.execute(text("SELECT id, slug, name FROM routes ORDER BY id")).mappings().all()
        check_abbr(routes)
        for r in routes:
            ab = abbr_for(r["slug"])

            segs = c.execute(text("""SELECT no, to_km, km, rise, level
                FROM route_segments WHERE route_id = :r ORDER BY no"""), {"r": r["id"]}).mappings().all()
            peaks = c.execute(text("""SELECT idx, km, altitude, name, lat, lng, mountain_id
                FROM route_peaks WHERE route_id = :r ORDER BY idx"""), {"r": r["id"]}).mappings().all()
            if not peaks:
                continue

            # 山脚：起点本身没有海拔和坐标数据，先留空——它照样能扫码打卡，
            # "完整记录 / 登顶用时"要的只是山脚和山顶两次打卡的时间差。
            start_code = ab + "-S"
            c.execute(text("""INSERT INTO points (code, type, name, route_id, index_in_route,
                                total_in_route, level, status)
                VALUES (:code, 'trailhead', NULL, :r, 0, :total, 'easy', 'published')
                ON CONFLICT (code) DO UPDATE SET total_in_route = EXCLUDED.total_in_route"""),
                {"code": start_code, "r": r["id"], "total": len(peaks)})
            pid = c.execute(text("SELECT id FROM points WHERE code = :c"), {"c": start_code}).scalar()
            c.execute(text("""INSERT INTO short_links (code, point_id) VALUES (:c, :p)
                              ON CONFLICT (code) DO NOTHING"""), {"c": start_code, "p": pid})
            n_start += 1

            for p in peaks:
                code = f"{ab}-{p['idx'] + 1:02d}"
                mountain_id = p["mountain_id"]
                if mountain_id is None:
                    mountain_id = c.execute(text("""INSERT INTO mountains
                        (stable_key, name, altitude, name_status)
                        VALUES (:key, :name, :alt, :status)
                        ON CONFLICT (stable_key) DO UPDATE SET stable_key = EXCLUDED.stable_key
                        RETURNING id"""),
                        {"key": f"legacy-route-peak:{r['id']}:{p['idx']}",
                         "name": p["name"], "alt": p["altitude"],
                         "status": "candidate" if p["name"] else "unconfirmed"}).scalar_one()
                    c.execute(text("""UPDATE route_peaks SET mountain_id = :m
                        WHERE route_id = :r AND idx = :idx"""),
                        {"m": mountain_id, "r": r["id"], "idx": p["idx"]})
                    c.execute(text("""INSERT INTO boards (board_type, mountain_id)
                        VALUES ('summit', :m) ON CONFLICT (mountain_id) DO NOTHING"""),
                        {"m": mountain_id})
                # 这个顶的难度 = 通向它的那一段的难度（离它最近的那段）
                seg = min(segs, key=lambda s: abs(float(s["to_km"]) - float(p["km"]))) if segs else None
                c.execute(text("""INSERT INTO points
                    (code, type, name, route_id, index_in_route, total_in_route,
                     level, altitude, geom, status, mountain_id)
                    VALUES (:code, 'peak', :name, :r, :idx, :total, :lv, :alt,
                            CASE WHEN CAST(:lat AS double precision) IS NULL THEN NULL
                                 ELSE ST_SetSRID(ST_MakePoint(CAST(:lng AS double precision),
                                                              CAST(:lat AS double precision)), 4326) END,
                            'published', :mountain_id)
                    ON CONFLICT (code) DO UPDATE SET
                        name = EXCLUDED.name, altitude = EXCLUDED.altitude,
                        level = EXCLUDED.level, geom = EXCLUDED.geom,
                        index_in_route = EXCLUDED.index_in_route,
                        total_in_route = EXCLUDED.total_in_route,
                        mountain_id = COALESCE(points.mountain_id, EXCLUDED.mountain_id)"""),
                    {"code": code, "name": p["name"], "r": r["id"], "idx": p["idx"] + 1,
                     "total": len(peaks), "mountain_id": mountain_id,
                     # 通向这个顶的分段不评级时，点位难度就是 NULL，不要编成 mid
                     "lv": (seg or {}).get("level"),
                     "alt": p["altitude"], "lat": p["lat"], "lng": p["lng"]})
                pid = c.execute(text("SELECT id FROM points WHERE code = :c"), {"c": code}).scalar()
                c.execute(text("""INSERT INTO short_links (code, point_id) VALUES (:c, :p)
                                  ON CONFLICT (code) DO NOTHING"""), {"c": code, "p": pid})
                n_peak += 1

    print(f"✓ {len(routes)} 条线路 · {n_start} 个山脚点位 · {n_peak} 个山顶点位（各自带编号和二维码）")


if __name__ == "__main__":
    main()
