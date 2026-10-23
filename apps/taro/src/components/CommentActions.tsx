import { useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { ensureGuestToken, getErrorMessage, request } from '../services/api'

export type CommentItem = { id:number; text:string; nickname?:string|null; like_count:number; bad_count:number; created_at:string; is_maintainer?:boolean; status?:string; pinned?:boolean }
const reasons = ['垃圾广告','辱骂骚扰','虚假信息','隐私泄露','违法内容','其他']
const reasonCodes = ['spam','abuse','false_info','privacy','illegal','other']

export default function CommentActions({ comment, onUpdate }: { comment:CommentItem; onUpdate:(c:CommentItem)=>void }) {
 const [busy,setBusy]=useState(false)
 const vote=async(value:'like'|'bad')=>{
  if(busy)return
  if(!Taro.getStorageSync('hikes.auth.token')){const r=await Taro.showModal({title:'登录后参与评价',content:'游客可以继续浏览留言，赞踩需要登录。',confirmText:'去登录'});if(r.confirm)Taro.switchTab({url:'/pages/me/index'});return}
  setBusy(true);try{const updated=await request<CommentItem>(`/api/comments/${comment.id}/vote`,{method:'POST',data:{value}});onUpdate(updated)}catch(e){Taro.showToast({title:getErrorMessage(e),icon:'none'})}finally{setBusy(false)}
 }
 const report=async()=>{
  if(busy)return
  let choice:{tapIndex:number};try{choice=await Taro.showActionSheet({itemList:reasons})}catch{return}
  const ok=await Taro.showModal({title:'确认举报',content:`举报原因：${reasons[choice.tapIndex]}。平台会核查这条留言。`,confirmText:'提交举报'});if(!ok.confirm)return
  setBusy(true);try{if(!Taro.getStorageSync('hikes.auth.token'))await ensureGuestToken();const result=await request<{duplicate?:boolean}>('/api/reports',{method:'POST',data:{targetType:'comment',targetId:comment.id,reason:reasonCodes[choice.tapIndex]}});Taro.showToast({title:result.duplicate?'已收到过该举报':'举报已提交',icon:'success'})}catch(e){Taro.showToast({title:getErrorMessage(e),icon:'none'})}finally{setBusy(false)}
 }
 return <View className='comment-actions'><Text onClick={()=>vote('like')}>赞 {comment.like_count}</Text><Text onClick={()=>vote('bad')}>踩 {comment.bad_count}</Text><Text onClick={report}>举报</Text></View>
}
