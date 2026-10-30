/**
 * 手动翻唱流水线（不依赖插件进程内的旧代码）：
 * decode -> separate(原声抑制 0.5) -> convert(额外降调) -> mix -> encode
 * 输出直接写进插件 audio/covers/manual-xxx/，客户端可经 /api/file 播放。
 */
import path from 'node:path'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { AudioEngine } from '../lib/audio-engine.mjs'

const HOME = path.join(process.env.USERPROFILE, '.dsh', 'dsh-voice-unified')
const PROFILE_ID = process.env.COVER_PROFILE || 'p_baed9caa768b42ceb0'
const SOURCE = process.argv[2]
const PITCH_EXTRA = Number(process.argv[3] || -2)
const OUT_ID = process.argv[4] || `manual-${Date.now()}`
const FORMANT_ARG = process.argv[5] !== undefined ? Number(process.argv[5]) : null
const BRIGHT_ARG = process.argv[6] !== undefined ? Number(process.argv[6]) : null
const OVERRIDES = process.env.COVER_OVERRIDES ? JSON.parse(process.env.COVER_OVERRIDES) : {}

const state = JSON.parse(await readFile(path.join(HOME, 'state.json'), 'utf8'))
const profile = state.profiles.find((p) => p.id === PROFILE_ID)
const version = profile.versions.find((v) => v.id === profile.currentVersionId) || profile.versions.at(-1)
const model = version.model
console.log('profile:', profile.name, '| base:', profile.baseVoice, '| model pitch:', model.pitchSemitones)

const workDir = path.join(HOME, 'temp', OUT_ID)
const outDir = path.join(HOME, 'audio', 'covers', OUT_ID)
await mkdir(workDir, { recursive: true })
await mkdir(outDir, { recursive: true })

const engine = new AudioEngine()
const srcWav = path.join(workDir, 'source.wav')
const vocal = path.join(workDir, 'vocal.wav')
const inst = path.join(workDir, 'inst.wav')
const conv = path.join(workDir, 'conv.wav')
const mixed = path.join(workDir, 'mixed.wav')

await engine.decodeToWav(SOURCE, srcWav, { sampleRate: 44100, channels: 2 })
const sep = await engine.separate(srcWav, vocal, inst, { vocalSuppress: 0.5 })
console.log('separated, maskMean', sep.maskMean, 'vocalSuppress', sep.vocalSuppress)

const pitch = Math.max(-8, Math.min(8, Number(model.pitchSemitones) + PITCH_EXTRA))
const formantUse = Math.max(0.84, Math.min(1.4, FORMANT_ARG ?? Number(model.formant)))
const brightUse = Math.max(-0.35, Math.min(0.45, BRIGHT_ARG ?? Number(model.brightness)))
console.log('convert pitch:', pitch, '(base %s + %s)', model.pitchSemitones, PITCH_EXTRA)
console.log('formant:', formantUse, '| brightness:', brightUse)
await engine.convert(vocal, conv, {
  pitchSemitones: pitch,
  formant: formantUse,
  brightness: brightUse,
  strength: Math.max(0.3, Math.min(1, Number(OVERRIDES.strength ?? model.strength ?? 1))),
  speed: 1,
  vibrato: Number(OVERRIDES.vibrato ?? 0.06),
  tremolo: Number(OVERRIDES.tremolo ?? 0.02),
})

await engine.mix(conv, inst, mixed, { vocalGain: Number(OVERRIDES.vocalGain ?? 1.25) })
const mp3 = path.join(outDir, 'cover.mp3')
await engine.encodeAudio(mixed, mp3, { format: 'mp3', bitrate: '192k' })
const info = await stat(mp3)
const duration = await engine.duration(mp3)
console.log('done:', mp3, (info.size / 1024 / 1024).toFixed(1) + ' MB', '|', duration.toFixed(1) + 's')
console.log('url: /plugins/dsh-voice-unified/api/file/audio/covers/' + OUT_ID + '/cover.mp3')
