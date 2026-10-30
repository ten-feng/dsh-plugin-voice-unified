/**
 * 把视频/音频里的"正常说话"人声切片后追加到音色档案，再训练一次。
 * 用法：node tests/speech-bias.mjs <媒体文件> <profileId> <标签> [段数]
 */
import path from 'node:path'
import { mkdir, rm, readFile, readdir } from 'node:fs/promises'
import { AudioEngine } from '../lib/audio-engine.mjs'

const HOME = path.join(process.env.USERPROFILE, '.dsh', 'dsh-voice-unified')
const API = 'http://127.0.0.1:60648/plugins/dsh-voice-unified/api'

const SOURCE = process.argv[2]
const PROFILE_ID = process.argv[3]
const LABEL = process.argv[4] || 'speech'
const WANT = Number(process.argv[5] || 20)

async function api(method, p, payload) {
  const res = await fetch(API + p, {
    method,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 140)}`)
  return text ? JSON.parse(text) : {}
}

const engine = new AudioEngine()
const work = path.join(HOME, 'temp', `speech-${LABEL}`)
await rm(work, { recursive: true, force: true })
await mkdir(work, { recursive: true })

const wav = path.join(work, 'source.wav')
const vocal = path.join(work, 'vocal.wav')
const inst = path.join(work, 'inst.wav')
const slicesDir = path.join(work, 'slices')

console.log('decode:', path.basename(SOURCE))
await engine.decodeToWav(SOURCE, wav, { sampleRate: 44100, channels: 2 })
const total = await engine.duration(wav)
console.log('duration:', total.toFixed(1), 's')

// 长视频整段做人声分离会爆内存（STFT 复数矩阵太大），按窗口分段处理
const windows = []
for (const [startRatio, lenRatio] of [[0.05, 0.12], [0.3, 0.12], [0.55, 0.12], [0.78, 0.12]]) {
  const start = Math.max(0, total * startRatio)
  const end = Math.min(total, start + total * lenRatio)
  if (end - start >= 30) windows.push([start, end])
}
console.log('windows:', windows.map(([a, b]) => `${a.toFixed(0)}-${b.toFixed(0)}s`).join(', '))

const usable = []
let index = 0
for (const [start, end] of windows) {
  index += 1
  const segWav = path.join(work, `seg${index}.wav`)
  const segVocal = path.join(work, `seg${index}-vocal.wav`)
  const segInst = path.join(work, `seg${index}-inst.wav`)
  const segSlices = path.join(work, `slices${index}`)
  await engine.trimSegment(wav, segWav, start, end)
  await engine.separate(segWav, segVocal, segInst, { vocalSuppress: 0.3 })
  const sliced = await engine.slice(segVocal, segSlices, {})
  console.log(`  window ${index}: ${sliced.count} slices`)
  for (const name of (await readdir(segSlices)).sort()) {
    if (!name.toLowerCase().endsWith('.wav')) continue
    const file = path.join(segSlices, name)
    const dur = await engine.duration(file)
    if (dur >= 3.5 && dur <= 12) usable.push({ file, duration: dur })
  }
}
console.log('usable chunks:', usable.length)

// 在整段里均匀取样，避免只拿到某个时间点的语气
const picked = []
if (usable.length) {
  const step = Math.max(1, Math.floor(usable.length / WANT))
  for (let i = 0; i < usable.length && picked.length < WANT; i += step) picked.push(usable[i])
  for (let i = 0; i < usable.length && picked.length < Math.min(WANT, usable.length); i += 1) {
    if (!picked.includes(usable[i])) picked.push(usable[i])
  }
}

const before = (await api('GET', `/profiles/${PROFILE_ID}`)).profile
console.log(`${before.name}: samples ${before.sampleCount} | versions ${before.versions.length}`)

let uploaded = 0
for (const chunk of picked) {
  const buf = await readFile(chunk.file)
  try {
    await api('POST', `/profiles/${PROFILE_ID}/samples`, {
      dataBase64: buf.toString('base64'),
      filename: path.basename(chunk.file),
      slice: false,
    })
    uploaded += 1
  } catch (error) {
    console.log('  upload failed', path.basename(chunk.file), error.message)
  }
}
console.log('uploaded:', uploaded)

await api('POST', `/profiles/${PROFILE_ID}/train`, { note: `说话人声风格：${LABEL}` })
for (let i = 0; i < 300; i += 1) {
  await new Promise((r) => setTimeout(r, 1000))
  const p = (await api('GET', `/profiles/${PROFILE_ID}`)).profile
  const status = (p.training || {}).status
  if (status !== 'training') {
    const v = p.versions.at(-1)
    console.log(`trained: ${v.id} | similarity ${(v.metrics || {}).similarity} | samples ${v.sampleCount}`)
    console.log('model:', JSON.stringify(v.model))
    console.log('preview:', v.previewAudioUrl)
    break
  }
}
