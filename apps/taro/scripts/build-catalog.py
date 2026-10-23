"""Build a read-only mini-program catalog from repository source data.

Run from any directory. This snapshot is for browsing when the API is not connected;
check-ins, comments, account data and live popularity always require the API.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUTPUT = Path(__file__).resolve().parents[1] / "src" / "data" / "catalog.json"

routes = []
for filename in ("routes.json", "routes_cn.json", "race_routes.json"):
    source = json.loads((ROOT / "pipeline" / "out" / filename).read_text(encoding="utf-8"))
    for slug, route in source.items():
        routes.append({
            "slug": slug,
            "name": route.get("name") or slug,
            "city": route.get("city"),
            "km": route.get("km"),
            "up": route.get("up"),
            "hours": route.get("hours"),
            "peak_count": len(route.get("peaks") or []),
            "hardest_level": (route.get("hardest") or {}).get("level"),
            "kind": "race" if filename == "race_routes.json" else "hiking",
        })

peaks_source = json.loads((ROOT / "outputs" / "china-peaks-100" / "中国热门徒步登山山峰100座.json").read_text(encoding="utf-8"))
peaks = [{
    "name": peak["name"],
    "region": peak.get("region"),
    "elevation": peak.get("elevation_m"),
    "intro": peak.get("intro"),
    "heatTier": peak.get("heat_tier"),
} for peak in peaks_source["peaks"]]

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps({"routes": routes, "peaks": peaks}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"Wrote {len(routes)} routes and {len(peaks)} peaks to {OUTPUT}")
