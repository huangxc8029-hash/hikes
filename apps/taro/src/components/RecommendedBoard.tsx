import { useEffect, useRef, useState } from 'react'
import { View, Text } from '@tarojs/components'
import './RecommendedBoard.scss'

type Route = {
  slug: string
  name: string
  city?: string | null
  km?: number | null
  up?: number | null
  hours?: number | null
  heatTier?: string | null
  kind?: string
}

type Props = {
  routes: Route[]
  /** 换牌间隔，网页版首页用的就是 3 秒 */
  intervalMs?: number
  onOpen: (route: Route) => void
}

/**
 * 机场信息牌式推荐位：每 3 秒翻牌换一条线路。
 * 与网页版（app/js/app.js 的 hf-flip / is-swapping）同一套动作：绕 X 轴翻下去 →
 * 在"翻面"那一刻换内容 → 翻回来，所以看到的线路和点进去的线路始终是同一条。
 * 手指按住时暂停（别在人正要点的瞬间把卡片换掉）。
 */
export default function RecommendedBoard({ routes, intervalMs = 3000, onOpen }: Props) {
  const [index, setIndex] = useState(0)
  const [swapping, setSwapping] = useState(false)
  const paused = useRef(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const flipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (routes.length < 2) return
    timer.current = setInterval(() => {
      if (paused.current) return
      setSwapping(true)
      // 翻到一半时换内容：时长与 CSS 里的 transition 对齐
      flipTimer.current = setTimeout(() => {
        setIndex(current => {
          let next = current
          let guard = 0
          // 别抽到刚展示过的那条，否则看着像卡住了
          while (next === current && guard < 12) {
            next = Math.floor(Math.random() * routes.length)
            guard += 1
          }
          return next
        })
        setSwapping(false)
      }, 280)
    }, intervalMs)
    return () => {
      if (timer.current) clearInterval(timer.current)
      if (flipTimer.current) clearTimeout(flipTimer.current)
    }
  }, [routes.length, intervalMs])

  const route = routes[Math.min(index, Math.max(0, routes.length - 1))]
  if (!route) return null

  return <View
    className='rec-board'
    onTouchStart={() => { paused.current = true }}
    onTouchEnd={() => { paused.current = false }}
    onTouchCancel={() => { paused.current = false }}
    onClick={() => onOpen(route)}
  >
    <View className='rec-board-head'>
      <Text className='rec-board-label'>DEPARTURES</Text>
      <Text className='rec-board-hint'>今日推荐 · 每 3 秒换一条</Text>
    </View>
    <View className={`rec-board-body${swapping ? ' is-swapping' : ''}`}>
      <View className='rec-board-main'>
        <Text className='rec-board-name'>{route.name}</Text>
        <Text className='rec-board-km'>{route.km != null ? `${route.km} km` : '—'}</Text>
      </View>
      <View className='rec-board-meta'>
        <Text className='rec-board-cell'>{route.city || '山野路线'}</Text>
        <Text className='rec-board-cell'>爬升 {route.up != null ? `${route.up} m` : '—'}</Text>
        <Text className='rec-board-cell'>{route.hours ? `约 ${route.hours} 小时` : '用时待记录'}</Text>
      </View>
      <View className='rec-board-foot'>
        {route.heatTier && <Text className='rec-board-tier'>{route.heatTier}</Text>}
        <Text className='rec-board-cta'>找路线 ›</Text>
      </View>
    </View>
  </View>
}
