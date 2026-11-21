import { useEffect, useRef } from 'react'
import type { Playback } from './use-playback'

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)
}

// 回放快捷键: 空格播放/暂停, 左右方向键逐帧 (输入框里打字时不触发); 一页只挂一处
export function usePlaybackShortcuts(playback: Playback, stepTimes: number[]) {
  // 键盘处理读最新的playback, 监听只挂一次
  const handleKey = useRef<(event: KeyboardEvent) => void>(() => {})
  useEffect(() => {
    handleKey.current = (event) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === ' ') playback.togglePlaying()
      else if (event.key === 'ArrowLeft') playback.step(-1, stepTimes)
      else if (event.key === 'ArrowRight') playback.step(1, stepTimes)
      else return
      event.preventDefault()
    }
  })
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => handleKey.current(event)
    // 空格在聚焦的按钮上抬起时会点击它, 一并拦下, 免得播放切换两次
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === ' ' && !isTyping(event.target)) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])
}
