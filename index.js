/**
 * dsh-voice-unified host half.
 *
 * Modules are deliberately separated behind small interfaces:
 *   VoiceStore          durable state
 *   VoiceService        profiles / training / emotion-aware TTS
 *   CoverService        async separation -> conversion -> mix -> output
 *   MusicCache          music-plugin cache bridge
 *   SessionDelivery     durable assistant voice messages
 *   AudioEngine         replaceable local SAPI + ffmpeg + DSP backends
 *   createApi / tools   transport surfaces
 */
import { VoiceStore } from './lib/store.mjs'
import { AudioEngine } from './lib/audio-engine.mjs'
import { VoiceService } from './lib/voice-service.mjs'
import { CoverService } from './lib/cover-service.mjs'
import { MusicCache } from './lib/music-cache.mjs'
import { SessionDelivery } from './lib/delivery.mjs'
import { createApi } from './lib/api.mjs'
import { registerTools } from './lib/tools.mjs'

export const name = 'voice-unified'
export const inject = ['tools', 'systemPrompt', 'sessions']

const SECTION_TEXT = `你可以使用 dsh-voice-unified 的本地声音能力。DeepSeek 的工具名只允许字母/数字/下划线，因此对外同时提供：
- 安全名工具：voice_profile_create / voice_profile_add_sample / voice_profile_train / voice_profile_list / voice_profile_set_default / voice_profile_rollback / voice_profile_preview / voice_reply_toggle / voice_speak / voice_cover_run / voice_cover_status / voice_cover_export / voice_music_bind_cache / voice_settings_update。
- 统一入口 voice：action 使用精确命令名 voice.profile.create、voice.profile.addSample、voice.profile.train、voice.profile.list、voice.profile.setDefault、voice.profile.rollback、voice.profile.preview、voice.reply.toggle、voice.speak、voice.cover.run、voice.cover.status、voice.cover.export、voice.music.bindCache、voice.settings.update，params 为参数对象。
功能：多音色档案与样本训练/版本回滚/试听/全局默认；voice.speak 用默认或临时音色朗读；voice.reply.toggle 控制自动语音回复；voice.cover.run 把音乐插件原唱缓存做「人声分离→换声→混音」，默认直出语音回复；voice.music.bindCache 绑定缓存目录。
默认不自动语音回复。只有用户明确要求“唱/说/语音/朗读/念/翻唱/配音/播报/用某个声音”等时，才调用 voice.speak 或 voice.cover.run 生成语音。语音回复时省略过程：不要向用户描述工具名、参数、样本、训练、分离、换声、混音、编码、队列、日志、路径；最终文字只保留一句极简确认（如“好了”/“来听”），或直接让语音出现。
工具结果里如果带有 \`\`\`dsh-voice 代码块，那是语音播放器：必须把该代码块原样放进你的最终回复（单独一段、不改 JSON、不转述），否则用户看不到播放器；同一段音频只放一次。
临时指定音色只影响单次请求，不改变全局默认。翻唱片段必须按整句边界截取：调用 voice.cover.run 时传 start_time/end_time，end_time 要落在歌词句末（宁可多留 0.1~0.3 秒尾音），不要在字中间截断。翻唱没有缓存时明确提示用户先缓存或手动选择本地音频。训练和翻唱失败要告知失败原因与重试入口，不要阻塞普通对话。语音播放器支持右键“转文字”。`

const inFlight = new Set()
const lastAssistant = new Map()

// Only these explicit asks should trigger a spoken reply when autoReply is off.
const VOICE_INTENT_RE = /(翻唱|唱一|唱几|唱段|唱首|唱歌|唱给|来一段|来几句|语音|朗读|朗诵|念一下|念给我|念一遍|读一下|读给我|读一遍|说一句|说几句|说一段|说给我听|配音|播报|你的声音|用.{0,8}声音|听听.{0,4}声音)/

function blockText(content) {
  return (content || []).filter((block) => block?.type === 'text').map((block) => block.text).join('').trim()
}

function userTextForTurn(session, turn) {
  const events = session?.events || []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    if (typeof turn === 'number' && event.data?.turn !== turn && event.data?.turn !== undefined) continue
    const text = blockText(event.data?.message?.content || event.data?.content)
    if (text) return text
  }
  return ''
}

function hasVoiceFenceForTurn(session, turn) {
  return (session?.events || []).some((event) => {
    if (event?.type !== 'assistant/message') return false
    if (typeof turn === 'number' && event.data?.turn !== turn) return false
    return blockText(event.data?.message?.content).startsWith('```dsh-voice')
  })
}

function assistantTextForTurn(session, turn) {
  const events = session?.events || []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    if (typeof turn === 'number' && event.data?.turn !== turn) continue
    const blocks = event.data?.message?.content || []
    const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('').trim()
    if (!text) continue
    if (text.startsWith('```dsh-voice')) continue
    return text
  }
  return ''
}

