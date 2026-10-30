/** Core smoke test without the DSH host: store -> add samples -> train -> preview. */
import { rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VoiceStore } from '../lib/store.mjs'
import { AudioEngine } from '../lib/audio-engine.mjs'
import { VoiceService } from '../lib/voice-service.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const home = path.join(ROOT, 'output', 'smoke-home')
await rm(home, { recursive: true, force: true })
process.env.DSH_VOICE_HOME = home

const engine = new AudioEngine()
const status = await engine.status()
console.log('ENGINE', JSON.stringify(status, null, 2))
if (!status.ok) throw new Error('engine not ready')

const store = await new VoiceStore({ root: home }).init()
const delivery = { ctx: { sessions: { get: () => null } }, deliver: () => ({ ok: true }) }
const voice = await new VoiceService({ store, engine, delivery, logger: console }).init()

const demoRoot = existsSync(path.join(ROOT, 'output', 'demo', 'demo-original.wav'))
  ? path.join(ROOT, 'output', 'demo')
  : path.join(ROOT, 'examples', 'demo')

const samples = [
  path.join(demoRoot, 'samples', 'profile-a', 'sample-1.wav'),
  path.join(demoRoot, 'samples', 'profile-a', 'sample-2.wav'),
  path.join(demoRoot, 'samples', 'profile-a', 'sample-3.wav'),
]
const profile = voice.createProfile({ name: '验收-低音A', description: 'core smoke', tags: ['test'] })
for (const file of samples) {
  const fs = await import('node:fs/promises')
  const result = await voice.addSample(profile.id, { buffer: await fs.readFile(file), filename: path.basename(file) })
  console.log('SAMPLE', result.samples[0]?.duration, result.samples[0]?.quality)
}
const train = await voice.train(profile.id, 'smoke v1')
console.log('TRAIN', train.jobId)
for (let i = 0; i < 60; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  const detail = voice.detail(profile.id)
  if (!detail.training || detail.training.status !== 'training') {
    console.log('TRAIN_STATUS', detail.training?.status, detail.training?.error || '')
    console.log('VERSIONS', detail.versions.map((v) => ({ id: v.id, sampleCount: v.sampleCount, similarity: v.metrics?.similarity, preview: v.previewAudioUrl })))
    if (detail.training?.status === 'failed') process.exitCode = 2
    break
  }
}
const detail = voice.detail(profile.id)
console.log('DETAIL', JSON.stringify({ sampleCount: detail.sampleCount, currentVersion: detail.currentVersion, lastTrainedAt: detail.lastTrainedAt }, null, 2))
const preview = await voice.preview(profile.id, { text: '这是一次核心链路试听。', emotion: 'tender' })
console.log('PREVIEW', JSON.stringify(preview, null, 2))
const speak = await voice.speak({ text: '你好，这是语音合成测试。', profileId: profile.id, deliver: false })
console.log('SPEAK', JSON.stringify({ audioUrl: speak.audioUrl, duration: speak.duration, emotion: speak.emotionKey }, null, 2))
await store.flush()
console.log('OK')
