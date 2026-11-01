/** Voice profiles, training versions, emotion-aware TTS and previews. */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  clamp,
  ensureDir,
  fileSize,
  firstMeaningfulError,
  newId,
  normalizeTags,
  nowIso,
  readJson,
  relativeUrl,
  safeFileName,
} from './util.mjs'
import { analyzeEmotion, EMOTIONS, emotionParams, listEmotions, normalizeEmotion } from './emotion.mjs'

const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.aac', '.webm', '.opus'])
const BASE_F0 = {
  'Microsoft Huihui Desktop': 226,
  'Microsoft Zira Desktop': 205,
}
const BASE_CENTROID = 1200

function extensionOf(name, fallback = '.wav') {
  const ext = path.extname(String(name || '')).toLowerCase()
  return AUDIO_EXT.has(ext) ? ext : fallback
}

function weightedAverage(items, key, weightKey = 'duration') {
  let total = 0
  let sum = 0
  for (const item of items) {
    const value = Number(item[key])
    const weight = Math.max(0.1, Number(item[weightKey]) || 1)
    if (!Number.isFinite(value) || value <= 0) continue
    sum += value * weight
    total += weight
  }
  return total > 0 ? sum / total : 0
}

export class VoiceService {
  constructor({ store, engine, delivery, logger } = {}) {
    this.store = store
    this.engine = engine
    this.delivery = delivery
    this.logger = logger
    this.root = store.root
    this.samplesRoot = path.join(this.root, 'samples')
    this.audioRoot = path.join(this.root, 'audio')
    this.repliesRoot = path.join(this.audioRoot, 'replies')
    this.previewsRoot = path.join(this.audioRoot, 'previews')
    this.tempRoot = path.join(this.root, 'temp')
    this.synthesizing = new Set()
  }

  async init() {
    await Promise.all([
      ensureDir(this.samplesRoot),
      ensureDir(this.repliesRoot),
      ensureDir(this.previewsRoot),
      ensureDir(this.tempRoot),
    ])
    return this
  }

  settings() {
    return this.store.state.settings
  }

  settingsView() {
    return {
      ...this.store.state.settings,
      emotions: listEmotions(),
      defaultProfileId: this.store.state.defaultProfileId,
    }
  }

  updateSettings(patch = {}) {
    const settings = this.store.state.settings
    if (patch.autoReply !== undefined) settings.autoReply = Boolean(patch.autoReply)
    if (patch.intentReply !== undefined) settings.intentReply = Boolean(patch.intentReply)
    if (patch.autoplay !== undefined) settings.autoplay = Boolean(patch.autoplay)
    if (patch.crossTurnEmotion !== undefined) settings.crossTurnEmotion = Boolean(patch.crossTurnEmotion)
    if (patch.cloudAuthorized !== undefined) settings.cloudAuthorized = Boolean(patch.cloudAuthorized)
    if (patch.emotionIntensity !== undefined) settings.emotionIntensity = clamp(patch.emotionIntensity, 0, 1)
    if (patch.speed !== undefined) settings.speed = clamp(patch.speed, 0.75, 1.3)
    if (patch.volume !== undefined) settings.volume = clamp(patch.volume, 0, 1.5)
    if (patch.maxReplyChars !== undefined) settings.maxReplyChars = Math.round(clamp(patch.maxReplyChars, 80, 1200))
    if (patch.defaultEmotion !== undefined) settings.defaultEmotion = normalizeEmotion(patch.defaultEmotion) || 'calm'
    if (patch.replyFormat !== undefined && ['mp3', 'wav'].includes(patch.replyFormat)) settings.replyFormat = patch.replyFormat
    if (patch.resetEmotion !== undefined) {
      if (patch.sessionId) delete this.store.state.emotionStates[patch.sessionId]
      else this.store.state.emotionStates = {}
    }
    this.store.touch()
    return this.settingsView()
  }

  resetEmotion(sessionId) {
    if (sessionId) delete this.store.state.emotionStates[sessionId]
    else this.store.state.emotionStates = {}
    this.store.touch()
    return { ok: true, message: sessionId ? '已重置当前会话情绪' : '已重置所有会话情绪' }
  }

