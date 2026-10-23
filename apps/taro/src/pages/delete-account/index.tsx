import { useState } from 'react'
import { View, Text, Input } from '@tarojs/components'
import Taro from '@tarojs/taro'
import PrivacyPrompt from '../../components/privacy-prompt'
import { getErrorMessage, request, requestPrivacyAuthorization } from '../../services/api'

export default function DeleteAccount(){
 const [confirm,setConfirm]=useState('');const [busy,setBusy]=useState(false)
 const submit=async()=>{
  if(busy)return
  if(!Taro.getStorageSync('hikes.auth.token'))return Taro.showToast({title:'请先登录要注销的账号',icon:'none'})
  if(confirm!=='注销')return Taro.showToast({title:'请原样输入“注销”',icon:'none'})
  const ok=await Taro.showModal({title:'最后确认注销账号',content:'此操作会删除账号的到访、轨迹、收藏和私人草稿，无法撤销。公开留言会保留并匿名化。',confirmText:'继续验证',confirmColor:'#a23d32'});if(!ok.confirm)return
  setBusy(true);try{await requestPrivacyAuthorization();const wx=await Taro.login();if(!wx.code)throw new Error('微信身份验证未完成，请重试');await request('/api/me/delete-account',{method:'POST',data:{code:wx.code,confirm:'注销'}});const keys=Taro.getStorageInfoSync().keys||[];keys.filter(k=>k.startsWith('hikes.pending.visit.')).forEach(k=>Taro.removeStorageSync(k));Taro.removeStorageSync('hikes.auth.token');Taro.removeStorageSync('hikes.auth.userId');Taro.removeStorageSync('hikes.guest.token');Taro.showToast({title:'账号已注销',icon:'success'});setTimeout(()=>Taro.switchTab({url:'/pages/me/index'}),800)}catch(e){Taro.showToast({title:getErrorMessage(e),icon:'none'})}finally{setBusy(false)}
 }
 return <View className='page'><PrivacyPrompt/><Text className='eyebrow'>ACCOUNT CONTROL</Text><Text className='hero-title'>删除账号</Text><View className='card'><Text className='section-label'>注销后将删除</Text><Text className='subtle'>到访记录、位置轨迹、想去清单、私人纪念和未发布草稿。公开留言会保留并移除账号身份，举报与审计记录按规则保留。</Text><Text className='section-label'>验证当前微信身份</Text><Text className='subtle'>提交时会重新调用微信登录校验，只有当前微信身份与此账号一致才会注销。</Text><Input className='text-input' value={confirm} maxlength={2} placeholder='请原样输入：注销' onInput={e=>setConfirm(e.detail.value)}/><View className='primary action' onClick={submit}>{busy?'正在验证并注销…':'确认注销账号'}</View></View><Text className='subtle'>注销不可撤销；重新登录会创建一个新的账号。</Text></View>
}
