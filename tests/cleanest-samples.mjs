/** 在某个版本新增的样本里挑最干净的 N 段，其余删掉后重训。 */
import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'

const API = 'http://127.0.0.1:60648/plugins/dsh-voice-unified/api'
const HOME = path.join(process.env.USERPROFILE, '.dsh', 'dsh-voice-unified')
const PROFILE_ID = process.argv[2]
const KEEP = Number(process.argv[3] || 10)

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

/** 读 16-bit PCM WAV，算语音电平与噪声电平的差（粗略 SNR）。 */
async function snrOf(file) {
  const buf = await readFile(file)
  if (buf.length < 44) return -99
  const dataOffset = 44
  const samples = []
  for (let i = dataOffset; i + 1 < buf.length; i += 2) {
    samples.push(buf.readInt16LE(i) / 32768)
  }
  const hop = 882 // 20ms @44.1k
  const frames = []
  for (let i = 0; i + hop < samples.length; i += hop) {
    let sum = 0
    for (let j = 0; j < hop; j += 1) sum += samples[i + j] * samples[i + j]
    frames.push(Math.sqrt(sum / hop))
  }
  if (!frames.length) return -99
  frames.sort((a, b) => a - b)
  const pick = (p) => frames[Math.min(frames.length - 1, Math.floor(frames.length * p))] || 1e-6
  const speech = pick(0.9)
  const noise = Math.max(pick(0.1), 1e-6)
  return 20 * Math.log10(speech / noise)
}

const profile = (await api('GET', `/profiles/${PROFILE_ID}`)).profile
const versions = profile.versions || []
const prevIds = new Set(versions.at(-2)?.sampleIds || [])
const latestIds = new Set(versions.at(-1)?.sampleIds || [])
const added = profile.samples.filter((s) => latestIds.has(s.id) && !prevIds.has(s.id))
console.log(`${profile.name}: added samples ${added.length}, keeping ${KEEP}`)

const scored = []
for (const sample of added) {
  const file = path.join(HOME, (sample.wavRel || '').replace('/', path.sep))
  let snr = -99
  try {
    snr = await snrOf(file)
  } catch (error) {
    console.log('  snr failed', sample.id, error.message)
  }
  scored.push({ sample, snr })
}

// 明显异常（质心 > 3500 通常是音乐/杂音）直接排后面
scored.sort((a, b) => {
  const pa = (a.sample.centroid || 0) > 3500 ? 1 : 0
  const pb = (b.sample.centroid || 0) > 3500 ? 1 : 0
  if (pa !== pb) return pa - pb
  if ((b.sample.quality || 0) !== (a.sample.quality || 0)) return (b.sample.quality || 0) - (a.sample.quality || 0)
  return b.snr - a.snr
})

for (const { sample, snr } of scored) {
  console.log(`  ${snr.toFixed(1).padStart(5)} dB  q=${sample.quality}  f0=${Math.round(sample.f0)} cent=${Math.round(sample.centroid)}  ${sample.filename}`)
}

const keep = scored.slice(0, KEEP)
const drop = scored.slice(KEEP)
console.log('keep:', keep.map((k) => k.sample.filename).join(', '))
let removed = 0
for (const { sample } of drop) {
  try {
    await api('POST', `/profiles/${PROFILE_ID}/samples/${sample.id}/delete`)
    removed += 1
  } catch (error) {
    console.log('  delete failed', sample.id, error.message)
  }
}
console.log('removed:', removed)

const after = (await api('GET', `/profiles/${PROFILE_ID}`)).profile
console.log('samples now:', after.sampleCount)

await api('POST', `/profiles/${PROFILE_ID}/train`, { note: `只保留最干净的 ${KEEP} 段说话样本` })
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
