import { View, Text, Image } from '@tarojs/components'
import Taro from '@tarojs/taro'
import mountain from '../assets/nav-mountain.png'
import book from '../assets/nav-book.png'
import chat from '../assets/nav-chat.png'
import user from '../assets/nav-user.png'
import './index.scss'

const tabs = [
  { path: 'pages/places/index', label: '山头', icon: mountain },
  { path: 'pages/routes/index', label: '路书', icon: book },
  { path: 'pages/home/index', label: '首页', icon: '' },
  { path: 'pages/board/index', label: '留言版', icon: chat },
  { path: 'pages/me/index', label: '我', icon: user }
]

export default function CustomTabBar() {
  const current = Taro.getCurrentPages().slice(-1)[0]?.route || 'pages/home/index'
  return <View className='hikes-tabbar'>
    {tabs.map((tab, index) => <View key={tab.path} className={`hikes-tab ${current === tab.path ? 'active' : ''} ${index === 2 ? 'scan-tab' : ''}`} onClick={() => {
      if (current !== tab.path) Taro.switchTab({ url: `/${tab.path}` })
    }}>
      <View className='hikes-tab-icon'>{index===2?<Text>⌂</Text>:<Image src={tab.icon} mode='aspectFit'/>}</View>
      <Text className='hikes-tab-label'>{tab.label}</Text>
    </View>)}
  </View>
}