  summary(profile) {
    if (!profile) return null
    const current = profile.versions?.find((version) => version.id === profile.currentVersionId) || profile.versions?.at(-1) || null
    const samples = profile.samples || []
    return {
      id: profile.id,
      name: profile.name,
      description: profile.description || '',
      tags: profile.tags || [],
      kind: profile.kind,
      status: profile.status,
      baseVoice: profile.baseVoice || '',
      sampleCount: samples.length,
      totalDuration: Number(samples.reduce((sum, sample) => sum + (Number(sample.duration) || 0), 0).toFixed(2)),
      lastTrainedAt: profile.lastTrainedAt || null,
      currentVersion: current ? {
        id: current.id,
        label: current.label,
        createdAt: current.createdAt,
        sampleCount: current.sampleCount,
        quality: current.metrics?.quality ?? 0,
        similarity: current.metrics?.similarity ?? 0,
        previewAudioUrl: current.previewAudioUrl || '',
      } : null,
      versionCount: profile.versions?.length || 0,
      isDefault: profile.id === this.store.state.defaultProfileId,
      training: profile.training || null,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      needsRetrain: Boolean(profile.needsRetrain),
    }
  }

  list() {
    return this.store.state.profiles.map((profile) => this.summary(profile))
  }

  detail(id) {
    const profile = this.store.profile(id)
    if (!profile) throw Object.assign(new Error(`音色档案不存在：${id}`), { code: 'PROFILE_NOT_FOUND' })
    return {
      ...this.summary(profile),
      samples: (profile.samples || []).map((sample) => ({
        ...sample,
        previewAudioUrl: sample.wavRel ? relativeUrl(sample.wavRel) : '',
      })),
      versions: (profile.versions || []).map((version) => ({
        ...version,
        previewAudioUrl: version.previewAudioUrl || (version.previewRel ? relativeUrl(version.previewRel) : ''),
      })),
      previews: (profile.previews || []).slice(-20).reverse(),
    }
  }

  createProfile({ name, description = '', tags = [], kind = 'cloned', baseVoice = 'Microsoft Huihui Desktop' } = {}) {
    const trimmed = String(name || '').trim()
    if (!trimmed) throw Object.assign(new Error('音色名称不能为空'), { code: 'BAD_NAME' })
    if (trimmed.length > 40) throw Object.assign(new Error('音色名称最长 40 个字符'), { code: 'BAD_NAME' })
    if (this.store.state.profiles.some((profile) => profile.name === trimmed)) {
      throw Object.assign(new Error(`已存在同名音色：${trimmed}`), { code: 'DUPLICATE_NAME' })
    }
    const createdAt = nowIso()
    const profile = {
      id: newId('p'),
      name: trimmed,
      description: String(description || '').slice(0, 500),
      tags: normalizeTags(tags),
      kind: kind === 'builtin' ? 'builtin' : 'cloned',
      status: 'active',
      baseVoice: String(baseVoice || 'Microsoft Huihui Desktop'),
      samples: [],
      versions: [],
      currentVersionId: null,
      lastTrainedAt: null,
      training: null,
      previews: [],
      needsRetrain: true,
      createdAt,
      updatedAt: createdAt,
    }
    this.store.state.profiles.push(profile)
    this.store.touch()
    return profile
  }

  updateProfile(id, patch = {}) {
    const profile = this.store.profile(id)
    if (!profile) throw Object.assign(new Error(`音色档案不存在：${id}`), { code: 'PROFILE_NOT_FOUND' })
    if (patch.name !== undefined) {
      const name = String(patch.name).trim()
      if (!name) throw Object.assign(new Error('音色名称不能为空'), { code: 'BAD_NAME' })
      if (this.store.state.profiles.some((item) => item.id !== id && item.name === name)) {
        throw Object.assign(new Error(`已存在同名音色：${name}`), { code: 'DUPLICATE_NAME' })
      }
      profile.name = name
    }
    if (patch.description !== undefined) profile.description = String(patch.description || '').slice(0, 500)
    if (patch.tags !== undefined) profile.tags = normalizeTags(patch.tags)
    if (patch.baseVoice !== undefined && profile.kind !== 'builtin') profile.baseVoice = String(patch.baseVoice || profile.baseVoice)
    if (patch.status !== undefined) {
      const next = patch.status === 'disabled' ? 'disabled' : 'active'
      if (profile.id === this.store.state.defaultProfileId && next === 'disabled') {
        throw Object.assign(new Error('全局默认音色不能停用，请先切换默认音色'), { code: 'DEFAULT_CANNOT_DISABLE' })
      }
      profile.status = next
    }
    profile.updatedAt = nowIso()
    this.store.touch()
    return this.summary(profile)
  }

