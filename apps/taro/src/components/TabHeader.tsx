import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import logo from '../assets/logo-mark.png'
import './TabHeader.scss'

export default function TabHeader() {
  return <View className='tab-header'>
    <View className='tab-header-home' onClick={() => Taro.switchTab({url:'/pages/home/index'})}><Image src={logo} mode='aspectFit'/><Text>回主页</Text></View>
    <View className='tab-header-message' onClick={() => Taro.navigateTo({url:'/pages/messages/index'})}><View className='tab-header-bubble'><View className='tab-header-line'/></View></View>
  </View>
}
