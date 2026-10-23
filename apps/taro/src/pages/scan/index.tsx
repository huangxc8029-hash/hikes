import { useState } from 'react'
import { View, Text, Input } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { parsePointCode } from './point-code'
import { trackEvent } from '../../services/api'
import './index.scss'

export default function Scan(){const [code,setCode]=useState('');const [error,setError]=useState('');const [scanning,setScanning]=useState(false);const open=(value:string,source:'scan'|'manual')=>{try{const pointCode=parsePointCode(value);setError('');trackEvent('point_entry',{source});Taro.navigateTo({url:`/pages/point/index?code=${encodeURIComponent(pointCode)}&source=${source}`}).catch(()=>setError('页面暂时无法打开，请稍后重试'))}catch(e){setError(e instanceof Error?e.message:'点位编号格式不正确')}}
 const scan=async()=>{if(scanning)return;setScanning(true);setError('');trackEvent('scan_started');try{const result=await Taro.scanCode({onlyFromCamera:false,scanType:['qrCode','barCode']});open(result.result,'scan')}catch(e){if(!String((e as any)?.errMsg||'').includes('cancel')){trackEvent('scan_failed');setError('扫码未完成，请检查二维码后重试')}}finally{setScanning(false)}}
 return <View className='page scan-page'><Text className='eyebrow'>YOU ARE HERE</Text><Text className='hero-title'>扫一块路牌，{ '\n' }认识眼前这座山。</Text><Text className='subtle'>你可以先看地点和山友留言，到访记录无需登录。</Text><View className={`scan-hero ${scanning?'is-scanning':''}`} onClick={scan}><View className='scan-frame'><Text>⌗</Text></View><Text className='scan-label'>{scanning?'正在打开扫一扫…':'点击打开微信扫一扫'}</Text><Text className='scan-help'>支持 hikes 点位短链与二维码</Text></View><View className='card'><Text className='input-label'>手动输入点位编号</Text><Input className='text-input' value={code} placeholder='例如 QS-P1092' onInput={e=>{setCode(e.detail.value);setError('')}} onConfirm={e=>open(e.detail.value,'manual')}/><View className='primary button-view' onClick={()=>open(code,'manual')}>打开这个点位</View>{error&&<Text className='scan-error'>{error}</Text>}</View><Text className='scan-footnote'>普通相机扫到的实体码仍可通过原有 H5 短链打开；使用本页扫码可直接进入小程序点位。</Text></View>
}