  async deleteProfile(id) {
    const profile = this.store.profile(id)
    if (!profile) throw Object.assign(new Error(`音色档案不存在：${id}`), { code: 'PROFILE_NOT_FOUND' })
    if (profile.kind === 'builtin') throw Object.assign(new Error('内置音色不可删除，可停用或新建克隆音色'), { code: 'BUILTIN_PROTECTED' })
    this.store.state.profiles = this.store.state.profiles.filter((item) => item.id !== id)
    if (this.store.state.defaultProfileId === id) {
      this.store.state.defaultProfileId = this.store.state.profiles.find((item) => item.status === 'active')?.id || null
    }
    await rm(path.join(this.samplesRoot, id), { recursive: true, force: true }).catch(() => {})
    for (const version of profile.versions || []) {
      if (version.previewRel) await rm(path.join(this.root, version.previewRel), { force: true }).catch(() => {})
    }
    this.store.touch()
    return { ok: true, id, defaultProfileId: this.store.state.defaultProfileId }
  }

  setDefault(id) {
    const profile = this.store.profile(id)
    if (!profile) throw Object.assign(new Error(`音色档案不存在：${id}`), { code: 'PROFILE_NOT_FOUND' })
    if (profile.status !== 'active') throw Object.assign(new Error('停用的音色不能设为全局默认'), { code: 'PROFILE_DISABLED' })
    if (profile.kind === 'cloned' && !profile.currentVersionId) {
      throw Object.assign(new Error(`音色「${profile.name}」尚未训练，训练完成后才能设为全局默认。`), { code: 'NOT_TRAINED' })
    }
    this.store.state.defaultProfileId = id
    this.store.touch()
    return { ok: true, defaultProfileId: id, profile: this.summary(profile) }
  }

  resolveProfile(id) {
    const profile = id ? this.store.profile(id) : this.store.defaultProfile()
    if (!profile) throw Object.assign(new Error('还没有可用的音色档案，请先创建并训练音色'), { code: 'NO_PROFILE' })
    if (profile.status !== 'active') throw Object.assign(new Error(`音色「${profile.name}」已停用`), { code: 'PROFILE_DISABLED' })
    return profile
  }

  async addSample(profileId, { buffer, filename = 'sample.wav', filePath, slice = false, signal } = {}) {
    const profile = this.store.profile(profileId)
    if (!profile) throw Object.assign(new Error(`音色档案不存在：${profileId}`), { code: 'PROFILE_NOT_FOUND' })
    let data = buffer
    if (!data && filePath) data = await readFile(filePath)
    if (!data || !data.length) throw Object.assign(new Error('样本文件为空'), { code: 'EMPTY_SAMPLE' })
    if (data.length > 60 * 1024 * 1024) throw Object.assign(new Error('样本文件超过 60MB 限制'), { code: 'SAMPLE_TOO_LARGE' })

    const dir = path.join(this.samplesRoot, profile.id)
    await ensureDir(path.join(dir, 'raw'))
    const sampleId = newId('s')
    const ext = filePath ? extensionOf(filePath, '.wav') : extensionOf(filename, '.wav')
    const rawName = `${sampleId}${ext}`
    const rawPath = path.join(dir, 'raw', rawName)
    await writeFile(rawPath, data)
    const wavPath = path.join(dir, `${sampleId}.wav`)
    try {
      await this.engine.decodeToWav(rawPath, wavPath, { sampleRate: 24000, channels: 1, signal })
    } catch (error) {
      await rm(rawPath, { force: true }).catch(() => {})
      throw Object.assign(new Error(`样本解码失败（支持 wav/mp3/m4a/flac/ogg）：${firstMeaningfulError(error.stderr, error.message)}`), {
        code: 'SAMPLE_DECODE_FAILED',
        stderr: error.stderr,
      })
    }
    let analysis
    try {
      analysis = await this.engine.analyze(wavPath, { signal, timeoutMs: 60000 })
    } catch (error) {
      await rm(wavPath, { force: true }).catch(() => {})
      await rm(rawPath, { force: true }).catch(() => {})
      throw error
    }

    const createdAt = nowIso()
    const makeSample = (id, wav, raw, info, name) => ({
      id,
      filename: safeFileName(name, `${id}.wav`),
      originalName: safeFileName(filename, `${id}${ext}`),
      duration: Number(info.duration || 0),
      quality: Number(info.quality || 0),
      f0: Number(info.f0 || 0),
      centroid: Number(info.centroid || 0),
      brightness: Number(info.brightness || 0),
      issues: Array.isArray(info.issues) ? info.issues : [],
      wavRel: path.relative(this.root, wav).replace(/\\/g, '/'),
      rawRel: path.relative(this.root, raw).replace(/\\/g, '/'),
      createdAt,
    })

    const added = []
    const shouldSlice = (slice || analysis.duration > 25) && analysis.duration > 3
    if (shouldSlice) {
      const sliceDir = path.join(dir, `${sampleId}-slices`)
      try {
        const result = await this.engine.slice(wavPath, sliceDir, { signal, timeoutMs: 120000 })
        for (const [index, item] of (result.slices || []).entries()) {
          const id = newId('s')
          const source = item.file
          const targetWav = path.join(dir, `${id}.wav`)
          await copyFile(source, targetWav)
          const targetRaw = path.join(dir, 'raw', `${id}.wav`)
          await copyFile(targetWav, targetRaw)
          added.push(makeSample(id, targetWav, targetRaw, item, `${filename.replace(/\.[^.]+$/, '')}-${String(index + 1).padStart(2, '0')}.wav`))
        }
        await rm(sliceDir, { recursive: true, force: true }).catch(() => {})
      } catch (error) {
        // Slicing failing must not lose the original sample.
        this.logger?.warn?.(`[dsh-voice-unified] sample slice failed: ${error.message}`)
        added.push(makeSample(sampleId, wavPath, rawPath, analysis, filename))
      }
    } else {
      added.push(makeSample(sampleId, wavPath, rawPath, analysis, filename))
    }

    profile.samples.push(...added)
    profile.needsRetrain = true
    profile.updatedAt = nowIso()
    this.store.touch()
    return { ok: true, profileId, samples: added, profile: this.summary(profile) }
  }

