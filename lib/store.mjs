/** Durable JSON state and directory layout for dsh-voice-unified. */
import { homedir } from 'node:os'
import path from 'node:path'
import { ensureDir, newId, nowIso, readJson, writeJsonAtomic } from './util.mjs'

export const BUILTIN_PROFILES = [
  {
    id: 'p_builtin_warm',
    name: '温柔女声',
    description: '内置 AI 音色：柔和、亲切，适合日常播报与安慰语气。',
    tags: ['内置', '女声', '温柔'],
    kind: 'builtin',
    status: 'active',
    baseVoice: 'Microsoft Huihui Desktop',
    model: { pitchSemitones: 0, formant: 1.02, brightness: 0.04, speed: 1.0, strength: 0.65, vibrato: 0, quality: 82 },
  },
  {
    id: 'p_builtin_deep',
    name: '沉稳男声',
    description: '内置 AI 音色：低音、克制，适合严肃说明与长文播报。',
    tags: ['内置', '男声', '沉稳'],
    kind: 'builtin',
    status: 'active',
    baseVoice: 'Microsoft Huihui Desktop',
    model: { pitchSemitones: -5.2, formant: 0.9, brightness: -0.2, speed: 0.95, strength: 1, vibrato: 0, quality: 78 },
  },
  {
    id: 'p_builtin_bright',
    name: '明亮少年',
    description: '内置 AI 音色：偏高、轻快，适合开心与兴奋情绪。',
    tags: ['内置', '少年', '明亮'],
    kind: 'builtin',
    status: 'active',
    baseVoice: 'Microsoft Huihui Desktop',
    model: { pitchSemitones: 3.6, formant: 1.08, brightness: 0.22, speed: 1.06, strength: 1, vibrato: 0.02, quality: 76 },
  },
  {
    id: 'p_builtin_en',
    name: '英文旁白',
    description: '内置 AI 音色：英文女声，适合英文回复。',
    tags: ['内置', '英文', '旁白'],
    kind: 'builtin',
    status: 'active',
    baseVoice: 'Microsoft Zira Desktop',
    model: { pitchSemitones: -0.4, formant: 1.0, brightness: 0.02, speed: 1.0, strength: 0.8, vibrato: 0, quality: 80 },
  },
]

export const DEFAULT_SETTINGS = {
  autoReply: false,
  intentReply: true,
  autoplay: true,
  modeVersion: 2,
  emotionIntensity: 0.7,
  speed: 1.0,
  volume: 1.0,
  crossTurnEmotion: true,
  defaultEmotion: 'calm',
  cloudAuthorized: false,
  maxReplyChars: 600,
  replyFormat: 'mp3',
}

const STATE_VERSION = 1

export function defaultState() {
  const createdAt = nowIso()
  const profiles = BUILTIN_PROFILES.map((profile) => ({
    ...profile,
    createdAt,
    updatedAt: createdAt,
    samples: [],
    versions: [{
      id: 'v_builtin',
      label: '内置 v1',
      createdAt,
      sampleCount: 0,
      status: 'ready',
      metrics: { similarity: 0, quality: profile.model.quality },
      model: profile.model,
      note: '内置音色',
      previewAudioUrl: '',
    }],
    currentVersionId: 'v_builtin',
    lastTrainedAt: null,
    training: null,
    previews: [],
  }))
  return {
    version: STATE_VERSION,
    createdAt,
    updatedAt: createdAt,
    defaultProfileId: 'p_builtin_warm',
    settings: { ...DEFAULT_SETTINGS },
    profiles,
    covers: [],
    previews: [],
    emotionStates: {},
    musicCache: { directories: [], entries: [] },
    lastSessionId: '',
    /** 语音卡片待投递队列（会话不在线/回合进行中时暂存，最多 20 条、12 小时过期）。 */
    pendingVoice: [],
    lastError: null,
    counters: {},
  }
}

export class VoiceStore {
  constructor({ root } = {}) {
    this.root = root || process.env.DSH_VOICE_HOME || path.join(homedir(), '.dsh', 'dsh-voice-unified')
    this.stateFile = path.join(this.root, 'state.json')
    this.state = defaultState()
    this.saveTimer = null
    this.savePromise = Promise.resolve()
  }

  async init() {
    await ensureDir(this.root)
    await ensureDir(path.join(this.root, 'audio'))
    await ensureDir(path.join(this.root, 'samples'))
    await ensureDir(path.join(this.root, 'cache'))
    await ensureDir(path.join(this.root, 'temp'))
    const loaded = await readJson(this.stateFile, null)
    if (loaded && typeof loaded === 'object') {
      this.state = this.migrate(loaded)
    } else {
      this.state = defaultState()
    }
    this.normalize()
    this.normalizePendingVoice()
    this.normalizeLastError()
    await this.saveNow()
    return this
  }

