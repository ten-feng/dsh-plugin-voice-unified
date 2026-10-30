/** Replaceable local audio backends: Windows SAPI + ffmpeg + Python DSP. */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  ensureDir,
  firstMeaningfulError,
  readJson,
  runProcess,
  safeJsonParse,
} from './util.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.resolve(HERE, '..')

/** FFmpeg writes WAV to stdout with an unknown/0xFFFFFFFF data size. SAPI and
 * several decoders reject that; patch RIFF/data sizes after the pipe closes. */
function fixWavSizes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return buffer
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return buffer
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'data') {
      buffer.writeUInt32LE(buffer.length - offset - 8, offset + 4)
      buffer.writeUInt32LE(buffer.length - 8, 4)
      return buffer
    }
    if (size === 0xffffffff) break
    offset += 8 + size + (size & 1)
  }
  buffer.writeUInt32LE(buffer.length - 8, 4)
  return buffer
}

function defaultPython() {
  const candidates = [
    process.env.DSH_VOICE_PYTHON,
    path.join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python',
    'python3',
  ].filter(Boolean)
  return candidates.find((candidate) => candidate === 'python' || candidate === 'python3' || existsSync(candidate)) || 'python'
}

function defaultFfmpeg() {
  const candidates = [
    process.env.DSH_VOICE_FFMPEG,
    path.join(PLUGIN_ROOT, 'bin', 'ffmpeg.exe'),
    path.join(PLUGIN_ROOT, 'bin', 'ffmpeg'),
    'ffmpeg',
  ].filter(Boolean)
  return candidates.find((candidate) => candidate === 'ffmpeg' || existsSync(candidate)) || 'ffmpeg'
}

export class AudioEngine {
  constructor({ python, ffmpeg, scriptsDir, logger } = {}) {
    this.python = python || defaultPython()
    this.ffmpeg = ffmpeg || defaultFfmpeg()
    this.scriptsDir = scriptsDir || path.join(PLUGIN_ROOT, 'scripts')
    this.engineScript = path.join(PLUGIN_ROOT, 'engine', 'voice_engine.py')
    this.sapiScript = path.join(this.scriptsDir, 'sapi-tts.ps1')
    this.sapiAsrScript = path.join(this.scriptsDir, 'sapi-asr.ps1')
    this.logger = logger
    this._status = null
  }

  async status(force = false) {
    if (this._status && !force) return this._status
    const ffmpegInstalled = this.ffmpeg === 'ffmpeg' ? true : existsSync(this.ffmpeg)
    const pythonInstalled = this.python === 'python' || this.python === 'python3' ? true : existsSync(this.python)
    const engineInstalled = existsSync(this.engineScript)
    const sapiInstalled = process.platform === 'win32' && existsSync(this.sapiScript)
    let pythonOk = false
    let pythonDetail = ''
    if (pythonInstalled) {
      try {
        const result = await runProcess(this.python, ['-c', 'import sys,numpy;print(sys.version.split()[0],numpy.__version__)'], { timeoutMs: 15000 })
        pythonOk = result.code === 0
        pythonDetail = (result.stdout || result.stderr).trim().split(/\r?\n/).at(-1) || ''
      } catch (error) {
        pythonDetail = error.message
      }
    }
    const ok = ffmpegInstalled && pythonOk && engineInstalled && sapiInstalled
    this._status = {
      ok,
      platform: process.platform,
      tts: sapiInstalled ? 'Windows SAPI (local)' : 'unavailable',
      ffmpeg: { installed: ffmpegInstalled, path: this.ffmpeg },
      python: { installed: pythonInstalled && pythonOk, path: this.python, detail: pythonDetail },
      dsp: { installed: engineInstalled, path: this.engineScript },
      detail: ok ? '本地引擎就绪' : '本地引擎组件不完整，请查看路径与 Python/numpy 安装。',
    }
    return this._status
  }