  async deleteSample(profileId, sampleId) {
    const profile = this.store.profile(profileId)
    if (!profile) throw Object.assign(new Error(`音色档案不存在：${profileId}`), { code: 'PROFILE_NOT_FOUND' })
    const sample = profile.samples.find((item) => item.id === sampleId)
    if (!sample) throw Object.assign(new Error(`样本不存在：${sampleId}`), { code: 'SAMPLE_NOT_FOUND' })
    profile.samples = profile.samples.filter((item) => item.id !== sampleId)
    if (sample.wavRel) await rm(path.join(this.root, sample.wavRel), { force: true }).catch(() => {})
    if (sample.rawRel) await rm(path.join(this.root, sample.rawRel), { force: true }).catch(() => {})
    profile.needsRetrain = true
    profile.updatedAt = nowIso()
    this.store.touch()
    return { ok: true, profile: this.summary(profile) }
  }

  async sliceSample(profileId, sampleId) {
    const profile = this.store.profile(profileId)
    if (!profile) throw Object.assign(new Error(`音色档案不存在：${profileId}`), { code: 'PROFILE_NOT_FOUND' })
    const sample = profile.samples.find((item) => item.id === sampleId)
    if (!sample) throw Object.assign(new Error(`样本不存在：${sampleId}`), { code: 'SAMPLE_NOT_FOUND' })
    const wavPath = path.join(this.root, sample.wavRel)
    const outdir = path.join(this.samplesRoot, profile.id, `${sampleId}-slices`)
    const result = await this.engine.slice(wavPath, outdir, { timeoutMs: 120000 })
    const dir = path.join(this.samplesRoot, profile.id)
    const added = []
    for (const [index, item] of (result.slices || []).entries()) {
      const id = newId('s')
      const targetWav = path.join(dir, `${id}.wav`)
      await copyFile(item.file, targetWav)
      const targetRaw = path.join(dir, 'raw', `${id}.wav`)
      await copyFile(targetWav, targetRaw)
      added.push({
        id,
        filename: `${sample.filename.replace(/\.[^.]+$/, '')}-slice-${String(index + 1).padStart(2, '0')}.wav`,
        originalName: sample.originalName,
        duration: Number(item.duration || 0),
        quality: Number(item.quality || 0),
        f0: Number(item.f0 || 0),
        centroid: Number(item.centroid || 0),
        brightness: Number(item.brightness || 0),
        issues: Array.isArray(item.issues) ? item.issues : [],
        wavRel: path.relative(this.root, targetWav).replace(/\\/g, '/'),
        rawRel: path.relative(this.root, targetRaw).replace(/\\/g, '/'),
        createdAt: nowIso(),
      })
    }
    await rm(outdir, { recursive: true, force: true }).catch(() => {})
    profile.samples.push(...added)
    profile.needsRetrain = true
    profile.updatedAt = nowIso()
    this.store.touch()
    return { ok: true, added, profile: this.summary(profile) }
  }

