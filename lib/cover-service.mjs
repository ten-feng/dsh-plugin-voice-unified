/** Asynchronous cover pipeline: separate -> convert -> mix -> encode -> deliver. */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  clamp,
  ensureDir,
  firstMeaningfulError,
  newId,
  nowIso,
  relativeUrl,
  safeFileName,
} from './util.mjs'

function ts() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

function appendLog(job, line) {
  job.logs = [...(job.logs || []), `[${ts()}] ${line}`].slice(-200)
  job.updatedAt = nowIso()
}

export class CoverService {
  constructor({ store, engine, voice, musicCache, delivery, logger } = {}) {
    this.store = store
    this.engine = engine
    this.voice = voice
    this.musicCache = musicCache
    this.delivery = delivery
    this.logger = logger
    this.root = store.root
    this.coversRoot = path.join(this.root, 'audio', 'covers')
    this.queue = []
    this.running = false
    this.activeId = null
  }

  async init() {
    await ensureDir(this.coversRoot)
    const queued = this.store.state.covers.filter((job) => job.status === 'queued').map((job) => job.id)
    this.queue = queued
    if (queued.length) setImmediate(() => this.processNext())
    return this
  }

  list(limit = 30) {
    return [...this.store.state.covers]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 30)))
  }

  get(id) {
    return this.store.state.covers.find((job) => job.id === id) || null
  }

  publicJob(job) {
    if (!job) return null
    return {
      ...job,
      downloadUrl: job.output?.mp3 ? `${job.output.mp3}?download=1` : '',
      previewAudioUrl: job.previewUrl || '',
    }
  }

  async enqueue(input = {}) {
    const songName = String(input.songName || '').trim()
    const sourcePath = input.sourcePath ? path.resolve(String(input.sourcePath)) : ''
    const sourceUrl = input.sourceUrl ? String(input.sourceUrl) : ''
    if (!sourcePath && !sourceUrl && !songName) {
      throw Object.assign(new Error('请选择音乐缓存文件、提供音频 URL，或上传本地音频后再翻唱。'), { code: 'NO_SOURCE' })
    }
    if (sourcePath) {
      const { existsSync } = await import('node:fs')
      if (!existsSync(sourcePath)) {
        throw Object.assign(new Error(`找不到原唱文件：${sourcePath}`), { code: 'SOURCE_NOT_FOUND' })
      }
    } else if (!sourceUrl) {
      const found = this.musicCache.findByName(songName)
      if (!found) {
        if (!this.store.state.musicCache?.entries?.length) {
          throw Object.assign(new Error('未找到音乐缓存文件。请先在音乐插件中缓存歌曲，或在翻唱页手动选择本地音频。'), { code: 'NO_CACHE_FILE' })
        }
        throw Object.assign(new Error(`未找到名为「${songName}」的音乐缓存。请先缓存这首歌，或在翻唱页手动选择本地音频。`), { code: 'CACHE_NOT_FOUND' })
      }
    }
    const startTime = Number.isFinite(Number(input.startTime)) ? Math.max(0, Number(input.startTime)) : null
    const endTime = Number.isFinite(Number(input.endTime)) ? Math.max(0, Number(input.endTime)) : null
    if (endTime != null && endTime <= (startTime ?? 0) + 0.1) {
      throw Object.assign(new Error('end_time 必须大于 start_time，并至少保留 0.1 秒'), { code: 'BAD_SEGMENT' })
    }
    const id = newId('c')
    const job = {
      id,
      songName: songName || '未命名翻唱',
      transcript: String(input.transcript || input.lyrics || '').slice(0, 4000),
      startTime,
      endTime,
      sourcePath,
      sourceUrl,
      profileId: input.profileId || this.store.state.defaultProfileId,
      profileName: '',
      sessionId: input.sessionId || this.store.state.lastSessionId || '',
      /** 额外升降调（半音）：负数让原唱声线更低，和原唱拉开距离。 */
      pitchOffset: Number.isFinite(Number(input.pitchOffset)) ? Math.max(-6, Math.min(6, Number(input.pitchOffset))) : 0,
      deliver: input.deliver !== false,
      format: input.format === 'wav' ? 'wav' : 'mp3',
      status: 'queued',
      stage: 'queued',
      progress: 0,
      logs: [],
      error: null,
      output: null,
      previewUrl: '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      retryOf: input.retryOf || '',
    }
    const profile = this.store.profile(job.profileId)
    if (!profile) {
      throw Object.assign(new Error('请选择一个已训练的音色再翻唱'), { code: 'NO_PROFILE' })
    }
    if (profile.status !== 'active') {
      throw Object.assign(new Error(`音色「${profile.name}」已停用`), { code: 'PROFILE_DISABLED' })
    }
    job.profileName = profile.name
    appendLog(job, `任务已创建：${job.songName}，音色「${profile.name}」，${job.deliver ? '完成后直出语音回复' : '仅导出文件'}`)
    this.store.state.covers.unshift(job)
    this.store.state.covers = this.store.state.covers.slice(0, 100)
    this.queue.push(id)
    this.store.touch()
    await this.store.saveNow()
    setImmediate(() => this.processNext())
    return { ok: true, job: this.publicJob(job) }
  }

  async retry(id) {
    const old = this.get(id)
    if (!old) throw Object.assign(new Error(`翻唱任务不存在：${id}`), { code: 'JOB_NOT_FOUND' })
    return this.enqueue({
      songName: old.songName,
      sourcePath: old.sourcePath,
      sourceUrl: old.sourceUrl,
      profileId: old.profileId,
      sessionId: old.sessionId,
      deliver: old.deliver,
      format: old.format,
      transcript: old.transcript,
      startTime: old.startTime,
      endTime: old.endTime,
      retryOf: old.id,
    })
  }

  async export(id, { format, destPath } = {}) {
    const job = this.get(id)
    if (!job) throw Object.assign(new Error(`翻唱任务不存在：${id}`), { code: 'JOB_NOT_FOUND' })
    if (job.status !== 'done' || !job.output) throw Object.assign(new Error('任务尚未完成，无法导出'), { code: 'JOB_NOT_DONE' })
    const wanted = format === 'wav' ? 'wav' : 'mp3'
    const rel = job.output[wanted] || job.output.mp3 || job.output.wav
    if (!rel) throw Object.assign(new Error('没有可导出的成品文件'), { code: 'NO_OUTPUT' })
    const rootRelative = rel.replace(/^\/plugins\/dsh-voice-unified\/api\/(?:file|audio)\//, '')
    const source = path.join(this.root, rootRelative)
    if (!destPath) return { ok: true, path: source, format: wanted, downloadUrl: `${relativeUrl(path.relative(this.root, source))}?download=1` }
    const target = path.resolve(String(destPath))
    if (!/\.(mp3|wav)$/i.test(target)) throw Object.assign(new Error('导出路径必须以 .mp3 或 .wav 结尾'), { code: 'BAD_EXPORT_PATH' })
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(source, target)
    return { ok: true, path: target, format: wanted }
  }

  async processNext() {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length) {
        const id = this.queue.shift()
        const job = this.get(id)
        if (!job || job.status !== 'queued') continue
        this.activeId = id
        await this._run(job)
        this.activeId = null
      }
    } finally {
      this.running = false
      this.activeId = null
    }
  }

  async _run(job) {
    const workDir = path.join(this.coversRoot, job.id)
    try {
      job.status = 'running'
      job.stage = 'preparing'
      job.startedAt = nowIso()
      job.progress = 2
      appendLog(job, '开始处理')
      this.store.touch()
      await this.store.saveNow()
      await ensureDir(workDir)

      const profile = this.store.profile(job.profileId)
      if (!profile) throw new Error('音色档案已不存在')
      if (profile.status !== 'active') throw new Error(`音色「${profile.name}」已停用`)
      const model = profile.versions.find((version) => version.id === profile.currentVersionId)?.model || profile.model
      if (!model) throw new Error('音色尚未训练，请先训练音色')
      // The built-in warm voice is intentionally close to the SAPI base voice;
      // for covers that makes the result sound like the original singer. Give
      // built-in covers a clearly audible timbre shift while leaving trained
      // clone models faithful to their target.
      const coverModel = { ...model }
      if (profile.kind === 'builtin' && profile.id === 'p_builtin_warm') {
        coverModel.pitchSemitones = clamp((Number(model.pitchSemitones) || 0) + 2.2, -8, 8)
        coverModel.formant = clamp((Number(model.formant) || 1) * 1.06, 0.84, 1.18)
        coverModel.brightness = clamp((Number(model.brightness) || 0) + 0.08, -0.3, 0.3)
        coverModel.strength = 1
      } else {
        coverModel.strength = Math.max(0.9, Number(model.strength) || 0.9)
      }
      if (Number(job.pitchOffset)) {
        coverModel.pitchSemitones = clamp(
          (Number(coverModel.pitchSemitones) || 0) + Number(job.pitchOffset), -8, 8,
        )
        appendLog(job, `额外降调 ${Number(job.pitchOffset).toFixed(1)} 半音（让原唱声线更低）`)
      }

      const source = await this.musicCache.resolveSource({
        sourcePath: job.sourcePath,
        sourceUrl: job.sourceUrl,
        songName: job.songName,
      })
      job.sourcePath = source.path
      appendLog(job, `原唱来源：${source.from} · ${path.basename(source.path)}`)
      job.progress = 8
      this.store.touch()

      const sourceWav = path.join(workDir, 'source.wav')
      await this.engine.decodeToWav(source.path, sourceWav, { sampleRate: 44100, channels: 2 })
      let separationSource = sourceWav
      if (Number.isFinite(job.startTime) && Number.isFinite(job.endTime) && job.endTime > job.startTime + 0.1) {
        const segmentWav = path.join(workDir, 'segment.wav')
        await this.engine.trimSegment(sourceWav, segmentWav, job.startTime, job.endTime)
        separationSource = segmentWav
        appendLog(job, `按整句边界截取 ${job.startTime.toFixed(2)}s – ${job.endTime.toFixed(2)}s，不在字中间截断`)
      } else if (job.transcript || job.startTime != null || job.endTime != null) {
        appendLog(job, '未提供完整的 start_time/end_time；将使用输入源的原有时长')
      }
      job.stage = 'separating'
      job.progress = 18
      appendLog(job, '人声分离：提取中置人声与左右声道伴奏（伴奏侧加算人声残留抵消，避免还能听到原唱）')
      this.store.touch()
      await this.store.saveNow()

      const vocalWav = path.join(workDir, 'vocal.wav')
      const instrumentalWav = path.join(workDir, 'instrumental.wav')
      await this.engine.separate(separationSource, vocalWav, instrumentalWav, { timeoutMs: 10 * 60 * 1000, vocalSuppress: 0.5 })
      const sourceDuration = await this.engine.duration(separationSource)
      job.sourceDuration = sourceDuration
      appendLog(job, `分离完成，原唱时长 ${sourceDuration.toFixed(1)} 秒`)
      job.progress = 34
      this.store.touch()

      job.stage = 'converting'
      appendLog(job, `音色转换：${profile.name}（强度 ${Number(coverModel.strength || 1).toFixed(2)}，变调 ${Number(coverModel.pitchSemitones || 0).toFixed(1)} 半音）`)
      job.progress = 42
      this.store.touch()
      await this.store.saveNow()
      const convertedVocal = path.join(workDir, 'vocal-converted.wav')
      await this.engine.convert(vocalWav, convertedVocal, {
        pitchSemitones: clamp(Number(coverModel.pitchSemitones) || 0, -8, 8),
        formant: clamp(Number(coverModel.formant) || 1, 0.84, 1.4),
        brightness: clamp(Number(coverModel.brightness) || 0, -0.35, 0.45),
        strength: clamp(Number(coverModel.strength ?? 1), 0.3, 1),
        speed: 1,
        vibrato: clamp(Number(coverModel.vibrato || 0) + 0.06, 0, 0.2),
        tremolo: 0.02,
      }, { timeoutMs: 8 * 60 * 1000 })
      job.progress = 66
      appendLog(job, '换声完成，开始混音')
      this.store.touch()

      job.stage = 'mixing'
      const mixedWav = path.join(workDir, 'mixed.wav')
      await this.engine.mix(convertedVocal, instrumentalWav, mixedWav, {
        vocalGain: 1.25,
        instGain: 1.35,
      })
      job.progress = 80
      this.store.touch()

      job.stage = 'encoding'
      const finalMp3 = path.join(workDir, 'cover.mp3')
      const finalWav = path.join(workDir, 'cover.wav')
      await this.engine.encodeAudio(mixedWav, finalMp3, { format: 'mp3', bitrate: '192k' })
      await this.engine.encodeAudio(mixedWav, finalWav, { format: 'wav' })
      job.progress = 90
      appendLog(job, '成品编码完成：cover.mp3 / cover.wav')

      const previewFile = path.join(workDir, 'preview.mp3')
      await this.engine.encodeAudio(finalMp3, previewFile, { format: 'mp3', bitrate: '160k', duration: 20 })
      const duration = await this.engine.duration(finalMp3)
      const mp3Rel = path.join('audio', 'covers', job.id, 'cover.mp3').replace(/\\/g, '/')
      const wavRel = path.join('audio', 'covers', job.id, 'cover.wav').replace(/\\/g, '/')
      const info = await (await import('node:fs/promises')).stat(finalMp3).catch(() => null)
      job.output = {
        mp3: relativeUrl(mp3Rel),
        wav: relativeUrl(wavRel),
        filePath: finalMp3,
        wavPath: finalWav,
        duration: Number(duration.toFixed(2)),
        size: info?.size || 0,
      }
      job.previewUrl = relativeUrl(path.join('audio', 'covers', job.id, 'preview.mp3'))
      job.progress = 95
      job.stage = 'delivering'
      this.store.touch()
      await this.store.saveNow()

      if (job.deliver) {
        appendLog(job, '生成语音播放器')
        const delivered = this.delivery.deliver({
          sessionId: job.sessionId,
          audioUrl: job.output.mp3,
          downloadUrl: `${job.output.mp3}?download=1`,
          title: `翻唱 · ${job.songName}`,
          duration: job.output.duration,
          profileName: profile.name,
          emotion: '演唱',
          autoplay: this.store.state.settings.autoplay,
          kind: 'cover',
        })
        job.delivery = delivered
        if (!delivered.ok) {
          job.deliveryError = delivered.error
          appendLog(job, `直出失败：${delivered.error}`)
        } else if (delivered.mode === 'session') {
          appendLog(job, `已写入会话 ${delivered.sessionId}`)
        } else {
          // 围栏优先：工具结果里带回 ```dsh-voice 代码块，由模型原样写进回复，
          // 客户端负责渲染成播放器。绝不在这里伪造 turn 写日志。
          appendLog(job, '播放器围栏已就绪，随 voice.cover.status 返回')
        }
      } else {
        appendLog(job, '已关闭直出，仅保留导出文件')
      }

      job.status = 'done'
      job.stage = 'done'
      job.progress = 100
      job.finishedAt = nowIso()
      appendLog(job, '任务完成')
      this.store.touch()
      await this.store.saveNow()
      await rm(sourceWav, { force: true }).catch(() => {})
      await rm(vocalWav, { force: true }).catch(() => {})
      await rm(instrumentalWav, { force: true }).catch(() => {})
      await rm(convertedVocal, { force: true }).catch(() => {})
      await rm(mixedWav, { force: true }).catch(() => {})
    } catch (error) {
      job.status = 'failed'
      job.stage = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      job.detail = firstMeaningfulError(error?.stderr, '')
      job.finishedAt = nowIso()
      appendLog(job, `失败：${job.error}`)
      this.store.state.lastError = { at: nowIso(), scope: 'cover', message: job.error }
      this.store.touch()
      await this.store.saveNow()
      this.logger?.warn?.(`[dsh-voice-unified] cover ${job.id} failed: ${job.error}`)
    }
  }
}
