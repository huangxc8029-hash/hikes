import { useMemo } from 'react'
import { View, Text } from '@tarojs/components'
import { slopeColumns, slopeSeries, slopeText } from '../services/slope'
import './SlopeChart.scss'

type Props = {
  km?: number | null
  elevationM?: number[] | null
  profile?: number[] | null
  peaks?: Array<{ km: number; altitude?: number; name?: string }>
  /** 分段清单里最多显示几段 */
  maxRows?: number
}

/**
 * 坡度图：网页版（app/js/app.js apiProfileSVG）用的是内联 SVG，小程序里不能内联 SVG，
 * 所以改成"一根根竖条"的 View 实现——纵轴还是海拔、颜色还是那一小段的坡度档、
 * 分段口径完全走 services/slope.ts（与网页版同一套算法）。
 */
export default function SlopeChart({ km, elevationM, profile, peaks = [], maxRows = 8 }: Props) {
  const series = useMemo(() => slopeSeries({ km, elevationM, profile }), [km, elevationM, profile])
  const columns = useMemo(() => slopeColumns(series, 72), [series])
  const rows = useMemo(() => series.bands.filter(band => band.km >= 0.15).slice(0, maxRows), [series, maxRows])

  if (!series.profile.length) {
    return <View className='slope-card'>
      <Text className='slope-title'>坡度图</Text>
      <Text className='subtle'>这条线路还没有坡度剖面数据。</Text>
    </View>
  }

  const prof = series.profile
  const minAlt = Math.round(Math.min(...prof))
  const maxAlt = Math.round(Math.max(...prof))
  const totalKm = km || 0

  return <View className='slope-card'>
    <View className='slope-head'>
      <Text className='slope-title'>坡度图</Text>
      <Text className='subtle'>{series.hasElevation ? '颜色 = 该段坡度' : '估算（缺海拔数据）'}</Text>
    </View>
    <View className='slope-plot'>
      <View className='slope-axis'>
        <Text className='slope-axis-label'>{maxAlt} m</Text>
        <Text className='slope-axis-label'>{Math.round((maxAlt + minAlt) / 2)} m</Text>
        <Text className='slope-axis-label'>{minAlt} m</Text>
      </View>
      <View className='slope-canvas'>
        {columns.map((col, index) => <View
          key={index}
          className='slope-col'
          style={{ left: `${col.leftPct}%`, width: `${col.widthPct}%`, height: `${col.heightPct}%`, background: col.color }}
        />)}
        {(peaks || []).filter(peak => peak.km != null && totalKm > 0).map((peak, index) => <View
          key={`p${index}`}
          className='slope-peak'
          style={{ left: `${Math.min(99, (peak.km / totalKm) * 100)}%` }}
        >
          <View className='slope-peak-dot' />
          <Text className='slope-peak-label'>{peak.name || '山顶'}</Text>
        </View>)}
      </View>
    </View>
    <View className='slope-foot'><Text className='subtle'>0 km</Text><Text className='subtle'>{totalKm ? `${totalKm} km` : ''}</Text></View>
    <View className='slope-legend'>
      <View className='slope-legend-item'><View className='slope-dot' style={{ background: '#52B44A' }} /><Text>≤15% 缓</Text></View>
      <View className='slope-legend-item'><View className='slope-dot' style={{ background: '#2563EB' }} /><Text>15–25% 中</Text></View>
      <View className='slope-legend-item'><View className='slope-dot' style={{ background: '#9E1B1B' }} /><Text>&gt;25% 陡</Text></View>
    </View>
    {rows.length > 0 && <View className='slope-table'>
      {rows.map((band, index) => <View className='slope-row' key={`${band.from}-${band.to}`}>
        <View className='slope-dot' style={{ background: band.color }} />
        <Text className='slope-row-no'>第 {index + 1} 段</Text>
        <Text className='slope-row-km'>{band.fromKm.toFixed(1)}–{band.toKm.toFixed(1)} km</Text>
        <Text className='slope-row-pct'>平均坡度 {Math.round(band.pct)}%</Text>
        <Text className='slope-row-lv' style={{ color: band.color }}>{slopeText(band.level)}</Text>
      </View>)}
    </View>}
    <Text className='slope-hint'>按坡度自动分段：≤15% 缓 · 15–25% 中 · &gt;25% 陡；下坡与上坡按同一个绝对坡度看待。</Text>
  </View>
}
