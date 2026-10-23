import Taro, { useLaunch } from '@tarojs/taro'
import './app.scss'
import { trackEvent } from './services/api'

function App({ children }) {
  useLaunch(() => { trackEvent('app_open') })
  return children
}
export default App