  async train(profileId, note = '') {
    const profile = this.store.profile(profileId)
    if (!profile) throw Object.assign(new Error(`音色档案不存在：${profileId}`), { code: 'PROFILE_NOT_FOUND' })
    if (profile.training?.status === 'training') {
      throw Object.assign(new Error('该音色正在训练中，请稍候'), { code: 'TRAINING_BUSY' })
    }
    if (!profile.samples.length) throw Object.assign(new Error('没有样本，无法训练。请先上传参考音频。'), { code: 'NO_SAMPLES' })
    const jobId = newId('train')
    profile.training = { jobId, status: 'training', progress: 5, startedAt: nowIso(), note: String(note || '').slice(0, 200), error: null }
    profile.needsRetrain = false
    this.store.touch()
    await this.store.saveNow()
    void this._runTraining(profile, jobId, note).catch((error) => {
      this.logger?.warn?.(`[dsh-voice-unified] training failed: ${error?.message || error}`)
    })
    return { ok: true, jobId, profile: this.summary(profile) }
  }

  async _baseFeatures(profile) {
    const key = profile.baseVoice || 'default'
    this._baseCache = this._baseCache || new Map()
    if (this._baseCache.has(key)) return this._baseCache.get(key)
    const fallback = { f0: BASE_F0[profile.baseVoice] || 220, centroid: BASE_CENTROID, brightness: 0.45 }
    try {
      const id = newId('base')
      const raw = path.join(this.tempRoot, `${id}-raw.wav`)
      const wav = path.join(this.tempRoot, `${id}.wav`)
      await this.engine.sapiTts({
        text: '你好，这是音色基准测量，用来校准音高与音色。',
        outWav: raw,
        voice: profile.baseVoice,
        rate: 0,
        volume: 90,
        pauseMs: 140,
      })
      await this.engine.decodeToWav(raw, wav, { sampleRate: 24000, channels: 1 })
      const analysis = await this.engine.analyze(wav, { timeoutMs: 60000 })
      const result = {
        f0: Number(analysis.f0) > 60 ? Number(analysis.f0) : fallback.f0,
        centroid: Number(analysis.centroid) > 200 ? Number(analysis.centroid) : fallback.centroid,
        brightness: Number.isFinite(Number(analysis.brightness)) ? Number(analysis.brightness) : fallback.brightness,
      }
      await rm(raw, { force: true }).catch(() => {})
      await rm(wav, { force: true }).catch(() => {})
      this._baseCache.set(key, result)
      return result
    } catch (error) {
      this.logger?.warn?.(`[dsh-voice-unified] base feature calibration failed: ${error.message}`)
      this._baseCache.set(key, fallback)
      return fallback
    }
  }

