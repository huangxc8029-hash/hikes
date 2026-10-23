// 坡度分段的算法：和网页版 app/js/app.js 的 slopeBands() 是同一套口径，
// 逐字搬过来是为了小程序与网页版给出同一个颜色、同一段序号。
// 关键约定：
//   · 剖面是等距重采样的，相邻两点的水平距离 = 总里程 /（点数-1）
//   · 用 ±0.4 km 滑动窗口估坡度，单点相邻高差会抖成噪点
//   · 窗口内取绝对高差之和，下坡的陡也是陡（方向不抵消）
//   · 不到全程 1.5% 又不到 0.5 km 的碎段并进前一段，否则颜色条会碎成噪点
export type SlopeLevel = 'easy' | 'mid' | 'hard'

export type SlopeBand = {
  level: SlopeLevel
  color: string
  from: number
  to: number
  km: number
  fromKm: number
  toKm: number
  pct: number
}

export type SlopeSeries = {
  profile: number[]
  bands: SlopeBand[]
  stepKm: number
  hasElevation: boolean
}

const SLOPE_BANDS: Array<{ max: number; level: SlopeLevel; color: string }> = [
  { max: 15, level: 'easy', color: '#52B44A' },
  { max: 25, level: 'mid', color: '#2563EB' },
  { max: Number.MAX_VALUE, level: 'hard', color: '#9E1B1B' }
]

export function slopeBandOf(pct: number): { level: SlopeLevel; color: string } {
  const band = SLOPE_BANDS.find(item => pct <= item.max) || SLOPE_BANDS[SLOPE_BANDS.length - 1]
  return { level: band.level, color: band.color }
}

export function slopeText(level: SlopeLevel): string {
  return level === 'easy' ? '缓' : level === 'mid' ? '中' : '陡'
}

export function slopeSeries(input: {
  km?: number | null
  elevationM?: number[] | null
  profile?: number[] | null
}): SlopeSeries {
  const hasElevation = (input.elevationM || []).length >= 2
  const prof = hasElevation ? (input.elevationM as number[]) : (input.profile || [])
  const n = prof.length
  const empty: SlopeSeries = { profile: prof, bands: [], stepKm: 0, hasElevation }
  if (n < 2 || !input.km) return empty
  const stepKm = input.km / (n - 1)
  if (!stepKm) return empty

  const win = Math.max(1, Math.round(0.4 / stepKm))
  const windowSlope = (i: number): number => {
    const a = Math.max(0, i - win)
    const b = Math.min(n - 1, i + win)
    let rise = 0
    let dist = 0
    for (let k = a; k < b; k += 1) {
      rise += Math.abs(prof[k + 1] - prof[k])
      dist += stepKm
    }
    return dist > 0 ? (rise / (dist * 1000)) * 100 : 0
  }

  type Raw = { level: SlopeLevel; color: string; from: number; to: number }
  const raw: Raw[] = []
  for (let i = 1; i < n; i += 1) {
    const band = slopeBandOf(windowSlope(i))
    const last = raw[raw.length - 1]
    if (last && last.level === band.level) last.to = i
    else raw.push({ level: band.level, color: band.color, from: i - 1, to: i })
  }

  const minKm = Math.max(0.5, (input.km || 0) * 0.015)
  const merged: Raw[] = []
  raw.forEach(band => {
    const last = merged[merged.length - 1]
    if (last && ((band.to - band.from) * stepKm < minKm || last.level === band.level)) last.to = band.to
    else merged.push({ ...band })
  })
  if (merged.length > 1 && (merged[0].to - merged[0].from) * stepKm < minKm) {
    merged[1].from = merged[0].from
    merged.shift()
  }

  const bands: SlopeBand[] = merged.map(band => {
    let rise = 0
    for (let k = band.from; k < band.to; k += 1) rise += Math.abs(prof[k + 1] - prof[k])
    const km = (band.to - band.from) * stepKm
    const pct = km > 0 ? (rise / (km * 1000)) * 100 : 0
    const mapped = slopeBandOf(pct)
    return {
      level: mapped.level,
      color: mapped.color,
      from: band.from,
      to: band.to,
      km,
      fromKm: band.from * stepKm,
      toKm: band.to * stepKm,
      pct
    }
  })
  return { profile: prof, bands, stepKm, hasElevation }
}

// 坡度图要画成一根根竖条：把剖面重采样到固定列数，每列记高度比与颜色档。
export type SlopeColumn = { leftPct: number; widthPct: number; heightPct: number; color: string }

export function slopeColumns(series: SlopeSeries, columns = 72): SlopeColumn[] {
  const prof = series.profile
  if (prof.length < 2 || !series.stepKm) return []
  const min = Math.min(...prof)
  const max = Math.max(...prof)
  const span = max - min || 1
  const totalKm = series.stepKm * (prof.length - 1)
  const out: SlopeColumn[] = []
  const count = Math.min(columns, prof.length - 1)
  for (let i = 0; i < count; i += 1) {
    const kmFrom = (totalKm * i) / count
    const kmTo = (totalKm * (i + 1)) / count
    const midIdx = Math.min(prof.length - 1, Math.max(0, Math.round(((kmFrom + kmTo) / 2) / series.stepKm)))
    const band = bandAt(series, midIdx)
    out.push({
      leftPct: (kmFrom / totalKm) * 100,
      widthPct: 100 / count,
      heightPct: Math.max(4, ((prof[midIdx] - min) / span) * 100),
      color: band
    })
  }
  return out
}

function bandAt(series: SlopeSeries, idx: number): string {
  const hit = series.bands.find(band => idx >= band.from && idx <= band.to)
  return hit ? hit.color : '#8A94A6'
}
