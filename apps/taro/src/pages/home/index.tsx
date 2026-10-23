import { useState } from 'react'
import { View, Text, Image } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { request, requestWithGuest } from '../../services/api'
import landscape from '../../assets/home-landscape.jpg'
import hiker from '../../assets/home-hiker.png'
import logo from '../../assets/logo-mark.png'
import './index.scss'

type Receipt = { visitId:number;code:string;name?:string;kind:string;seq:number;visitedAt:string;durationS?:number|null;effortReason?:string|null }
type Mine = { mountainId:number;name:string;myLastVisitedAt:string;visitorCount:number }
type Ranked = { mountainId?:number;name:string;people?:number }
type Climber = { nickname?:string; mountainCount?:number; visitCount?:number }
export default function Home() {
  const [receipts,setReceipts]=useState<Receipt[]>([])
  const [mine,setMine]=useState<Mine[]>([]); const [ranking,setRanking]=useState<Ranked[]>([])
  const [climbers,setClimbers]=useState<Climber[]>([])
  const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState('')
  const load = async () => {
    setLoading(true); setLoadError('')
    const results = await Promise.all([
      request<{items:Ranked[]}>('/api/boards/mountains?window=week&metric=people&limit=5').then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error })),
      request<{items:Climber[]}>('/api/boards/climbers?window=week&limit=3').then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error })),
      (Taro.getStorageSync('hikes.auth.token') ? request<Mine[]>('/api/me/mountain-summary?limit=3') : Taro.getStorageSync('hikes.guest.token') ? requestWithGuest<Mine[]>('/api/guest/mountain-summary?limit=3',Taro.getStorageSync('hikes.guest.token')) : Promise.resolve([])).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error })),
      (Taro.getStorageSync('hikes.auth.token')
        ? request<Receipt[]>('/api/me/visit-receipts?limit=5')
        : Taro.getStorageSync('hikes.guest.token')
          ? requestWithGuest<Receipt[]>('/api/guest/visit-receipts?limit=5', Taro.getStorageSync('hikes.guest.token'))
          : Promise.resolve([])).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
    ])
    if (results[0].ok) setRanking(results[0].value.items || [])
    if (results[1].ok) setClimbers(results[1].value.items || [])
    if (results[2].ok) setMine(results[2].value || [])
    if (results[3].ok) setReceipts(results[3].value || [])
    if (results.some(result => !result.ok)) setLoadError('实时数据暂未连接；山头和路书可先浏览仓库收录的资料。')
    setLoading(false)
  }
  useDidShow(() => { void load() })
  return <View className='page home-page'>
    <View className='home-cover'><Image className='home-cover-image' src={landscape} mode='aspectFill'/><Image className='home-hiker' src={hiker} mode='aspectFit'/><View className='home-logo'><Image src={logo} mode='aspectFit'/><Text>DCYY</Text></View><View className='home-message' onClick={()=>Taro.navigateTo({url:'/pages/messages/index'})}><View className='message-bubble'><View className='message-line'/></View></View></View>
    <View className='home-copy'><Text className='cover-title'>到此一游</Text><Text className='home-description'>一条线路、一座山头、一句现场留言。{ '\n' }把走过的路，留给后来的人。</Text></View>
    <View className='home-actions'><View className='scan-card' onClick={() => Taro.navigateTo({url:'/pages/scan/index'})}><View className='scan-icon'>⌗</View><Text className='scan-title'>扫码打卡</Text></View><View className='nearby-card' onClick={() => Taro.switchTab({url:'/pages/places/index'})}>浏览山头</View></View>
    <View className='section-head'><Text className='section-title'>我的山峰</Text><Text className='more' onClick={()=>Taro.switchTab({url:'/pages/me/index'})}>我的足迹　›</Text></View>
    {mine.length?mine.map(item=><View className='mountain-card' key={item.mountainId} onClick={()=>Taro.navigateTo({url:`/pages/mountain/index?mountainId=${item.mountainId}&name=${encodeURIComponent(item.name)}`})}><Text className='mountain-icon'>山</Text><View className='mountain-info'><Text className='mountain-name'>{item.name}</Text><Text className='subtle'>最近到访 {new Date(item.myLastVisitedAt).toLocaleDateString()} · {item.visitorCount} 位山友来过</Text></View><Text>›</Text></View>):<View className='empty-card'><Text className='subtle'>{loading?'正在读取你的山峰…':'还没有到访记录。去山里扫一扫，留下第一座山。'}</Text></View>}
    {loadError&&<View className='load-error' onClick={()=>void load()}><Text>{loadError}　点击重试</Text></View>}
    <View className='section-head'><Text className='section-title'>我的到访凭证</Text><Text className='more' onClick={()=>Taro.switchTab({url:'/pages/me/index'})}>更多　›</Text></View>{receipts.length?receipts.map(r=><View className='receipt-strip' key={r.visitId}><Text className='receipt-seq'>第 {r.seq} 位</Text><Text className='receipt-place'>{r.name||r.code}</Text><Text className='subtle'>{new Date(r.visitedAt).toLocaleDateString()}</Text></View>):<View className='empty-card'><Text className='subtle'>扫码到访后，凭证会保存在这里。</Text></View>}
    <View className='section-head'><Text className='section-title'>打卡人数榜</Text><Text className='more'>本周</Text></View>
    {ranking.length?ranking.map((item,i)=><View className='ranking-row' key={`${item.mountainId}-${i}`} onClick={()=>item.mountainId&&Taro.navigateTo({url:`/pages/mountain/index?mountainId=${item.mountainId}&name=${encodeURIComponent(item.name)}`})}><Text className='rank-index'>{String(i+1).padStart(2,'0')}</Text><Text className='rank-name'>{item.name}</Text><Text className='subtle'>{item.people||0} 人</Text></View>):<View className='empty-card'><Text className='subtle'>本周还没有打卡记录。</Text></View>}
    <View className='section-head'><Text className='section-title'>位次榜</Text><Text className='more'>本周</Text></View>
    {climbers.length?climbers.map((item,i)=><View className='ranking-row' key={`${item.nickname}-${i}`}><Text className='rank-index'>{String(i+1).padStart(2,'0')}</Text><Text className='rank-name'>{item.nickname||'山友'}</Text><Text className='subtle'>{item.mountainCount??0} 座山头</Text></View>):<View className='empty-card'><Text className='subtle'>连接服务后显示实时位次榜。</Text></View>}
  </View>
}
