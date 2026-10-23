import { useState } from 'react'
import { View, Text, Image, Input } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { getErrorMessage, request } from '../../services/api'
import TabHeader from '../../components/TabHeader'
import hero from '../../assets/board-hero.jpg'
import './index.scss'

type Recent = { kind: 'summit'|'junction'|'segment'; name: string; text: string; at: string; target: string }

export default function Board() {
  const [items, setItems] = useState<Recent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query,setQuery] = useState('')
  const [sort,setSort] = useState<'time'|'mountain'>('time')
  const load = async () => {
    setLoading(true); setError('')
    try { setItems(await request<Recent[]>('/api/community/recent')) }
    catch (e) { setError(getErrorMessage(e)) }
    finally { setLoading(false) }
  }
  useDidShow(() => { void load() })
  const visible=items.filter(item=>item.name.includes(query.trim())).sort((a,b)=>sort==='mountain'?a.name.localeCompare(b.name,'zh'):String(b.at).localeCompare(String(a.at)))
  return <View className='page board-page'>
    <View className='board-hero'><Image src={hero} mode='aspectFill'/><TabHeader/><View className='board-hero-copy'><Text className='eyebrow'>MOUNTAIN NOTES</Text><Text className='hero-title'>山友留言版</Text><Text>每句话都来自一座山。看看大家在山上遇见了什么。</Text></View><View className='board-write' onClick={()=>Taro.navigateTo({url:'/pages/scan/index'})}>扫码留言　＋</View></View>
    <Input className='board-search' value={query} placeholder='搜索山头名称' onInput={e=>setQuery(e.detail.value)}/>
    <View className='board-controls'><Text className='board-section-title'>全部留言</Text><View className='board-sort' onClick={()=>setSort(sort==='time'?'mountain':'time')}>排列：{sort==='time'?'按时间':'按山头'}　⌄</View></View>
    <View className='board-count'>{visible.length} 条留言</View>
    {error && <View className='card' onClick={() => void load()}><Text>实时留言尚未连接，点击重试。</Text></View>}
    {loading && !items.length && <View className='card'><Text className='subtle'>正在读取留言…</Text></View>}
    {!loading && !error && !items.length && <View className='card'><Text className='subtle'>山里刚刚安静下来，等你留下第一句话。</Text></View>}
    {visible.map((item, index) => <View className='card board-card' key={`${item.kind}-${item.target}-${index}`} onClick={() => {
      if (item.kind !== 'segment' && item.target) Taro.navigateTo({url:`/pages/point/index?code=${encodeURIComponent(item.target)}&source=manual`})
    }}><View className='board-card-top'><Text className='pill'>{item.kind === 'summit' ? '山顶' : item.kind === 'junction' ? '岔路' : '路段'}</Text><Text className='subtle'>{item.at}</Text></View><Text className='board-card-name'>{item.name}</Text><Text className='board-card-text'>{item.text}</Text></View>)}
  </View>
}