  async _runTraining(profile, jobId, note) {
    try {
      if (profile.training?.jobId !== jobId) return
      profile.training.progress = 15
      this.store.touch()
      await this.store.saveNow()

      const samples = profile.samples.filter((sample) => sample.duration > 0)
      if (!samples.length) throw new Error('样本都不可用，无法训练')
      const f0 = weightedAverage(samples, 'f0')
      const centroid = weightedAverage(samples, 'centroid')
      const brightness = weightedAverage(samples, 'brightness')
      const quality = samples.reduce((sum, sample) => sum + (Number(sample.quality) || 0), 0) / samples.length
      const base = await this._baseFeatures(profile)
      const baseF0 = base.f0
      const baseCentroid = base.centroid
      const n = samples.length
      const strength = clamp(0.36 + n * 0.16, 0.48, 0.96)
      const pitchSemitones = clamp(12 * Math.log2((f0 || baseF0) / baseF0), -8, 8)
      const formant = clamp(centroid > 0 ? centroid / baseCentroid : 1, 0.84, 1.4)
      const model = {
        pitchSemitones: Number(pitchSemitones.toFixed(3)),
        formant: Number(formant.toFixed(3)),
        brightness: Number(clamp(((centroid || baseCentroid) / baseCentroid - 1) * 0.55 + ((brightness || 0.45) - base.brightness) * 0.5, -0.35, 0.45).toFixed(3)),
        speed: 1,
        strength: Number(strength.toFixed(3)),
        vibrato: 0,
        quality: Number(quality.toFixed(1)),
        f0: Number((f0 || baseF0).toFixed(2)),
        centroid: Number((centroid || baseCentroid).toFixed(2)),
        sampleCount: n,
      }
      profile.training.progress = 48
      this.store.touch()
      await this.store.saveNow()

      const versionNumber = (profile.versions?.length || 0) + 1
      const versionId = `v${versionNumber}`
      const targetFile = path.join(this.tempRoot, `${profile.id}-${versionId}-features.json`)
      await writeFile(targetFile, JSON.stringify({
        f0: model.f0,
        centroid: model.centroid,
        brightness: model.brightness,
        quality: model.quality,
      }), 'utf8')

      // 训练出的模型是开环估计的（拿样本均值对基座均值），直接合成常差几个
      // 半音、几百 Hz 谱质心。这里做粗粒度网格校准：按"越自然越优先"的顺序
      // 试候选（温和的 formant/brightness 在前），达到 88 分就停，避免为了分数
      // 把音色推得又亮又薄。
      let best = null
      const text = '你好，这是音色训练后的试听。希望这个声音听起来自然、清晰，也更接近你心中的目标。'
      const candidates = []
      for (const pitchOffset of [0, -0.5, 0.5]) {
        for (const formantScale of [1.0, 1.1, 1.2]) {
          for (const brightnessStep of [0.1, 0.2, 0.3]) {
            candidates.push({
              ...model,
              pitchSemitones: clamp(Number(model.pitchSemitones) + pitchOffset, -8, 8),
              formant: clamp(Number(model.formant) * formantScale, 0.84, 1.6),
              brightness: clamp(Number(model.brightness) + brightnessStep, -0.35, 0.45),
            })
          }
        }
      }
      let attempt = 0
      for (const candidate of candidates) {
        attempt += 1
        try {
          const preview = await this._synthInternal({
            text,
            profile,
            modelOverride: candidate,
            emotion: 'tender',
            outputPrefix: `train-${profile.id}-${versionId}-it${attempt}`,
            outputDir: this.previewsRoot,
            keepWav: true,
          })
          const result = await this.engine.similarity(targetFile, preview.wavPath, { timeoutMs: 60000 })
          const similarity = Number(result.similarity || 0)
          if (!best || similarity > best.similarity) {
            best = { similarity, model: { ...candidate }, preview }
          }
        } catch (error) {
          this.logger?.warn?.(`[dsh-voice-unified] 训练校准第 ${attempt} 组失败：${error.message}`)
        }
        if (best && best.similarity >= 85) break
      }
      await rm(targetFile, { force: true }).catch(() => {})
      if (!best) throw new Error('训练校准未产生可用的试听')

      const preview = best.preview
      const similarity = best.similarity
      const tunedModel = best.model
      model.pitchSemitones = tunedModel.pitchSemitones
      model.formant = tunedModel.formant
      model.brightness = tunedModel.brightness

      const version = {
        id: versionId,
        label: `v${versionNumber}`,
        createdAt: nowIso(),
        sampleCount: n,
        sampleIds: samples.map((sample) => sample.id),
        status: 'ready',
        metrics: { similarity: Number(similarity.toFixed(1)), quality: model.quality, f0: model.f0, centroid: model.centroid },
        model,
        note: String(note || '').slice(0, 200),
        previewRel: path.relative(this.root, preview.audioPath).replace(/\\/g, '/'),
        previewWavRel: path.relative(this.root, preview.wavPath).replace(/\\/g, '/'),
        previewAudioUrl: relativeUrl(path.relative(this.root, preview.audioPath)),
      }
      profile.versions.push(version)
      profile.currentVersionId = version.id
      profile.lastTrainedAt = version.createdAt
      profile.training = { jobId, status: 'done', progress: 100, startedAt: profile.training.startedAt, finishedAt: nowIso(), error: null }
      profile.updatedAt = nowIso()
      profile.needsRetrain = false
      this.store.touch()
      await this.store.saveNow()
    } catch (error) {
      profile.training = {
        jobId,
        status: 'failed',
        progress: 0,
        startedAt: profile.training?.startedAt || nowIso(),
        finishedAt: nowIso(),
        error: error instanceof Error ? error.message : String(error),
      }
      this.store.state.lastError = { at: nowIso(), scope: 'training', message: profile.training.error }
      profile.updatedAt = nowIso()
      this.store.touch()
      await this.store.saveNow()
      throw error
    }
  }