  migrate(loaded) {
    const state = { ...defaultState(), ...loaded }
    state.settings = { ...DEFAULT_SETTINGS, ...(loaded.settings || {}) }
    // v1.1: default is "voice only when requested". Existing profiles that
    // predate the intent mode are migrated once to autoReply=false so the
    // plugin never starts speaking unasked.
    if (loaded.settings?.modeVersion === undefined || Number(loaded.settings.modeVersion) < 2) {
      state.settings.autoReply = false
      state.settings.intentReply = true
      state.settings.modeVersion = 2
    }
    state.profiles = Array.isArray(loaded.profiles) ? loaded.profiles : []
    state.covers = Array.isArray(loaded.covers) ? loaded.covers : []
    state.previews = Array.isArray(loaded.previews) ? loaded.previews : []
    state.emotionStates = loaded.emotionStates && typeof loaded.emotionStates === 'object' ? loaded.emotionStates : {}
    state.musicCache = { directories: [], entries: [], ...(loaded.musicCache || {}) }
    state.pendingVoice = Array.isArray(loaded.pendingVoice) ? loaded.pendingVoice : []
    state.counters = loaded.counters && typeof loaded.counters === 'object' ? loaded.counters : {}
    state.version = STATE_VERSION
    return state
  }

  normalize() {
    if (!this.state.profiles.length) {
      this.state.profiles = defaultState().profiles
    }
    for (const builtin of BUILTIN_PROFILES) {
      if (!this.state.profiles.some((profile) => profile.id === builtin.id)) {
        const createdAt = nowIso()
        this.state.profiles.push({
          ...builtin,
          createdAt,
          updatedAt: createdAt,
          samples: [],
          versions: [{ id: 'v_builtin', label: '内置 v1', createdAt, sampleCount: 0, status: 'ready', metrics: { similarity: 0, quality: builtin.model.quality }, model: builtin.model, note: '内置音色', previewAudioUrl: '' }],
          currentVersionId: 'v_builtin',
          lastTrainedAt: null,
          training: null,
          previews: [],
        })
      }
    }
    for (const profile of this.state.profiles) {
      profile.tags = Array.isArray(profile.tags) ? profile.tags : []
      profile.samples = Array.isArray(profile.samples) ? profile.samples : []
      profile.versions = Array.isArray(profile.versions) ? profile.versions : []
      profile.previews = Array.isArray(profile.previews) ? profile.previews : []
      profile.status = profile.status === 'disabled' ? 'disabled' : 'active'
      profile.kind = profile.kind === 'builtin' ? 'builtin' : 'cloned'
      if (!profile.currentVersionId) profile.currentVersionId = profile.versions.at(-1)?.id || null
    }
    if (!this.state.profiles.some((profile) => profile.id === this.state.defaultProfileId && profile.status === 'active')) {
      this.state.defaultProfileId = this.state.profiles.find((profile) => profile.status === 'active')?.id || null
    }
    for (const job of this.state.covers) {
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'failed'
        job.error = '插件重启导致任务中断，请点击重试。'
        job.stage = 'failed'
        job.updatedAt = nowIso()
        job.logs = [...(job.logs || []), `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 插件重启，任务中断`].slice(-200)
      }
    }
  }

  /** 清理待投递队列里没有音频地址或已过期的条目。 */
  normalizePendingVoice(maxAgeMs = 12 * 60 * 60 * 1000) {
    const list = this.state.pendingVoice
    if (!Array.isArray(list)) {
      this.state.pendingVoice = []
      return
    }
    const cutoff = Date.now() - maxAgeMs
    this.state.pendingVoice = list
      .filter((entry) => entry && typeof entry === 'object' && entry.payload && entry.payload.audioUrl)
      .filter((entry) => Number(entry.at) > cutoff)
      .slice(-20)
  }

  /** 启动时清掉一天前的旧错误，避免面板一直挂着早就恢复的报错。 */
  normalizeLastError(maxAgeMs = 24 * 60 * 60 * 1000) {
    const err = this.state.lastError
    if (!err || typeof err !== 'object') return
    const at = Date.parse(err.at || '')
    if (!Number.isFinite(at) || Date.now() - at > maxAgeMs) this.state.lastError = null
  }

  profile(id) {
    return this.state.profiles.find((profile) => profile.id === id)
  }

  defaultProfile() {
    return this.profile(this.state.defaultProfileId) || this.state.profiles.find((profile) => profile.status === 'active')
  }

  nextCounter(key) {
    const next = Number(this.state.counters[key] || 0) + 1
    this.state.counters[key] = next
    return next
  }

  touch() {
    this.state.updatedAt = nowIso()
    this.scheduleSave()
  }

  scheduleSave(delay = 120) {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveNow().catch(() => {})
    }, delay)
  }

  async saveNow() {
    this.state.updatedAt = nowIso()
    this.savePromise = this.savePromise.then(() => writeJsonAtomic(this.stateFile, this.state)).catch((error) => {
      // Keep the previous promise chain alive, but never hide the failure from logs.
      console.error('[dsh-voice-unified] state save failed:', error)
    })
    await this.savePromise
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.saveNow()
  }

  newId(prefix) {
    return newId(prefix)
  }

  profiles() {
    return this.state.profiles
  }

  covers() {
    return this.state.covers
  }

  settings() {
    return this.state.settings
  }
}
