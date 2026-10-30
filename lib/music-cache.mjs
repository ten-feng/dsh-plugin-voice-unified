/** Music-plugin bridge: cache discovery, binding, download and lookup. */
import { createWriteStream, existsSync, watch } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ensureDir, nowIso, safeFileName } from './util.mjs'

const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.webm'])

function defaultDirs() {
  const home = homedir()
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  return [
    path.join(home, '.dsh', 'music-cache'),
    path.join(home, '.dsh', 'music', 'cache'),
    path.join(local, 'dsh-music', 'cache'),
    path.join(home, 'Music', 'DSH'),
  ]
}

async function walk(dir, depth, out, limit = 300) {
  if (depth < 0 || out.length >= limit) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= limit) break
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full, depth - 1, out, limit)
      continue
    }
    if (!AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) continue
    try {
      const info = await stat(full)
      out.push({
        path: full,
        name: entry.name,
        title: path.basename(entry.name, path.extname(entry.name)),
        size: info.size,
        mtime: info.mtime.toISOString(),
        directory: dir,
      })
    } catch { /* ignore */ }
  }
}

export class MusicCache {
  constructor({ store, logger, getOrigin } = {}) {
    this.store = store
    this.logger = logger
    this.getOrigin = getOrigin || (() => `http://127.0.0.1:${process.env.DSH_PORT || process.env.PORT || 51386}`)
    this.watchers = new Map()
    this.scanTimer = null
    this.scanning = false
  }

  directories() {
    const stored = this.store.state.musicCache?.directories || []
    return [...new Set([...stored, ...defaultDirs()])]
  }

  async init() {
    for (const dir of this.directories()) {
      if (existsSync(dir)) await ensureDir(dir)
    }
    if (!this.store.state.musicCache) this.store.state.musicCache = { directories: [], entries: [] }
    await this.scan()
    for (const dir of this.directories()) this.watch(dir)
    return this
  }

  watch(dir) {
    if (this.watchers.has(dir) || !existsSync(dir)) return
    try {
      const watcher = watch(dir, { recursive: true }, () => this.scheduleScan())
      watcher.on('error', () => {})
      this.watchers.set(dir, watcher)
    } catch {
      // Some platforms cannot watch recursively; explicit scan still works.
    }
  }

  scheduleScan() {
    if (this.scanTimer) return
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null
      void this.scan()
    }, 800)
  }

  async scan() {
    if (this.scanning) return
    this.scanning = true
    try {
      const entries = []
      for (const dir of this.directories()) {
        if (existsSync(dir)) await walk(dir, 2, entries)
      }
      // De-duplicate by absolute path, newest first.
      const unique = new Map()
      for (const entry of entries) unique.set(entry.path.toLowerCase(), entry)
      const list = [...unique.values()].sort((a, b) => String(b.mtime).localeCompare(String(a.mtime))).slice(0, 300)
      this.store.state.musicCache = {
        directories: this.store.state.musicCache?.directories || [],
        entries: list,
        scannedAt: nowIso(),
      }
      this.store.touch()
      return list
    } finally {
      this.scanning = false
    }
  }

  async bind(directory) {
    const resolved = path.resolve(String(directory || ''))
    if (!resolved) throw Object.assign(new Error('缓存目录不能为空'), { code: 'BAD_DIRECTORY' })
    if (!existsSync(resolved)) throw Object.assign(new Error(`目录不存在：${resolved}`), { code: 'DIRECTORY_NOT_FOUND' })
    const info = await stat(resolved)
    if (!info.isDirectory()) throw Object.assign(new Error(`不是目录：${resolved}`), { code: 'NOT_DIRECTORY' })
    const dirs = new Set(this.store.state.musicCache?.directories || [])
    dirs.add(resolved)
    this.store.state.musicCache = { ...(this.store.state.musicCache || {}), directories: [...dirs] }
    this.watch(resolved)
    const entries = await this.scan()
    this.store.touch()
    return { ok: true, directories: this.directories(), entries }
  }

  async resolveSource({ sourcePath, sourceUrl, songName } = {}) {
    if (sourcePath) {
      const resolved = path.resolve(String(sourcePath))
      if (!existsSync(resolved)) throw Object.assign(new Error(`找不到原唱文件：${resolved}`), { code: 'SOURCE_NOT_FOUND' })
      return { path: resolved, from: 'path', songName: songName || path.basename(resolved, path.extname(resolved)) }
    }
    if (sourceUrl) {
      const saved = await this.download(sourceUrl, songName)
      return { path: saved, from: 'url', songName: songName || path.basename(saved, path.extname(saved)) }
    }
    if (songName) {
      const found = this.findByName(songName)
      if (found) return { path: found.path, from: 'cache', songName: found.title }
      throw Object.assign(new Error(`未找到名为「${songName}」的音乐缓存。请先在音乐插件缓存这首歌，或在翻唱页手动选择本地音频。`), {
        code: 'CACHE_NOT_FOUND',
        hint: '当前已扫描的缓存文件可通过 /music/cache 查看。',
      })
    }
    if (this.store.state.musicCache?.entries?.length) {
      const latest = this.store.state.musicCache.entries[0]
      return { path: latest.path, from: 'cache-latest', songName: latest.title }
    }
    throw Object.assign(new Error('未找到音乐缓存文件。请先在音乐插件中缓存歌曲，或在翻唱页手动选择本地音频。'), {
      code: 'NO_CACHE_FILE',
      hint: '也可以绑定音乐缓存目录，或直接上传本地音频。',
    })
  }

  findByName(name) {
    const key = String(name || '').toLowerCase()
    if (!key) return null
    return (this.store.state.musicCache?.entries || []).find((entry) =>
      entry.title.toLowerCase().includes(key) || entry.name.toLowerCase().includes(key)) || null
  }

  async download(url, songName) {
    const absolute = /^https?:\/\//i.test(url) ? url : `${this.getOrigin()}${url.startsWith('/') ? '' : '/'}${url}`
    const response = await fetch(absolute, { headers: { 'user-agent': 'dsh-voice-unified/1.0' } })
    if (!response.ok) throw Object.assign(new Error(`下载音乐缓存失败：HTTP ${response.status}`), { code: 'CACHE_DOWNLOAD_FAILED' })
    const length = Number(response.headers.get('content-length') || 0)
    if (length > 200 * 1024 * 1024) throw Object.assign(new Error('音频文件超过 200MB 限制'), { code: 'AUDIO_TOO_LARGE' })
    const type = String(response.headers.get('content-type') || '')
    const ext = type.includes('mpeg') ? '.mp3' : type.includes('wav') ? '.wav' : type.includes('flac') ? '.flac' : '.mp3'
    const dir = path.join(this.store.root, 'cache')
    await ensureDir(dir)
    const file = path.join(dir, `${safeFileName(songName || 'music', 'music').replace(/\.[^.]+$/, '')}-${Date.now()}${ext}`)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(file))
    await this.scan()
    return file
  }

  dispose() {
    for (const watcher of this.watchers.values()) {
      try { watcher.close() } catch { /* ignore */ }
    }
    this.watchers.clear()
    if (this.scanTimer) clearTimeout(this.scanTimer)
  }
}
