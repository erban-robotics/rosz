import { ChevronLeft, ChevronRight, Pause, Play, X } from 'lucide-react'
import { useRef } from 'react'
import { Button } from '../ui/button'
import { formatSeconds } from '../timeline/timeline'
import { type Playback, useClockListener } from './use-playback'

const SPEED_OPTIONS = [0.5, 1, 2]

// 播放控件: 逐帧, 播放/暂停, 时间码, 倍速, 循环区间; 时间码随播放直接改文字, 不重渲
export function PlaybackControls({ playback, duration, stepTimes }: { playback: Playback; duration: number; stepTimes: number[] }) {
  const timeTextRef = useRef<HTMLSpanElement>(null)
  useClockListener(playback.clock, (time) => {
    if (timeTextRef.current) timeTextRef.current.textContent = `${formatSeconds(time)} / ${formatSeconds(duration)}`
  })
  return (
    <>
      <Button variant="outline" size="icon" aria-label="上一帧" onClick={() => playback.step(-1, stepTimes)}>
        <ChevronLeft />
      </Button>
      <Button size="icon" aria-label={playback.isPlaying ? '暂停' : '播放'} onClick={playback.togglePlaying}>
        {playback.isPlaying ? <Pause /> : <Play />}
      </Button>
      <Button variant="outline" size="icon" aria-label="下一帧" onClick={() => playback.step(1, stepTimes)}>
        <ChevronRight />
      </Button>
      <span ref={timeTextRef} className="font-mono text-sm" />
      <div className="flex gap-1" role="group" aria-label="倍速">
        {SPEED_OPTIONS.map((speed) => (
          <Button
            key={speed}
            size="sm"
            variant={playback.speed === speed ? 'secondary' : 'ghost'}
            onClick={() => playback.setSpeed(speed)}
          >
            {speed}x
          </Button>
        ))}
      </div>
      {playback.loop && (
        <span className="flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs">
          {`循环${formatSeconds(playback.loop.start)}-${formatSeconds(playback.loop.end)}`}
          <button type="button" aria-label="取消循环" onClick={playback.clearLoop}>
            <X className="size-3" />
          </button>
        </span>
      )}
    </>
  )
}
