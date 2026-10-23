import { useEffect, useState } from 'react'
import { View, Text, Textarea } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { getErrorMessage, request, trackEvent } from '../../../services/api'
import { createSegmentComment } from '../../../services/segment-comments'
import CommentActions, { CommentItem } from '../../../components/CommentActions'
import './index.scss'

type Segment = { id:number; no:number; km:number; up_m:number; down_m:number; pct:number; kind:string; level?:string|null; confirmed:boolean; difficulty_applicable:boolean }
type Route = { name:string; segments:Segment[] }
type Comment = CommentItem

export default function SegmentPage(){
  const params=Taro.getCurrentInstance().router?.params||{}
  const slug=params.slug||'';const id=Number(params.id)||0
  const [routeName,setRouteName]=useState('');const [segment,setSegment]=useState<Segment|null>(null)
  const [comments,setComments]=useState<Comment[]>([]);const [error,setError]=useState('');const [loading,setLoading]=useState(true)
  const [draft,setDraft]=useState('');const [busy,setBusy]=useState(false)
  useEffect(()=>{let active=true;(async()=>{try{
    const route=await request<Route>(`/api/routes/${encodeURIComponent(slug)}`)
    if(!active)return
    const found=route.segments.find(item=>item.id===id)
    if(!found){setError('这条线路里没有找到该路段。');return}
    setRouteName(route.name);setSegment(found)
    const board=await request<{items:Comment[]}>(`/api/segments/${id}/comments?limit=20`)
    if(active)setComments(board.items||[])
  }catch(e){if(active)setError(getErrorMessage(e))}finally{if(active)setLoading(false)}})();return()=>{active=false}},[slug,id])
  const publish=async()=>{const text=draft.trim();if(!text)return Taro.showToast({title:'先写下留言内容',icon:'none'});if(!Taro.getStorageSync('hikes.auth.token')){const result=await Taro.showModal({title:'登录后发布留言',content:'游客可以浏览路段，公开发布需要登录。',confirmText:'去登录'});if(result.confirm)Taro.switchTab({url:'/pages/me/index'});return}const result=await Taro.showModal({title:'确认公开发布？',content:`这条留言会显示在路段留言板：\n\n${text}`,confirmText:'确认发布'});if(!result.confirm)return;setBusy(true);try{const created=await createSegmentComment<Comment>(id,text,(path,options)=>request<Comment>(path,options));setComments(items=>[created,...items]);setDraft('');trackEvent('comment_published',{board:'segment'});Taro.showToast({title:'留言已发布',icon:'success'})}catch(e){Taro.showToast({title:getErrorMessage(e),icon:'none'})}finally{setBusy(false)}}
  return <View className='page segment-page'><Text className='eyebrow'>TRAIL SEGMENT</Text><Text className='hero-title'>{segment?`第 ${segment.no} 段 · ${segment.kind==='climb'?'上坡':segment.kind==='desc'?'下坡':'缓行'}`:'路段详情'}</Text>
    {loading&&<View className='card'>正在读取路段资料…</View>}{error&&<View className='card segment-error'>{error}</View>}
    {segment&&<><View className='card'><Text className='section-label'>{routeName}</Text><Text>长度 {segment.km} km · 爬升 {segment.up_m} m · 下降 {segment.down_m} m</Text><Text>坡度 {segment.pct}% · {segment.difficulty_applicable?`难度 ${segment.level||'待定'}`:'不适用难度评级'}</Text><Text className='subtle'>{segment.confirmed?'资料已核实':'自动分析，待实地核实'}</Text></View>
      <Text className='section-title'>路段留言</Text>{comments.length?comments.map(item=><View className='card segment-comment' key={item.id}><Text>{item.nickname||'山友'} · {new Date(item.created_at).toLocaleDateString()}</Text><Text>{item.text}</Text><CommentActions comment={item} onUpdate={updated=>setComments(items=>items.map(c=>c.id===updated.id?updated:c))}/></View>):!error&&<View className='card'><Text className='subtle'>还没有路段留言。</Text></View>}
      <View className='card segment-write'><Text className='section-label'>补充这一段的路况</Text><Textarea maxlength={200} value={draft} placeholder={Taro.getStorageSync('hikes.auth.token')?'写下你最近看到的情况…':'登录后可发布留言，游客可以继续浏览'} onInput={event=>setDraft(event.detail.value)}/><View className='primary action' onClick={publish}>{busy?'正在发布…':'确认并公开发布'}</View></View>
      <View className='secondary action' onClick={()=>Taro.navigateTo({url:`/pages/routes/detail/index?slug=${encodeURIComponent(slug)}`})}>返回整条路线</View></>}
  </View>
}