export function apply(ctx) {
  const logger = ctx.logger
  let services = null
  let disposed = false
  let api = null

  const ready = (async () => {
    const store = await new VoiceStore().init()
    const engine = new AudioEngine({ logger })
    const delivery = new SessionDelivery({ ctx, store, logger })
    const voice = await new VoiceService({ store, engine, delivery, logger }).init()
    const musicCache = await new MusicCache({
      store,
      logger,
      getOrigin: () => `http://127.0.0.1:${process.env.DSH_PORT || process.env.PORT || 51386}`,
    }).init()
    const covers = await new CoverService({ store, engine, voice, musicCache, delivery, logger }).init()
    services = { store, engine, delivery, voice, musicCache, covers }
    api = createApi({
      ...services,
      logger,
      getOrigin: () => `http://127.0.0.1:${process.env.DSH_PORT || process.env.PORT || 51386}`,
    })
    logger?.info?.('[dsh-voice-unified] ready')
    return services
  })().catch((error) => {
    logger?.error?.(`[dsh-voice-unified] init failed: ${error?.stack || error}`)
    throw error
  })

  ctx.systemPrompt.section({
    name: 'voice-unified:contract',
    order: ctx.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT'),
    text: SECTION_TEXT,
  })

  // Register tools immediately, but every execute waits for boot. The facade
  // object exposes live getters plus the ready promise.
  const liveServices = {
    get store() { return services?.store },
    get engine() { return services?.engine },
    get delivery() { return services?.delivery },
    get voice() { return services?.voice },
    get musicCache() { return services?.musicCache },
    get covers() { return services?.covers },
    ready,
  }
  registerTools(ctx, liveServices)

  // Web route is registered synchronously so the host's optional webServer
  // fiber owns it; the first request waits for boot.
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.reflect.get('webServer')
    webCtx.effect(
      () => webServer.register({
        kind: 'prefix',
        path: '/plugins/dsh-voice-unified/api',
        handler: async (req, res) => {
          try {
            await ready
          } catch (error) {
            res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, code: 'NOT_READY', error: `声音插件初始化失败：${error.message}` }))
            return
          }
          return api.handle(req, res)
        },
      }),
      'dsh-voice-unified: api route',
    )
  })

  ctx.on('agent/turn-stopping', async (payload) => {
    const { agent, turn } = payload || {}
    if (!agent?.session || disposed) return
    const sessionId = String(agent.id)
    if (inFlight.has(sessionId)) return
    try {
      await ready
      const settings = services.store.state.settings
      if (hasVoiceFenceForTurn(agent.session, turn)) return
      const userText = userTextForTurn(agent.session, turn)
      const requested = Boolean(settings.intentReply && VOICE_INTENT_RE.test(userText))
      // A cover is already producing the requested voice; do not add a second
      // TTS reply for the same request.
      const coverBusy = services.covers.list(20).some((job) => {
        if (job.sessionId !== sessionId) return false
        if (job.status === 'queued' || job.status === 'running') return true
        return job.status === 'done' && job.delivery?.deferred
      })
      if (coverBusy) return
      // autoReply=false is the default: speak only when the user explicitly
      // asks for singing / speech / voice. true restores always-on behavior.
      if (!settings.autoReply && !requested) return
      const captured = lastAssistant.get(sessionId)
      const text = captured && (turn === undefined || captured.turn === turn) && Date.now() - captured.at < 120000
        ? captured.text
        : assistantTextForTurn(agent.session, turn)
      const capturedStep = captured && (turn === undefined || captured.turn === turn) ? captured.step : undefined
      if (!text || text.length > 6000) return
      const profile = services.store.defaultProfile()
      if (!profile || profile.status !== 'active') return
      inFlight.add(sessionId)
      services.delivery.rememberSession(sessionId, turn)
      logger?.info?.(`[dsh-voice-unified] auto voice reply: session=${sessionId} turn=${turn} chars=${text.length}`)
      const spoken = await services.voice.speak({
        text: text.slice(0, settings.maxReplyChars || 600),
        sessionId,
        deliver: true,
        title: `语音回复 · ${profile.name}`,
        turn,
        step: capturedStep,
      })
      if (spoken?.delivered?.mode === 'fence') {
        // 后台自动回复没有模型回合可以承载围栏：卡片已进 pendingVoice，
        // 需等下一次安全时机补投，这里只记录原因，不打断对话。
        logger?.info?.('[dsh-voice-unified] auto reply queued for later delivery (no open step)')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`[dsh-voice-unified] auto voice reply failed: ${message}`)
      try {
        services.store.state.lastError = { at: new Date().toISOString(), scope: 'auto-reply', message }
        services.store.touch()
      } catch { /* ignore */ }
    } finally {
      inFlight.delete(sessionId)
    }
  })

  ctx.on('session/event', (session, event) => {
    try {
      services?.delivery?.noteEvent?.(String(session?.id), event)
    } catch (error) {
      logger?.warn?.(`[dsh-voice-unified] note session event failed: ${error?.message || error}`)
    }
    if (event?.type === 'assistant/message') {
      const text = (event.data?.message?.content || []).filter((block) => block?.type === 'text').map((block) => block.text).join('')
      if (text.trim() && !text.trim().startsWith('```dsh-voice')) {
        lastAssistant.set(String(session?.id), { turn: event.data?.turn, step: event.data?.step, text: text.trim(), at: Date.now() })
      }
    }
    // 工具结果落库后再补投暂缓的语音卡片（只在 turn+step 真正打开、且没有
    // 未完成工具调用时才写入，绝不伪造 turn，否则会把会话日志写坏）。
    if (event?.type === 'turn/end' || event?.type === 'tool/result' || event?.type === 'step/end') {
      try {
        services?.delivery?.flushPending?.(String(session?.id))
      } catch (error) {
        logger?.warn?.(`[dsh-voice-unified] flush deferred voice failed: ${error?.message || error}`)
      }
    }
  })

  ctx.on('session/disposed', (session) => {
    try { delete services?.store?.state?.emotionStates?.[session.id] } catch { /* ignore */ }
    try { services?.delivery?.deferred?.delete?.(String(session?.id)) } catch { /* ignore */ }
  })

  ctx.effect(() => {
    return () => {
      disposed = true
      try { services?.musicCache?.dispose?.() } catch { /* ignore */ }
      try { void services?.store?.flush?.() } catch { /* ignore */ }
    }
  }, 'dsh-voice-unified: lifecycle')

  return ready
}
