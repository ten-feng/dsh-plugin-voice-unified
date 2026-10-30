/** API smoke test: boots services, serves HTTP, exercises the management routes. */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VoiceStore } from '../lib/store.mjs'
import { AudioEngine } from '../lib/audio-engine.mjs'
import { VoiceService } from '../lib/voice-service.mjs'
import { CoverService } from '../lib/cover-service.mjs'
import { MusicCache } from '../lib/music-cache.mjs'
import { SessionDelivery } from '../lib/delivery.mjs'
import { createApi } from '../lib/api.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
process.env.DSH_VOICE_HOME = path.join(ROOT, 'output', 'smoke-home')
const ctx = { sessions: { get: () => undefined } }
const store = await new VoiceStore({ root: process.env.DSH_VOICE_HOME }).init()
const engine = new AudioEngine()
const delivery = new SessionDelivery({ ctx, store, logger: console })
const voice = await new VoiceService({ store, engine, delivery, logger: console }).init()
const musicCache = await new MusicCache({ store, logger: console, getOrigin: () => 'http://127.0.0.1:1' }).init()
const covers = await new CoverService({ store, engine, voice, musicCache, delivery, logger: console }).init()
const api = createApi({ store, engine, voice, covers, musicCache, delivery, logger: console })

const server = http.createServer((req, res) => void api.handle(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}/plugins/dsh-voice-unified/api`
const check = (condition, message) => {
  if (!condition) throw new Error(`FAIL ${message}`)
  console.log(`PASS ${message}`)
}
const get = async (path) => {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: await response.json() }
}
const post = async (path, body, method = 'POST') => {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}

try {
  const health = await get('/health')
  check(health.status === 200 && health.body.ok, 'GET /health')
  check(health.body.engine?.ok === true, 'engine ready')

  const profiles = await get('/profiles')
  check(profiles.body.profiles.length >= 3, 'GET /profiles has 3+ profiles')

  const created = await post('/profiles', { name: `API 验收 ${Date.now()}`, description: 'api', tags: ['api'] })
  check(created.status === 200 && created.body.profile?.id, 'POST /profiles')

  const settings = await get('/settings')
  const patched = await post('/settings', { emotionIntensity: 0.55, autoReply: false }, 'PATCH')
  check(patched.body.settings.emotionIntensity === 0.55 && patched.body.settings.autoReply === false, 'PATCH /settings')
  await post('/settings', { autoReply: settings.body.settings.autoReply }, 'PATCH')

  const preview = await post(`/profiles/${created.body.profile.id}/preview`, { text: '接口试听', emotion: 'happy' })
  check(preview.status === 400, 'preview without samples fails with readable error')

  const sampleFile = path.join(ROOT, 'output', 'demo', 'samples', 'profile-b', 'sample-1.wav')
  const fs = await import('node:fs/promises')
  const sampleBase64 = (await fs.readFile(sampleFile)).toString('base64')
  const upload = await post(`/profiles/${created.body.profile.id}/samples`, { filename: 'sample-1.wav', dataBase64: sampleBase64 })
  check(upload.status === 200 && upload.body.samples?.length === 1, 'POST sample upload')

  const train = await post(`/profiles/${created.body.profile.id}/train`, { note: 'api' })
  check(train.status === 200 && train.body.jobId, 'POST train')
  let detail
  for (let i = 0; i < 80; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    detail = await get(`/profiles/${created.body.profile.id}`)
    if (detail.body.profile?.training?.status !== 'training') break
  }
  check(detail.body.profile?.training?.status === 'done', 'training completes')
  check(detail.body.profile?.currentVersion?.id === 'v1', 'version created')
  const preview2 = await post(`/profiles/${created.body.profile.id}/preview`, { text: '接口试听', emotion: 'happy' })
  check(preview2.status === 200 && preview2.body.audioUrl, 'POST preview')
  check(preview2.body.similarity != null, 'preview similarity present')

  const audioPath = preview2.body.audioUrl.replace('/plugins/dsh-voice-unified/api', '')
  const audio = await fetch(`http://127.0.0.1:${port}${preview2.body.audioUrl}`, { headers: { range: 'bytes=0-99' } })
  check(audio.status === 206 && (await audio.arrayBuffer()).byteLength === 100, 'audio Range 206')

  const jobs = await get('/cover/jobs')
  check(jobs.status === 200 && Array.isArray(jobs.body.jobs), 'GET /cover/jobs')

  const cache = await get('/music/cache')
  check(cache.status === 200 && Array.isArray(cache.body.entries), 'GET /music/cache')

  console.log('API SMOKE PASSED')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await store.flush()
}
