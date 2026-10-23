import { useState } from 'react'
import { View, Text, Image, Input } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { request } from '../../services/api'
import { pointBriefHeat, pointBriefSubtitle, type PointBrief } from '../../services/point-brief'
import catalog from '../../data/catalog.json'
import TabHeader from '../../components/TabHeader'
import guide from '../../assets/places-guide.png'
import landscape from '../../assets/home-landscape.jpg'
import './index.scss'

type Summit = { id?: string; pointId?: number; code?: string; name?: string; city?: string; altitude?: number; routeName?: string; routeSlug?: string; visits30?: number; origin?: string; heatTier?: string | null; annualVisits?: string | null }
type Ranked = { mountainId?: number; name: string; visits?: number }
const localPeaks: Summit[] = catalog.peaks.map((peak, index) => ({id:`local-${index}`,name:peak.name,city:peak.region,altitude:peak.elevation,origin:'catalog'}))

export default function Places() {
  const [segment,setSegment]=useState<'peak'|'junction'>('peak')
  const [summits,setSummits]=useState<Summit[]>(localPeaks)
  const [junctions,setJunctions]=useState<PointBrief[]>([])
  const [ranking,setRanking]=useState<Ranked[]>([])
  const [query,setQuery]=useState('')
  const [page,setPage]=useState(1)
  const [offline,setOffline]=useState(true)
  const [loading,setLoading]=useState(true)
  const load=async()=>{
    setLoading(true)
    const results=await Promise.allSettled([
      request<Summit[]>('/api/summits?limit=300'),
      request<PointBrief[]>('/api/points?limit=2000'),
      request<{items:Ranked[]}>('/api/boards/mountains?window=week&metric=visits&limit=6')
    ])
    if(results[0].status==='fulfilled'&&results[0].value.filter(item=>item.name).length>0){setSummits(results[0].value);setOffline(false)}else{setSummits(localPeaks);setOffline(true)}
    if(results[1].status==='fulfilled')setJunctions(results[1].value.filter(item=>item.type==='junction'))
    if(results[2].status==='fulfilled')setRanking(results[2].value.items||[])
    setLoading(false)
  }
  useDidShow(()=>{void load()})
  const rows=segment==='peak'?summits.filter(item=>`${item.name||''} ${item.city||''} ${item.routeName||''}`.includes(query.trim())):junctions.filter(item=>`${item.name||''} ${item.route_name||''}`.includes(query.trim()))
  return <View className='places-page'><View className='places-body'>
    <View className='places-banner'><Image className='places-banner-landscape' src={landscape} mode='aspectFill'/><TabHeader/><Image className='places-banner-guide' src={guide} mode='aspectFit'/><View className='places-banner-copy'><Text className='places-banner-title'>占山为王</Text><Text>做一个游戏人间的山大王～</Text><Text>为你热爱的山峰做一个更大的留言板</Text></View></View>
    <View className='places-tabs'><View className={segment==='peak'?'on':''} onClick={()=>{setSegment('peak');setPage(1)}}>山头</View><View className={segment==='junction'?'on':''} onClick={()=>{setSegment('junction');setPage(1)}}>岔路</View></View>
    <Input className='places-search' value={query} placeholder={segment==='peak'?'搜索山头名称或所属线路':'搜索岔路名称'} onInput={e=>{setQuery(e.detail.value);setPage(1)}}/>
    {offline&&<View className='catalog-note'>当前展示仓库收录的 {catalog.peaks.length} 座有名称的山峰资料。线上点位尚缺山峰名称；扫码仍可查看点位，打卡与留言以服务端记录为准。</View>}
    {segment==='peak'&&<><View className='places-head'><Text>登顶榜</Text><Text className='subtle'>本周 · 人次</Text></View>{ranking.length?ranking.map((item,index)=><View className='places-rank' key={`${item.name}-${index}`}><Text className='places-rank-no'>{index+1}</Text><Text>{item.name}</Text><Text className='subtle'>{item.visits||0} 次</Text></View>):<View className='places-empty'><Text className='subtle'>连接服务后显示实时登顶榜。</Text></View>}</>}
    <View className='places-head'><Text>{segment==='peak'?'山头 · 按搜索热度':'岔路'}</Text><Text className='subtle'>{rows.length} 个结果</Text></View>
    {rows.slice((page-1)*6,page*6).map((item,index)=><View className='places-card' key={item.id||item.code||index} onClick={()=>{
      if(item.code)Taro.navigateTo({url:`/${segment==='junction'?'pages/junction/index':'pages/point/index'}?code=${encodeURIComponent(item.code)}&source=manual`})
      else if(item.origin!=='catalog'&&item.pointId)Taro.navigateTo({url:`/pages/point/index?code=${encodeURIComponent(String(item.pointId))}&source=manual`})
      else Taro.navigateTo({url:`/pages/mountain/index?name=${encodeURIComponent(item.name||'山头资料')}&local=1`})
    }}><View className='places-card-top'><View className='places-card-art'><Text>▲</Text></View><View className='places-card-info'><View className='places-card-title'><Text className='places-card-name'>{item.name||'名称待定'}</Text>{item.heatTier&&<Text className='places-heat-tier'>{item.heatTier}</Text>}</View><Text className='subtle'>{'route_name' in item?pointBriefSubtitle(item):`${item.altitude!=null?`海拔 ${item.altitude} m`:'海拔待补充'}${item.city?` · ${item.city}`:''}`}</Text><Text className='places-card-heat'>{'route_name' in item?pointBriefHeat(item):item.origin==='catalog'?'本地山峰资料':item.annualVisits||`本周到访 ${item.visits30??0}`}</Text></View><Text className='places-card-action'>{item.code?'我到过':'›'}</Text></View><View className='places-card-foot'>{'route_name' in item&&item.route_name?`所属线路：${item.route_name}`:'routeName' in item&&item.routeName?`所属线路：${item.routeName}`:'进入点位查看资料与留言。'}</View></View>)}
    {rows.length>6&&<View className='list-pagination'><Text onClick={()=>setPage(Math.max(1,page-1))}>上一页</Text><Text>{page} / {Math.ceil(rows.length/6)}</Text><Text onClick={()=>setPage(Math.min(Math.ceil(rows.length/6),page+1))}>下一页</Text></View>}
    {!loading&&!rows.length&&<View className='places-empty'><Text className='subtle'>{segment==='junction'&&offline?'连接服务后可查看岔路点位。':'没有匹配的山头。'}</Text></View>}
  </View></View>
}