  versions(profileId) {
    const profile = this.store.profile(profileId)
    if (!profile) throw Object.assign(new Error(`音色档案不存在：${profileId}`), { code: 'PROFILE_NOT_FOUND' })
    return (profile.versions || []).map((version) => ({
      ...version,
      previewAudioUrl: version.previewAudioUrl || (version.previewRel ? relativeUrl(version.previewRel) : ''),
      isCurrent: version.id === profile.currentVersionId,
    }))
  }

  rollback(profileId, versionId) {
    const profile = this.store.profile(profileId)
    if (!profile) throw Object.assign(new Error(`音色档案不存在：${profileId}`), { code: 'PROFILE_NOT_FOUND' })
    const version = profile.versions.find((item) => item.id === versionId)
    if (!version) throw Object.assign(new Error(`版本不存在：${versionId}`), { code: 'VERSION_NOT_FOUND' })
    profile.currentVersionId = version.id
    profile.updatedAt = nowIso()
    this.store.touch()
    return { ok: true, profile: this.summary(profile), version }
  }

  async preview(profileId, { text, emotion, versionId } = {}) {
    const profile = this.store.profile(profileId)
    if (!profile) throw Object.assign(new Error(`音色档案不存在：${profileId}`), { code: 'PROFILE_NOT_FOUND' })
    const version = versionId
      ? profile.versions.find((item) => item.id === versionId)
      : profile.versions.find((item) => item.id === profile.currentVersionId) || profile.versions.at(-1)
    if (versionId && !version) throw Object.assign(new Error(`版本不存在：${versionId}`), { code: 'VERSION_NOT_FOUND' })
    const result = await this._synthInternal({
      text: String(text || '你好，我是这个音色。很高兴用声音和你聊天。').slice(0, 300),
      profile,
      modelOverride: version?.model,
      emotion: emotion || 'tender',
      outputPrefix: `preview-${profile.id}`,
      outputDir: this.previewsRoot,
      keepWav: true,
    })
    let similarity = null
    if (version?.model) {
      const targetFile = path.join(this.tempRoot, `${profile.id}-${newId('sim')}.json`)
      await writeFile(targetFile, JSON.stringify({
        f0: version.model.f0 || version.metrics?.f0 || 0,
        centroid: version.model.centroid || version.metrics?.centroid || 0,
        brightness: version.model.brightness || 0,
        quality: version.model.quality || 0,
      }), 'utf8')
      try {
        const sim = await this.engine.similarity(targetFile, result.wavPath, { timeoutMs: 60000 })
        similarity = sim.similarity
      } catch { /* preview remains usable */ } finally {
        await rm(targetFile, { force: true }).catch(() => {})
      }
    }
    const record = {
      id: result.id,
      profileId,
      versionId: version?.id || profile.currentVersionId,
      text: String(text || '').slice(0, 300),
      emotion: result.emotionKey,
      audioRel: path.relative(this.root, result.audioPath).replace(/\\/g, '/'),
      audioUrl: result.audioUrl,
      duration: result.duration,
      similarity,
      createdAt: nowIso(),
    }
    profile.previews.push(record)
    profile.previews = profile.previews.slice(-50)
    this.store.touch()
    return { ok: true, ...record }
  }

  async _synthInternal({
    text,
    profile,
    modelOverride,
    emotion,
    outputPrefix,
    outputDir,
    keepWav = false,
    settings = this.store.state.settings,
    sessionId,
    signal,
  }) {
    const clean = String(text || '').replace(/\u0000/g, '').trim()
    if (!clean) throw Object.assign(new Error('语音文本不能为空'), { code: 'EMPTY_TEXT' })
    if (profile.kind === 'cloned' && !modelOverride && !profile.currentVersionId) {
      throw Object.assign(new Error(`音色「${profile.name}」尚未训练，请先上传样本并点击训练。`), { code: 'NOT_TRAINED' })
    }
    const model = modelOverride || profile.versions.find((version) => version.id === profile.currentVersionId)?.model || profile.model || {
      pitchSemitones: 0, formant: 1, brightness: 0, speed: 1, strength: 0.6, vibrato: 0,
    }
    const emotionState = analyzeEmotion(clean, {
      previous: sessionId ? this.store.state.emotionStates[sessionId] : null,
      crossTurn: settings.crossTurnEmotion,
      defaultEmotion: settings.defaultEmotion,
      intensity: settings.emotionIntensity,
    })
    const resolvedEmotion = normalizeEmotion(emotion) || emotionState.emotion
    const prosody = emotionParams(resolvedEmotion, settings.emotionIntensity)
    if (sessionId) {
      this.store.state.emotionStates[sessionId] = {
        emotion: resolvedEmotion,
        intensity: prosody.energy,
        updatedAt: Date.now(),
      }
    }

    const id = newId(outputPrefix.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 18) || 'voice')
    const runDir = path.join(outputDir, id)
    await ensureDir(runDir)
    const rawWav = path.join(runDir, 'raw.wav')
    const convertedWav = path.join(runDir, 'voice.wav')
    const ext = settings.replyFormat === 'wav' ? 'wav' : 'mp3'
    const audioPath = path.join(runDir, `${id}.${ext}`)

