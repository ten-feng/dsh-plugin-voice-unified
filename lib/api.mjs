/** HTTP API for the management UI and music bridge. */
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { newId, toErrorPayload } from './util.mjs'

const API_ROUTE = '/plugins/dsh-voice-unified/api'
const MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
  '.json': 'application/json; charset=utf-8',
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendError(res, error, status = 400) {
  sendJson(res, status, toErrorPayload(error))
}

async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' })
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_JSON' })
  }
}

function decodeBase64(data) {
  const text = String(data || '')
  if (!text) throw Object.assign(new Error('缺少音频数据'), { code: 'EMPTY_UPLOAD' })
  const buffer = Buffer.from(text, 'base64')
  if (!buffer.length) throw Object.assign(new Error('音频数据为空'), { code: 'EMPTY_UPLOAD' })
  return buffer
}

function safeJoin(root, rel) {
  const target = path.resolve(root, rel)
  const prefix = path.resolve(root) + path.sep
  if (target !== path.resolve(root) && !target.startsWith(prefix)) return null
  return target
}

async function serveAudio(req, res, root, rel, query) {
  const target = safeJoin(root, rel)
  if (!target) return sendJson(res, 403, { ok: false, code: 'FORBIDDEN', error: '非法音频路径' })
  let info
  try {
    info = await stat(target)
  } catch {
    return sendJson(res, 404, { ok: false, code: 'AUDIO_NOT_FOUND', error: '音频文件不存在' })
  }
  if (!info.isFile()) return sendJson(res, 404, { ok: false, code: 'AUDIO_NOT_FOUND', error: '不是音频文件' })
  const ext = path.extname(target).toLowerCase()
  const type = MIME[ext] || 'application/octet-stream'
  const range = req.headers.range
  const download = query.get('download') === '1'
  const disposition = download ? `attachment; filename="${encodeURIComponent(path.basename(target))}"` : 'inline'
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range)
    if (match) {
      let start = match[1] ? Number(match[1]) : 0
      let end = match[2] ? Number(match[2]) : info.size - 1
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= info.size) {
        res.writeHead(416, { 'content-range': `bytes */${info.size}` })
        res.end()
        return
      }
      end = Math.min(end, info.size - 1)
      res.writeHead(206, {
        'content-type': type,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${info.size}`,
        'accept-ranges': 'bytes',
        'content-disposition': disposition,
        'cache-control': 'private, max-age=3600',
      })
      createReadStream(target, { start, end }).pipe(res)
      return
    }
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    'accept-ranges': 'bytes',
    'content-disposition': disposition,
    'cache-control': 'private, max-age=3600',
  })
  createReadStream(target).pipe(res)
}

function rootRelativeFromAudioUrl(audioUrl) {
  const raw = String(audioUrl || '')
  const match = raw.match(/\/plugins\/dsh-voice-unified\/api\/(?:file|audio)\/(.+?)(?:\?|$)/)
  if (!match) return ''
  try {
    return match[1].split('/').map((part) => decodeURIComponent(part)).join('/')
  } catch {
    return match[1]
  }
}

async function readStoredTranscript(store, covers, rootRel) {
  if (!rootRel) return ''
  const ext = path.extname(rootRel)
  const base = path.join(store.root, rootRel.slice(0, -ext.length))
  try {
    const meta = JSON.parse(await readFile(`${base}.json`, 'utf8'))
    if (meta && typeof meta.text === 'string' && meta.text.trim()) return meta.text.trim()
    if (meta && typeof meta.transcript === 'string' && meta.transcript.trim()) return meta.transcript.trim()
  } catch {
    /* no sidecar */
  }
  if (rootRel.includes('/covers/')) {
    const jobId = path.basename(path.dirname(rootRel))
    const job = covers?.get?.(jobId)
    const text = job?.transcript || job?.lyrics || ''
    if (typeof text === 'string' && text.trim()) return text.trim()
  }
  return ''
}

export function createApi({ store, engine, voice, covers, musicCache, delivery, logger, getOrigin }) {
  async function health() {
    const status = await engine.status()
    const defaultProfile = store.defaultProfile()
    return {
      ok: true,
      platform: process.platform,
      ttsEngine: status.tts,
      ffmpeg: status.ffmpeg,
      engine: status,
      defaultProfileId: store.state.defaultProfileId,
      defaultProfile: defaultProfile ? voice.summary(defaultProfile) : null,
      autoReply: store.state.settings.autoReply,
      intentReply: store.state.settings.intentReply,
      activeJobs: covers.list(100).filter((job) => job.status === 'queued' || job.status === 'running').length,
      profiles: store.state.profiles.length,
      cacheEntries: store.state.musicCache?.entries?.length || 0,
      lastError: store.state.lastError,
    }
  }

  async function handle(req, res) {
    let url
    try {
      url = new URL(req.url || '/', 'http://x')
    } catch {
      return sendError(res, new Error('非法 URL'), 400)
    }
    const pathname = url.pathname
    if (!pathname.startsWith(`${API_ROUTE}/`) && pathname !== API_ROUTE) {
      return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: 'not found' })
    }
    const endpoint = pathname.slice(API_ROUTE.length).replace(/^\/+/, '')
    const segments = endpoint.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment))
    const query = url.searchParams
    const method = req.method || 'GET'

    try {
      if (!segments.length && method === 'GET') return sendJson(res, 200, await health())

      if (segments[0] === 'health' && method === 'GET') return sendJson(res, 200, await health())

      if (segments[0] === 'status' && method === 'GET') {
        const defaultProfile = store.defaultProfile()
        return sendJson(res, 200, {
          ok: true,
          defaultProfile: defaultProfile ? voice.summary(defaultProfile) : null,
          profiles: store.state.profiles.length,
          samples: store.state.profiles.reduce((sum, profile) => sum + (profile.samples?.length || 0), 0),
          lastTrainedAt: store.state.profiles.map((profile) => profile.lastTrainedAt).filter(Boolean).sort().at(-1) || null,
          engine: await engine.status(),
          activeJobs: covers.list(100).filter((job) => job.status === 'queued' || job.status === 'running'),
          lastError: store.state.lastError,
          cache: { entries: store.state.musicCache?.entries?.length || 0, directories: store.state.musicCache?.directories || [] },
        })
      }

      /* ---- speech to text (right-click on a voice player) ---- */
      if (segments[0] === 'transcribe' && method === 'POST') {
        const body = await readBody(req)
        const rootRel = rootRelativeFromAudioUrl(body.audioUrl || body.audio)
        if (!rootRel) return sendJson(res, 400, { ok: false, code: 'BAD_AUDIO_URL', error: '缺少有效的音频地址' })
        const target = safeJoin(store.root, rootRel)
        if (!target) return sendJson(res, 403, { ok: false, code: 'FORBIDDEN', error: '非法音频路径' })
        const stored = await readStoredTranscript(store, covers, rootRel)
        if (stored) return sendJson(res, 200, { ok: true, text: stored, source: 'stored' })
        const wav = path.join(store.root, 'temp', `${newId('asr')}.wav`)
        try {
          await engine.decodeToWav(target, wav, { sampleRate: 16000, channels: 1 })
          const text = await engine.sapiAsr(wav)
          return sendJson(res, 200, {
            ok: true,
            text,
            source: 'asr',
            warning: text ? '本地识别结果，可能不完全准确。' : '本地识别没有返回文字；该音频可能没有清晰人声。',
          })
        } catch (error) {
          return sendJson(res, 422, {
            ok: false,
            code: error.code || 'ASR_FAILED',
            error: `转文字失败：${error.message}`,
          })
        } finally {
          const { rm } = await import('node:fs/promises')
          await rm(wav, { force: true }).catch(() => {})
        }
      }

      /* ---- audio (root-relative path below /file; /audio kept as alias) ---- */
      if ((segments[0] === 'audio' || segments[0] === 'file') && method === 'GET') {
        const rel = segments.slice(1).join('/')
        return serveAudio(req, res, store.root, rel, query)
      }

      /* ---- profiles ---- */
      if (segments[0] === 'profiles') {
        if (segments.length === 1 && method === 'GET') {
          return sendJson(res, 200, { ok: true, defaultProfileId: store.state.defaultProfileId, profiles: voice.list() })
        }
        if (segments.length === 1 && method === 'POST') {
          const body = await readBody(req)
          const profile = voice.createProfile(body)
          return sendJson(res, 200, { ok: true, profile: voice.detail(profile.id) })
        }
        const id = segments[1]
        if (!id) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: '缺少音色 id' })
        if (segments.length === 2 && method === 'GET') return sendJson(res, 200, { ok: true, profile: voice.detail(id) })
        if (segments.length === 2 && method === 'PATCH') {
          const body = await readBody(req)
          return sendJson(res, 200, { ok: true, profile: voice.updateProfile(id, body) })
        }
        if (segments.length === 2 && method === 'DELETE') {
          return sendJson(res, 200, await voice.deleteProfile(id))
        }
        if (segments[2] === 'default' && method === 'POST') {
          return sendJson(res, 200, voice.setDefault(id))
        }
        if (segments[2] === 'versions' && method === 'GET') {
          return sendJson(res, 200, { ok: true, versions: voice.versions(id) })
        }
        if (segments[2] === 'rollback' && method === 'POST') {
          const body = await readBody(req)
          return sendJson(res, 200, voice.rollback(id, body.versionId))
        }
        if (segments[2] === 'train' && method === 'POST') {
          const body = await readBody(req)
          return sendJson(res, 200, await voice.train(id, body.note))
        }
        if (segments[2] === 'preview' && method === 'POST') {
          const body = await readBody(req)
          return sendJson(res, 200, await voice.preview(id, body))
        }
        if (segments[2] === 'samples' && segments.length === 3 && method === 'POST') {
          const body = await readBody(req)
          const buffer = decodeBase64(body.dataBase64)
          const result = await voice.addSample(id, {
            buffer,
            filename: body.filename || 'sample.wav',
            slice: Boolean(body.slice),
          })
          return sendJson(res, 200, result)
        }
        if (segments[2] === 'samples' && segments.length === 5 && segments[4] === 'delete' && method === 'POST') {
          return sendJson(res, 200, await voice.deleteSample(id, segments[3]))
        }
        if (segments[2] === 'samples' && segments.length === 5 && segments[4] === 'slice' && method === 'POST') {
          return sendJson(res, 200, await voice.sliceSample(id, segments[3]))
        }
        return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: `未知音色接口：${endpoint}` })
      }

      /* ---- settings ---- */
      if (segments[0] === 'settings') {
        if (method === 'GET') return sendJson(res, 200, { ok: true, settings: voice.settingsView() })
        if (method === 'PATCH' || method === 'POST') {
          const body = await readBody(req)
          return sendJson(res, 200, { ok: true, settings: voice.updateSettings(body) })
        }
      }

      if (segments[0] === 'emotion' && segments[1] === 'reset' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        return sendJson(res, 200, voice.resetEmotion(body.sessionId))
      }

      if (segments[0] === 'synthesize' && method === 'POST') {
        const body = await readBody(req)
        const result = await voice.speak({
          text: body.text,
          profileId: body.profileId,
          emotion: body.emotion,
          sessionId: body.sessionId,
          deliver: Boolean(body.deliver),
          title: body.title,
        })
        return sendJson(res, 200, result)
      }

      /* ---- covers ---- */
      if (segments[0] === 'cover') {
        if (segments[1] === 'jobs' && segments.length === 2 && method === 'GET') {
          return sendJson(res, 200, { ok: true, jobs: covers.list(query.get('limit') || 30).map((job) => covers.publicJob(job)) })
        }
        if (segments[1] === 'jobs' && segments.length === 3 && method === 'GET') {
          const job = covers.get(segments[2])
          if (!job) return sendJson(res, 404, { ok: false, code: 'JOB_NOT_FOUND', error: '任务不存在' })
          return sendJson(res, 200, { ok: true, job: covers.publicJob(job) })
        }
        if (segments[1] === 'jobs' && segments.length === 4 && segments[3] === 'retry' && method === 'POST') {
          return sendJson(res, 200, await covers.retry(segments[2]))
        }
        if (segments[1] === 'jobs' && segments.length === 4 && segments[3] === 'export' && method === 'POST') {
          const body = await readBody(req)
          return sendJson(res, 200, await covers.export(segments[2], body))
        }
        if (segments[1] === 'upload' && method === 'POST') {
          const body = await readBody(req)
          const buffer = decodeBase64(body.dataBase64)
          const ext = path.extname(String(body.filename || '')).toLowerCase() || '.mp3'
          const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
          const file = path.join(store.root, 'cache', filename)
          const { ensureDir } = await import('./util.mjs')
          await ensureDir(path.dirname(file))
          const { writeFile } = await import('node:fs/promises')
          await writeFile(file, buffer)
          return sendJson(res, 200, { ok: true, path: file, songName: body.songName || body.filename || '本地音频' })
        }
        if (segments[1] === 'run' && method === 'POST') {
          const body = await readBody(req)
          const result = await covers.enqueue({
            sourcePath: body.sourcePath,
            sourceUrl: body.sourceUrl,
            songName: body.songName,
            profileId: body.profileId,
            sessionId: body.sessionId || store.state.lastSessionId,
            deliver: body.deliver !== false,
            format: body.format,
            transcript: body.transcript || body.lyrics,
            startTime: body.startTime ?? body.start_time,
            endTime: body.endTime ?? body.end_time,
            mode: body.mode,
          })
          return sendJson(res, 200, result)
        }
        return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: `未知翻唱接口：${endpoint}` })
      }

      /* ---- music cache bridge ---- */
      if (segments[0] === 'music') {
        if (segments[1] === 'cache' && method === 'GET') {
          return sendJson(res, 200, {
            ok: true,
            directories: musicCache.directories(),
            bound: store.state.musicCache?.directories || [],
            entries: store.state.musicCache?.entries || [],
            scannedAt: store.state.musicCache?.scannedAt || null,
          })
        }
        if (segments[1] === 'bind-cache' && method === 'POST') {
          const body = await readBody(req)
          const result = await musicCache.bind(body.directory || body.path)
          return sendJson(res, 200, result)
        }
        if (segments[1] === 'scan' && method === 'POST') {
          return sendJson(res, 200, { ok: true, entries: await musicCache.scan(), directories: musicCache.directories() })
        }
        if (segments[1] === 'use-current' && method === 'POST') {
          const body = await readBody(req)
          const file = await musicCache.download(body.url, body.songName)
          return sendJson(res, 200, { ok: true, path: file, songName: body.songName || path.basename(file) })
        }
        return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: `未知音乐桥接接口：${endpoint}` })
      }

      return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: `未知接口：${endpoint}` })
    } catch (error) {
      const status = error?.code === 'PROFILE_NOT_FOUND' || error?.code === 'JOB_NOT_FOUND' || error?.code === 'AUDIO_NOT_FOUND' ? 404
        : error?.code === 'TRAINING_BUSY' || error?.code === 'DEFAULT_CANNOT_DISABLE' ? 409
          : 400
      logger?.warn?.(`[dsh-voice-unified] API ${method} ${endpoint} failed: ${error?.message || error}`)
      return sendError(res, error, status)
    }
  }

  return { handle, health, route: API_ROUTE }
}
