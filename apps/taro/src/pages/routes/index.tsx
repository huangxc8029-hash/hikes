import { useState } from 'react'
import { View, Text, Image, Input } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { request } from '../../services/api'
import catalog from '../../data/catalog.json'
import TabHeader from '../../components/TabHeader'
import RecommendedBoard from '../../components/RecommendedBoard'
import hero from '../../assets/routes-scene.jpg'
import './index.scss'

type Route = { id?:number; slug:string; name:string; city?:string|null; km?:number|null; up?:number|null; hours?:number|null; hardest_level?:string|null; peak_count?:number|null; visit_count?:number|null; kind?:string; heatTier?:string|null }
const localRoutes: Route[] = catalog.routes
export default function Routes() {
  const [items,setItems]=useState<Route[]>(localRoutes); const [loading,setLoading]=useState(true); const [query,setQuery]=useState(''); const [offline,setOffline]=useState(true); const [page,setPage]=useState(1)
  const filtered=items.filter(item=>`${item.name} ${item.city||''}`.toLowerCase().includes(query.trim().toLowerCase()))
  useDidShow(()=>{request<{items:Route[]}>('/api/routes?limit=300').then(x=>{setItems(x.items||[]);setOffline(false)}).catch(()=>{setItems(localRoutes);setOffline(true)}).finally(()=>setLoading(false))})
  const openRoute=(route:Route)=>{Taro.navigateTo({url:`/pages/routes/detail/index?slug=${encodeURIComponent(route.slug)}${offline?'&local=1':''}`})}
  return <View className='routes-page'>
    <View className='routes-hero'><Image src={hero} mode='aspectFill'/><TabHeader/><Text className='routes-hero-title'>今天去走哪条？</Text></View>
    <RecommendedBoard routes={items} onOpen={openRoute}/>
    <View className='routes-list-area'>{offline&&<View className='catalog-note'>当前展示仓库收录的 {localRoutes.length} 条线路资料；可打开路线简介，地图、到访和留言需连接服务。</View>}
      <Text className='routes-section'>全部路书{offline?'':' · 按热度排序'}</Text><Input className='routes-search' value={query} placeholder='搜索路线或城市' onInput={e=>{setQuery(e.detail.value);setPage(1)}}/>
      {loading&&<View className='card'><Text className='subtle'>正在连接实时线路资料…</Text></View>}
      {!loading&&!filtered.length&&<View className='card'><Text className='subtle'>没有找到匹配的路线。</Text></View>}
      {filtered.slice((page-1)*6,page*6).map(route=><View className='card route-list-card' key={route.slug} onClick={()=>openRoute(route)}><View className='row'><Text className='route-heading'>{route.name}</Text><View className='route-badges'>{route.heatTier&&<Text className='pill heat'>{route.heatTier}</Text>}<Text className='pill'>{route.peak_count??0} 座山峰</Text></View></View><Text className='subtle'>{route.city||'山野路线'} · {route.km??'—'} km · 爬升 {route.up??'—'} m</Text><View className='stats-row'><Text>参考用时　{route.hours??'—'} 小时</Text><Text>{offline?'仓库路线资料':`到访 ${route.visit_count??0}`}</Text></View></View>)}
      {filtered.length>6&&<View className='list-pagination'><Text onClick={()=>setPage(Math.max(1,page-1))}>上一页</Text><Text>{page} / {Math.ceil(filtered.length/6)}</Text><Text onClick={()=>setPage(Math.min(Math.ceil(filtered.length/6),page+1))}>下一页</Text></View>}
    </View>
  </View>
}
