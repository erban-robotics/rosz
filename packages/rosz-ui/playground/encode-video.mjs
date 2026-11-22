/**
 * 造一段视频录制给playground验收视频解码 (不进包, 产物不入库): ffmpeg testsrc2 编成H.264与AV1各一路, 切成逐帧样本,
 * 写成capture.py的录制格式, 另把每帧解成PNG作对照 (按BT.709转RGB, 同Chromium).
 *
 * 用法: node playground/encode-video.mjs [输出目录, 默认playground/captures/video] [秒数, 默认6]
 * H.264: libx264 high, CRF 28, GOP 15 (15Hz即1秒), 无B帧, Annex B, 每个IDR带SPS/PPS (同ADP回放衍生物的编码参数)
 * AV1: libsvtav1, GOP 15, 低开销OBU (每个时间单元以Temporal Delimiter开头)
 * 输出: manifest.json (每路: 文件, 话题, 类型, format, 关键帧的样本序号), <序号>.bin, reference/<话题末段>/<帧号>.png (帧号从1起)
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const outputDir = process.argv[2] ?? join(import.meta.dirname, 'captures/video')
const seconds = process.argv[3] ?? '6'
const RATE = 15
const FRAME_NANOSECONDS = 1_000_000_000n / BigInt(RATE)
// 录制起点 (绝对纳秒), 采样时刻比接收早这么多
const ORIGIN_NANOSECONDS = 1_800_000_000_000_000_000n
const SAMPLE_LEAD_NANOSECONDS = 20_000_000n
const SOURCE = ['-f', 'lavfi', '-i', `testsrc2=size=640x480:rate=${RATE}`, '-t', seconds]
const REFERENCE_FILTER = 'scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int'
const STREAMS = [
  {
    topic: '/video/h264',
    format: 'h264',
    extension: 'h264',
    encode: ['-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '28', '-g', '15',
      '-keyint_min', '15', '-sc_threshold', '0', '-bf', '0', '-x264-params', 'repeat-headers=1', '-f', 'h264'],
  },
  {
    topic: '/video/av1',
    format: 'av1',
    extension: 'obu',
    encode: ['-c:v', 'libsvtav1', '-g', '15', '-pix_fmt', 'yuv420p', '-f', 'obu'],
  },
]

function run(command, args) {
  return execFileSync(command, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
}

mkdirSync(outputDir, { recursive: true })
const manifest = STREAMS.map((stream, index) => {
  const raw = join(outputDir, `${index}.${stream.extension}`)
  run('ffmpeg', ['-y', ...SOURCE, ...stream.encode, raw])
  const bytes = readFileSync(raw)
  // 逐帧的字节区间与关键帧标记: 裸流解复用出的每个包即一帧 (H.264一个访问单元, AV1一个时间单元)
  const { packets } = JSON.parse(
    run('ffprobe', ['-show_packets', '-show_entries', 'packet=pos,size,flags', '-of', 'json', raw]).toString(),
  )
  const records = packets.map((packet, frame) => {
    const data = bytes.subarray(Number(packet.pos), Number(packet.pos) + Number(packet.size))
    const receive = ORIGIN_NANOSECONDS + BigInt(frame) * FRAME_NANOSECONDS
    const header = Buffer.alloc(20)
    header.writeBigUInt64LE(receive, 0)
    header.writeBigInt64LE(receive - SAMPLE_LEAD_NANOSECONDS, 8)
    header.writeUInt32LE(data.length, 16)
    return Buffer.concat([header, data])
  })
  writeFileSync(join(outputDir, `${index}.bin`), Buffer.concat(records))
  const referenceDir = join(outputDir, 'reference', stream.format)
  mkdirSync(referenceDir, { recursive: true })
  // 按BT.709转RGB: 码流未标色彩空间时Chromium按BT.709画, ffmpeg默认BT.601, 两者差约10级
  run('ffmpeg', ['-y', '-i', raw, '-fps_mode', 'passthrough', '-vf', REFERENCE_FILTER, join(referenceDir, '%04d.png')])
  const keyframes = packets.flatMap((packet, frame) => (packet.flags.startsWith('K') ? [frame] : []))
  return { file: `${index}.bin`, topic: stream.topic, type: 'foxglove_msgs/msg/CompressedVideo', format: stream.format, keyframes }
})
writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(manifest.map(({ topic, keyframes }) => `${topic}: 关键帧 ${keyframes.join(' ')}`).join('\n'))
