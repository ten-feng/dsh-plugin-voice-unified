/** Cover smoke test: demo original -> pipeline -> durable voice message. */
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { VoiceStore } from '../lib/store.mjs'
import { AudioEngine } from '../lib/audio-engine.mjs'
import { VoiceService } from '../lib/voice-service.mjs'
import { CoverService } from '../lib/cover-service.mjs'
import { MusicCache } from '../lib/music-cache.mjs'
import { SessionDelivery } from '../lib/delivery.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const demoRoot = existsSync(path.join(ROOT, 'output', 'demo', 'demo-original.wav'))
  ? path.join(ROOT, 'output', 'demo')
  : path.join(ROOT, 'examples', 'demo')
process.env.DSH_VOICE_HOME = path.join(ROOT, 'output', 'smoke-home')

const events = []
const appended = []
const session = {
  id: 'session-smoke',
  events,
  append(type, data, opts) {
    const event = { type, data, ...opts, seq: events.length, time: Date.now() }
    events.push(event)
    appended.push(event)
    return event
  },
}
const ctx = { sessions: { get: (id) => (id === 'session-smoke' ? session : undefined) } }

const store = await new VoiceStore({ root: process.env.DSH_VOICE_HOME }).init()
const engine = new AudioEngine()
const delivery = new SessionDelivery({ ctx, store, logger: console })
const voice = await new VoiceService({ store, engine, delivery, logger: console }).init()
const musicCache = await new MusicCache({ store, root: store.root, logger: console, getOrigin: () => 'http://127.0.0.1:1' }).init()
const covers = await new CoverService({ store, engine, voice, musicCache, delivery, logger: console }).init()

const profile = store.profiles().find((item) => item.kind === 'cloned' && item.versions.some((version) => version.status === 'ready'))
if (!profile) throw new Error('no trained profile; run core-smoke first')

session.events.push({
  type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 },
})
const result = await covers.enqueue({
  sourcePath: path.join(demoRoot, 'demo-original.wav'),
  songName: '晚风里的旋律（示例）',
  profileId: profile.id,
  sessionId: 'session-smoke',
  deliver: true,
})
console.log('ENQUEUED', result.job.id)
for (let i = 0; i < 240; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const job = covers.get(result.job.id)
  if (job.status === 'done' || job.status === 'failed') {
    console.log('JOB', JSON.stringify({ status: job.status, stage: job.stage, progress: job.progress, error: job.error, output: job.output, logs: job.logs?.slice(-8) }, null, 2))
    if (job.status === 'failed') process.exitCode = 2
    break
  }
  if (i % 5 === 0) console.log('PROGRESS', job.progress, job.stage)
}
const finalJob = covers.get(result.job.id)
console.log('DELIVERY', JSON.stringify({ mode: finalJob.delivery?.mode, deferred: finalJob.delivery?.deferred, hasFence: Boolean(finalJob.delivery?.fence) }))
if (!finalJob.delivery?.fence) {
  console.log('FAIL 翻唱完成但没有生成语音播放器围栏')
  process.exitCode = 2
} else {
  console.log('FENCE', String(finalJob.delivery.fence).slice(1, 120))
}
console.log('APPENDED', appended.length, '（围栏优先模式下不写会话日志是预期行为）')
await store.flush()
