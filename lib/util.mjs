/** Shared utilities for dsh-voice-unified. */
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

export const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value)))
export const nowIso = () => new Date().toISOString()
export const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 18)}`

export function formatDuration(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value < 0) return '0:00'
  const minutes = Math.floor(value / 60)
  return `${minutes}:${String(Math.floor(value % 60)).padStart(2, '0')}`
}

export function safeFileName(name, fallback = 'audio') {
  const base = path.basename(String(name || '').replace(/[\u0000-\u001f]/g, '')).trim()
  const cleaned = base.replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ').slice(0, 120)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback
}

export function safeJsonParse(text) {
  try {
    return JSON.parse(String(text || '').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
  return dir
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file))
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

export async function fileSize(file) {
  try {
    return (await stat(file)).size
  } catch {
    return 0
  }
}

export async function removeFile(file) {
  try {
    await rm(file, { force: true })
  } catch {
    /* ignore */
  }
}

/** Spawn a child with a timeout and an optional abort signal. */
export function runProcess(command, args, options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 10 * 60 * 1000,
    signal,
    onStdout,
    onStderr,
    input,
    windowsHide = true,
  } = options

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* ignore */ }
      reject(Object.assign(new Error(`命令执行超时（${Math.round(timeoutMs / 1000)}s）：${command}`), {
        code: 'PROCESS_TIMEOUT',
        stdout,
        stderr,
      }))
    }, Math.max(1000, timeoutMs))

    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { /* ignore */ }
      reject(Object.assign(new Error('任务已取消'), { code: 'ABORTED', stdout, stderr }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_500_000)
      onStdout?.(text)
    })
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_500_000)
      onStderr?.(text)
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(Object.assign(new Error(`无法启动命令：${command}（${error.message}）`), {
        code: 'SPAWN_FAILED',
        stdout,
        stderr,
        cause: error,
      }))
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr })
    })

    if (input !== undefined) {
      child.stdin?.end(input)
    } else {
      child.stdin?.end()
    }
  })
}

export function firstMeaningfulError(stderr, fallback = '未知错误') {
  const lines = String(stderr || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return fallback
  return lines.slice(-6).join(' | ').slice(-900)
}

export function toErrorPayload(error, code = 'VOICE_ERROR') {
  return {
    ok: false,
    code: error?.code || code,
    error: error instanceof Error ? error.message : String(error || '未知错误'),
    detail: typeof error?.stderr === 'string' ? error.stderr.slice(-1200) : undefined,
  }
}

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 12)
  if (typeof tags === 'string') return tags.split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean).slice(0, 12)
  return []
}

export function relativeUrl(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  return `/plugins/dsh-voice-unified/api/file/${normalized.split('/').map(encodeURIComponent).join('/')}`
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('任务已取消'), { code: 'ABORTED' }))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(Object.assign(new Error('任务已取消'), { code: 'ABORTED' }))
    }, { once: true })
  })
}

export function tailLines(text, count = 200) {
  return String(text || '').split(/\r?\n/).filter(Boolean).slice(-count)
}

export function streamToFile(response, file) {
  return new Promise(async (resolve, reject) => {
    try {
      await ensureDir(path.dirname(file))
      const out = createWriteStream(file)
      const reader = response.body?.getReader?.()
      if (!reader) {
        const buffer = Buffer.from(await response.arrayBuffer())
        await writeFile(file, buffer)
        resolve(file)
        return
      }
      out.on('error', reject)
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        out.write(Buffer.from(value))
      }
      out.end(() => resolve(file))
    } catch (error) {
      reject(error)
    }
  })
}
