/** Emotion prosody smoke test: same text, seven emotion labels. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VoiceStore } from '../lib/store.mjs'
import { AudioEngine } from '../lib/audio-engine.mjs'
import { VoiceService } from '../lib/voice-service.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const home = path.join(ROOT, 'output', 'emotion-home')
process.env.DSH_VOICE_HOME = home
const store = await new VoiceStore({ root: home }).init()
const engine = new AudioEngine()
const delivery = { ctx: { sessions: { get: () => null } }, deliver: () => ({ ok: true }) }
const voice = await new VoiceService({ store, engine, delivery, logger: console }).init()
const profile = store.defaultProfile()
const text = '今天收到你的消息，我很高兴。无论发生什么，我都会认真陪你把这件事处理好。'
const emotions = ['calm', 'happy', 'tender', 'serious', 'comforting', 'excited', 'sad']
const results = []
for (const emotion of emotions) {
  const out = await voice.speak({ text, profileId: profile.id, emotion, deliver: false })
  const wav = path.join(home, 'temp', `emotion-${emotion}.wav`)
  await engine.decodeToWav(path.join(store.root, out.audioRel), wav, { sampleRate: 24000, channels: 1 })
  const analysis = await engine.analyze(wav)
  results.push({
    emotion,
    duration: out.duration,
    f0: analysis.f0,
    centroid: analysis.centroid,
    rate: out.params.speed,
    pitch: out.params.pitchSemitones,
  })
  console.log(emotion.padEnd(10), 'dur=', out.duration.toFixed(2), 'f0=', analysis.f0.toFixed(1), 'pitch=', out.params.pitchSemitones.toFixed(2), 'rate=', out.params.speed.toFixed(2))
}
const f0s = results.map((item) => item.f0)
const spread = Math.max(...f0s) - Math.min(...f0s)
console.log('F0 spread', spread.toFixed(2))
if (spread < 12) throw new Error('emotion pitch differences too small')
const durations = results.map((item) => item.duration)
if (Math.max(...durations) - Math.min(...durations) < 0.5) throw new Error('emotion rate differences too small')
console.log('EMOTION SMOKE PASSED')
