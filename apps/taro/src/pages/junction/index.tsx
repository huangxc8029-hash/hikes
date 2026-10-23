import { useEffect, useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { getErrorMessage, request } from '../../services/api'
import CommentActions, { CommentItem } from '../../components/CommentActions'
import './index.scss'

type Junction = { id:number; code:string; type:string; name:string|null; route_name:string|null; altitude:number|null; visitCount:number; guide?:Record<string,unknown> }
type Comment = CommentItem

export default function JunctionPage(){
  const code=Taro.getCurrentInstance().router?.params?.code||''
  const [point,setPoint]=useState<Junction|null>(null)
  const [comments,setComments]=useState<Comment[]>([])
  const [error,setError]=useState('')
  const [loading,setLoading]=useState(true)
  useEffect(()=>{let active=true;(async()=>{try{
    const item=await request<Junction>(`/api/points/${encodeURIComponent(code)}`)
    if(!active)return
    if(item.type!=='junction'){setError('这个编号不是岔路点位。');return}
    setPoint(item)
    const board=await request<{items:Comment[]}>(`/api/points/${item.id}/comments?limit=20`)
    if(active)setComments(board.items||[])
  }catch(e){if(active)setError(getErrorMessage(e))}finally{if(active)setLoading(false)}})();return()=>{active=false}},[code])
  return <View className='page junction-page'><Text className='eyebrow'>TRAIL JUNCTION</Text><Text className='hero-title'>{point?.name||'岔路点位'}</Text>
    {loading&&<View className='card'>正在读取岔路资料…</View>}
    {error&&<View className='card junction-error'>{error}</View>}
    {point&&<><View className='card'><Text className='section-label'>点位资料</Text><Text className='subtle'>编号 {point.code}{point.route_name?` · 所属线路 ${point.route_name}`:''}</Text><Text className='subtle'>海拔 {point.altitude??'—'} m · 已记录 {point.visitCount} 次到访</Text>{point.guide&&Object.entries(point.guide).map(([key,value])=><Text className='subtle' key={key}>{key}：{String(value??'')}</Text>)}</View>
      <View className='primary action' onClick={()=>Taro.navigateTo({url:`/pages/point/index?code=${encodeURIComponent(code)}&source=manual`})}>到访打卡与留言</View>
      <Text className='section-title'>岔路留言</Text>{comments.length?comments.map(item=><View className='card junction-comment' key={item.id}><Text>{item.nickname||'山友'} · {new Date(item.created_at).toLocaleDateString()}</Text><Text>{item.text}</Text><CommentActions comment={item} onUpdate={updated=>setComments(items=>items.map(c=>c.id===updated.id?updated:c))}/></View>):!error&&<View className='card'><Text className='subtle'>还没有岔路留言。</Text></View>}</>}
  </View>
}