    const speed = clamp((Number(settings.speed) || 1) * prosody.rate, 0.72, 1.35)
    const sapiRate = Math.round((speed - 1) * 10)
    const volume = Math.round(clamp(Number(settings.volume) || 1, 0, 1.5) * 100)
    await this.engine.sapiTts({
      text: clean.slice(0, 1200),
      outWav: rawWav,
      voice: profile.baseVoice,
      rate: sapiRate,
      volume,
      pauseMs: prosody.pauseMs,
      signal,
    })

    const params = {
      pitchSemitones: clamp((Number(model.pitchSemitones) || 0) + prosody.pitch, -12, 12),
      formant: clamp(Number(model.formant) || 1, 0.8, 1.6),
      brightness: clamp((Number(model.brightness) || 0) + prosody.brightness, -0.5, 0.5),
      strength: clamp(Number(model.strength ?? 1), 0, 1),
      speed,
      vibrato: clamp(Number(model.vibrato || 0) + prosody.vibrato, 0, 0.3),
      tremolo: 0,
    }
    await this.engine.convert(rawWav, convertedWav, params, { signal, timeoutMs: 180000 })
    await this.engine.encodeAudio(convertedWav, audioPath, { format: ext, signal })
    const duration = await this.engine.duration(audioPath)
    const meta = {
      id,
      profileId: profile.id,
      profileName: profile.name,
      emotion: resolvedEmotion,
      emotionLabel: EMOTIONS[resolvedEmotion]?.zh || '平静',
      text: clean.slice(0, 1200),
      params,
      duration,
      createdAt: nowIso(),
      audioRel: path.relative(this.root, audioPath).replace(/\\/g, '/'),
      audioUrl: relativeUrl(path.relative(this.root, audioPath)),
    }
    await writeFile(path.join(runDir, `${id}.json`), JSON.stringify(meta, null, 2), 'utf8')
    if (!keepWav) {
      await rm(rawWav, { force: true }).catch(() => {})
      await rm(convertedWav, { force: true }).catch(() => {})
    }
    return {
      ...meta,
      wavPath: convertedWav,
      rawWav,
      audioPath,
      duration,
      emotionKey: resolvedEmotion,
      params,
    }
  }

  async speak({
    text,
    profileId,
    emotion,
    sessionId,
    deliver = false,
    title = '语音回复',
    turn,
    step,
    signal,
  } = {}) {
    const profile = this.resolveProfile(profileId)
    const result = await this._synthInternal({
      text,
      profile,
      emotion,
      outputPrefix: 'reply',
      outputDir: this.repliesRoot,
      sessionId,
      signal,
    })
    let delivered = null
    if (deliver) {
      delivered = this.delivery.deliver({
        sessionId,
        audioUrl: result.audioUrl,
        downloadUrl: `${result.audioUrl}?download=1`,
        title,
        duration: result.duration,
        profileName: profile.name,
        emotion: result.emotionLabel,
        autoplay: this.store.state.settings.autoplay,
        kind: 'reply',
        turn,
        step,
      })
    }
    this.store.state.lastReply = {
      at: nowIso(),
      profileId: profile.id,
      emotion: result.emotionKey,
      duration: result.duration,
      audioUrl: result.audioUrl,
      delivered,
    }
    this.store.touch()
    return { ok: true, ...result, delivered }
  }

  autoReplyText(sessionId, turn) {
    const session = this.ctxSession(sessionId)
    if (!session) return ''
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      const event = session.events[index]
      if (event.type !== 'assistant/message') continue
      if (turn !== undefined && event.data?.turn !== turn) continue
      const blocks = event.data?.message?.content || []
      const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('')
      if (!text.trim()) continue
      if (text.trim().startsWith('```dsh-voice')) continue
      return text
    }
    return ''
  }

  ctxSession(sessionId) {
    return this.delivery?.ctx?.sessions?.get?.(sessionId) || null
  }
}