  async ffmpegRun(args, options = {}) {
    const result = await runProcess(this.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], {
      timeoutMs: options.timeoutMs || 10 * 60 * 1000,
      signal: options.signal,
      onStderr: options.onStderr,
    })
    if (result.code !== 0) {
      throw Object.assign(new Error(`ffmpeg 失败：${firstMeaningfulError(result.stderr, `退出码 ${result.code}`)}`), {
        code: 'FFMPEG_FAILED',
        stderr: result.stderr,
      })
    }
    return result
  }

  /** Run ffmpeg with a stdout pipe and return the encoded bytes.
   *
   * Some Windows FFmpeg builds in the wild are unable to open output paths
   * outside their own working directory (sandboxed/OEM builds). Piping the
   * container to Node and writing the file ourselves avoids that class of
   * environment-specific failure.
   */
  ffmpegToBuffer(args, { timeoutMs = 10 * 60 * 1000, signal } = {}) {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(this.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        reject(error)
        return
      }
      const chunks = []
      let stderr = ''
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(Buffer.concat(chunks))
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* ignore */ }
        finish(Object.assign(new Error(`ffmpeg 编码超时（${Math.round(timeoutMs / 1000)}s）`), { code: 'FFMPEG_TIMEOUT', stderr }))
      }, Math.max(1000, timeoutMs))
      const onAbort = () => {
        try { child.kill() } catch { /* ignore */ }
        finish(Object.assign(new Error('任务已取消'), { code: 'ABORTED', stderr }))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (chunk) => chunks.push(chunk))
      child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
      child.once('error', (error) => finish(Object.assign(new Error(`无法启动 ffmpeg：${error.message}`), { code: 'SPAWN_FAILED', stderr })))
      child.once('close', (code) => {
        if (code !== 0) {
          finish(Object.assign(new Error(`ffmpeg 失败：${firstMeaningfulError(stderr, `退出码 ${code}`)}`), { code: 'FFMPEG_FAILED', stderr }))
          return
        }
        finish(null)
      })
    })
  }

  async decodeToWav(input, output, { sampleRate = 24000, channels = 1, signal } = {}) {
    await ensureDir(path.dirname(output))
    const buffer = await this.ffmpegToBuffer([
      '-i', input,
      '-vn',
      '-ac', String(channels),
      '-ar', String(sampleRate),
      '-sample_fmt', 's16',
      '-f', 'wav', '-',
    ], { signal, timeoutMs: 5 * 60 * 1000 })
    await writeFile(output, fixWavSizes(buffer))
    return output
  }

  async encodeAudio(input, output, { format = 'mp3', bitrate = '192k', duration, signal } = {}) {
    await ensureDir(path.dirname(output))
    const args = []
    if (duration) args.push('-t', String(duration))
    args.push('-i', input, '-vn')
    if (format === 'wav') {
      args.push('-ar', '44100', '-sample_fmt', 's16', '-f', 'wav', '-')
    } else {
      args.push('-codec:a', 'libmp3lame', '-b:a', bitrate, '-ar', '44100', '-f', 'mp3', '-')
    }
    const buffer = await this.ffmpegToBuffer(args, { signal })
    await writeFile(output, format === 'wav' ? fixWavSizes(buffer) : buffer)
    return output
  }

  /** Render one filtered stem to WAV via stdout. */
  async extractStem(input, output, filter, { channels = 1, sampleRate = 44100, signal } = {}) {
    await ensureDir(path.dirname(output))
    const buffer = await this.ffmpegToBuffer([
      '-i', input,
      '-filter_complex', filter,
      '-ac', String(channels),
      '-ar', String(sampleRate),
      '-sample_fmt', 's16',
      '-f', 'wav', '-',
    ], { signal, timeoutMs: 5 * 60 * 1000 })
    await writeFile(output, fixWavSizes(buffer))
    return output
  }

  async duration(file) {
    try {
      const result = await runProcess(this.ffmpeg, ['-hide_banner', '-i', file, '-f', 'null', '-'], { timeoutMs: 30000 })
      const text = `${result.stderr}\n${result.stdout}`
      const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
      if (!match) return 0
      return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    } catch {
      return 0
    }
  }

  async sapiTts({ text, outWav, voice, rate = 0, volume = 100, pauseMs = 180, signal } = {}) {
    if (process.platform !== 'win32') {
      throw Object.assign(new Error('当前平台没有可用的本地 SAPI TTS；请配置外部 TTS 引擎。'), { code: 'TTS_ENGINE_UNAVAILABLE' })
    }
    if (!existsSync(this.sapiScript)) {
      throw Object.assign(new Error(`找不到 SAPI 脚本：${this.sapiScript}`), { code: 'TTS_ENGINE_UNAVAILABLE' })
    }
    const textFile = `${outWav}.${Date.now()}.txt`
    await ensureDir(path.dirname(outWav))
    await writeFile(textFile, String(text), 'utf8')
    try {
      const result = await runProcess('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', this.sapiScript,
        '-TextFile', textFile,
        '-OutFile', outWav,
        '-Voice', voice || '',
        '-Rate', String(rate),
        '-Volume', String(volume),
        '-PauseMs', String(pauseMs),
      ], { timeoutMs: 120000, signal })
      if (result.code !== 0 || !existsSync(outWav)) {
        throw Object.assign(new Error(`SAPI 合成失败：${firstMeaningfulError(result.stderr, `退出码 ${result.code}`)}`), {
          code: 'TTS_FAILED',
          stderr: result.stderr,
        })
      }
      return { voice: (result.stdout.match(/^OK\|([^|]+)/) || [])[1] || voice || '', outWav }
    } finally {
      await rm(textFile, { force: true }).catch(() => {})
    }
  }

  async sapiAsr(wavFile, { signal } = {}) {
    if (process.platform !== 'win32' || !existsSync(this.sapiAsrScript)) {
      throw Object.assign(new Error('当前平台没有可用的本地语音识别引擎'), { code: 'ASR_ENGINE_UNAVAILABLE' })
    }
    const result = await runProcess('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', this.sapiAsrScript,
      '-WavFile', wavFile,
      '-Culture', 'zh-CN',
    ], { timeoutMs: 120000, signal })
    if (result.code !== 0) {
      throw Object.assign(new Error(`本地语音识别失败：${firstMeaningfulError(result.stderr, `退出码 ${result.code}`)}`), {
        code: 'ASR_FAILED',
        stderr: result.stderr,
      })
    }
    const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith('OK|')) || ''
    return line.slice(3).trim()
  }

  async runPython(command, args = [], { signal, timeoutMs = 120000, cwd } = {}) {
    if (!existsSync(this.engineScript)) {
      throw Object.assign(new Error(`找不到 DSP 引擎：${this.engineScript}`), { code: 'DSP_ENGINE_UNAVAILABLE' })
    }
    const jsonFile = path.join(PLUGIN_ROOT, 'engine', `.result-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    try {
      const result = await runProcess(this.python, [
        this.engineScript,
        command,
        ...args,
        '--json', jsonFile,
      ], { timeoutMs, signal, cwd })
      if (result.code !== 0) {
        throw Object.assign(new Error(`DSP ${command} 失败：${firstMeaningfulError(result.stderr, `退出码 ${result.code}`)}`), {
          code: 'DSP_FAILED',
          stderr: result.stderr,
        })
      }
      const parsed = await readJson(jsonFile, null)
      if (parsed) return parsed
      const stdout = safeJsonParse(result.stdout.trim().split(/\r?\n/).at(-1))
      if (stdout) return stdout
      throw Object.assign(new Error(`DSP ${command} 未返回结果 JSON`), { code: 'DSP_BAD_OUTPUT', detail: result.stdout.slice(-800) })
    } finally {
      await rm(jsonFile, { force: true }).catch(() => {})
    }
  }

  async analyze(wav, options = {}) {
    return this.runPython('analyze', ['--input', wav], options)
  }

  async slice(wav, outdir, options = {}) {
    return this.runPython('slice', ['--input', wav, '--outdir', outdir], options)
  }

  async convert(input, output, params = {}, options = {}) {
    const args = [
      '--input', input,
      '--output', output,
      '--pitch-semitones', String(params.pitchSemitones ?? 0),
      '--formant', String(params.formant ?? 1),
      '--brightness', String(params.brightness ?? 0),
      '--strength', String(params.strength ?? 1),
      '--speed', String(params.speed ?? 1),
      '--vibrato', String(params.vibrato ?? 0),
      '--tremolo', String(params.tremolo ?? 0),
    ]
    return this.runPython('convert', args, options)
  }

  async emotion(input, output, emotion, intensity, options = {}) {
    return this.runPython('emotion', [
      '--input', input,
      '--output', output,
      '--emotion', emotion,
      '--intensity', String(intensity ?? 0.7),
    ], options)
  }

  async mix(vocal, instrumental, output, options = {}) {
    return this.runPython('mix', [
      '--vocal', vocal,
      '--instrumental', instrumental,
      '--output', output,
      '--vocal-gain', String(options.vocalGain ?? 1),
      '--inst-gain', String(options.instGain ?? 0.9),
    ], options)
  }

  async separate(input, vocalOut, instOut, options = {}) {
    const { vocalSuppress = 0.25, ...runOptions } = options
    return this.runPython('separate', [
      '--input', input,
      '--vocal-out', vocalOut,
      '--inst-out', instOut,
      '--vocal-suppress', String(vocalSuppress),
    ], { timeoutMs: 10 * 60 * 1000, ...runOptions })
  }

  /** Trim a source to an exact lyric-line window. */
  async trimSegment(input, output, startSeconds, endSeconds, { signal } = {}) {
    await ensureDir(path.dirname(output))
    const start = Math.max(0, Number(startSeconds) || 0)
    const end = Math.max(start + 0.1, Number(endSeconds) || start + 0.1)
    const buffer = await this.ffmpegToBuffer([
      '-i', input,
      '-ss', String(start),
      '-t', String(Math.max(0.1, end - start)),
      '-ac', '2',
      '-ar', '44100',
      '-sample_fmt', 's16',
      '-f', 'wav', '-',
    ], { signal, timeoutMs: 5 * 60 * 1000 })
    await writeFile(output, fixWavSizes(buffer))
    return output
  }

  async similarity(targetFeatures, previewWav, options = {}) {
    return this.runPython('similarity', [
      '--target', targetFeatures,
      '--preview', previewWav,
    ], options)
  }

  async demo(outdir, options = {}) {
    await mkdir(outdir, { recursive: true })
    return this.runPython('demo', ['--outdir', outdir], { timeoutMs: 180000, ...options })
  }
}
