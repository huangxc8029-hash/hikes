import { useEffect, useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'

type PrivacyResult = { event: 'agree' | 'disagree'; buttonId?: string }
let listenerInstalled = false
let activePrompt: ((resolve: (result: PrivacyResult) => void) => void) | null = null

export default function PrivacyPrompt() {
  const [resolvePrivacy, setResolvePrivacy] = useState<((result: PrivacyResult) => void) | null>(null)

  useEffect(() => {
    if (typeof Taro.onNeedPrivacyAuthorization !== 'function') return
    activePrompt = resolve => setResolvePrivacy(() => resolve)
    if (!listenerInstalled) {
      Taro.onNeedPrivacyAuthorization(resolve => activePrompt?.(resolve))
      listenerInstalled = true
    }
    return () => {
      activePrompt = null
    }
  }, [])

  if (!resolvePrivacy) return null
  return <View className='privacy-mask'>
    <View className='privacy-dialog'>
      <Text className='section-label'>请先阅读隐私保护指引</Text>
      <Text className='subtle'>我们会按隐私政策处理账号、扫码和到访记录。你可以先阅读完整说明，再决定是否继续。</Text>
      <Text className='privacy-link' onClick={() => Taro.openPrivacyContract({})}>查看微信隐私保护指引</Text>
      <Button className='privacy-agree' id='hikes-privacy-agree' openType='agreePrivacyAuthorization' onAgreePrivacyAuthorization={() => {
        resolvePrivacy({ event: 'agree', buttonId: 'hikes-privacy-agree' })
        setResolvePrivacy(null)
      }}>同意并继续</Button>
      <Text className='privacy-decline' onClick={() => {
        resolvePrivacy({ event: 'disagree' })
        setResolvePrivacy(null)
      }}>暂不同意</Text>
    </View>
  </View>
}
