import { useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { getErrorMessage, request } from '../../services/api'
import './index.scss'

type CommentNotice = { commentId:number; code?:string|null; peakName?:string|null; who?:string|null; text:string; at:string; unread:boolean; reason:'maintainer'|'follow' }
type KingNotice = { id:number; kind:string; title:string; body:string; readAt?:string|null; createdAt:string }

export default function Messages() {
  const [comments,setComments]=useState<CommentNotice[]>([])
  const [kingNotices,setKingNotices]=useState<KingNotice[]>([])
  const [loading,setLoading]=useState(false)
  const [error,setError]=useState('')
  const [signedIn,setSignedIn]=useState(false)
  const load=async()=>{
    const token=!!Taro.getStorageSync('hikes.auth.token')
    setSignedIn(token)
    if(!token){setComments([]);setKingNotices([]);setError('');setLoading(false);return}
    setLoading(true);setError('')
    const results=await Promise.allSettled([
      request<CommentNotice[]>('/api/me/notifications?limit=30'),
      request<KingNotice[]>('/api/me/king-notifications?limit=30')
    ])
    if(results[0].status==='fulfilled')setComments(results[0].value)
    if(results[1].status==='fulfilled')setKingNotices(results[1].value)
    const failed=results.find((result):result is PromiseRejectedResult=>result.status==='rejected')
    if(failed)setError(getErrorMessage(failed.reason))
    setLoading(false)
  }
  useDidShow(()=>{void load()})
  const markRead=async()=>{
    try{
      await Promise.all([
        request('/api/me/notifications/seen',{method:'POST'}),
        request('/api/me/king-notifications/read',{method:'POST'})
      ])
      setComments(old=>old.map(item=>({...item,unread:false})))
      setKingNotices(old=>old.map(item=>({...item,readAt:item.readAt||new Date().toISOString()})))
    }catch(e){Taro.showToast({title:getErrorMessage(e),icon:'none'})}
  }
  const unread=comments.some(item=>item.unread)||kingNotices.some(item=>!item.readAt)
  return <View className='messages-page'>
    <Text className='messages-kicker'>MESSAGES</Text>
    <View className='messages-heading'><Text className='messages-title'>消息</Text>{signedIn&&unread&&<Text className='messages-read' onClick={()=>void markRead()}>全部标为已读</Text>}</View>
    {!signedIn?<View className='messages-empty'><Text className='messages-empty-icon'>✉</Text><Text>登录后查看消息</Text><Text className='messages-hint'>你关注的山头留言和维护通知会显示在这里。</Text><View className='messages-action' onClick={()=>Taro.switchTab({url:'/pages/me/index'})}>去登录</View></View>:<>
      {loading&&<View className='messages-state'>正在读取消息…</View>}
      {error&&<View className='messages-state messages-error' onClick={()=>void load()}>消息加载失败：{error}。点击重试。</View>}
      {!loading&&!error&&!comments.length&&!kingNotices.length&&<View className='messages-empty'><Text className='messages-empty-icon'>✉</Text><Text>还没有新消息</Text><Text className='messages-hint'>山头动态和留言提醒会出现在这里。</Text></View>}
      {!!kingNotices.length&&<><Text className='messages-section'>维护通知</Text>{kingNotices.map(item=><View className='messages-card' key={`king-${item.id}`}><View className='messages-card-head'><Text>{item.title}</Text>{!item.readAt&&<Text className='messages-dot'>未读</Text>}</View><Text className='messages-body'>{item.body}</Text><Text className='messages-date'>{new Date(item.createdAt).toLocaleString()}</Text></View>)}</>}
      {!!comments.length&&<><Text className='messages-section'>留言提醒</Text>{comments.map(item=><View className='messages-card' key={`comment-${item.commentId}`} onClick={()=>item.code&&Taro.navigateTo({url:`/pages/point/index?code=${encodeURIComponent(item.code)}&source=manual`})}><View className='messages-card-head'><Text>{item.peakName||'山头留言'} · {item.who||'山友'}</Text>{item.unread&&<Text className='messages-dot'>未读</Text>}</View><Text className='messages-body'>{item.text}</Text><Text className='messages-date'>{item.reason==='maintainer'?'我维护的山头':'我关注的山头'} · {new Date(item.at).toLocaleString()}</Text></View>)}</>}
    </>}
  </View>
}
