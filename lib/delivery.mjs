/**
 * Session output layer for voice cards.
 *
 * Two delivery channels, in order of preference:
 *
 *  1. `fence` (default, always safe) — the caller (tool / model) receives a
 *     ```dsh-voice fenced JSON block and echoes it in its own assistant reply.
 *     The web client turns that block into a player, so the card is part of a
 *     normal assistant message and can never corrupt the durable session log.
 *
 *  2. `session` (best effort) — append the fence as an assistant message, but
 *     only while a turn+step is actually open and no tool call is in flight.
 *     We never fabricate a turn: writing a synthetic turn after `turn/end`
 *     produces "turn/start does not open the expected turn" and makes the
 *     whole session log unreadable (this is what used to happen with deferred
 *     cover deliveries).
 *
 * Payloads that cannot be appended are persisted in `state.pendingVoice` so a
 * later turn can deliver them instead of silently dropping them.
 */
import { newId, safeJsonParse } from './util.mjs'

function findLastPosition(events) {
  let turn
  let step
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (turn === undefined && typeof event?.data?.turn === 'number') turn = event.data.turn
    if (step === undefined && typeof event?.data?.step === 'number') step = event.data.step
    if (turn !== undefined && step !== undefined) break
  }
  return { turn: turn ?? 0, step: step ?? 0 }
}

function openTurnState(events) {
  let turn = null
  let step = null
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = event.data?.turn
      step = null
    } else if (event.type === 'turn/end') {
      turn = null
      step = null
    } else if (event.type === 'step/start') {
      step = event.data?.step
    } else if (event.type === 'step/end') {
      step = null
    }
  }
  return { turn, step }
}

/**
 * 找出当前仍未有结果的 tool/call。
 *
 * 语音卡片如果在工具调用执行期间被追加到会话里，就会插在 assistant 的
 * tool_use 和紧随其后的 tool_result 之间，下一次模型请求会被服务端以
 * INVALID_REQUEST 拒绝（"tool_use ids were found without tool_result
 * blocks immediately after"）。所以有未完成工具调用时不能写入会话。
 */
function unresolvedToolCalls(events) {
  const calls = new Map()
  for (const event of events) {
    if (event?.type === 'tool/call') {
      calls.set(event.data?.callId, event.data?.step)
      continue
    }
    if (event?.type === 'assistant/message') {
      const blocks = event.data?.message?.content || []
      for (const block of blocks) {
        if (block?.type === 'tool-call' && block.id) calls.set(block.id, event.data?.step)
      }
      continue
    }
    if (event?.type === 'tool/result') {
      const id = event.data?.toolCallId
        ?? event.data?.callId
        ?? event.data?.message?.source?.callId
        ?? event.data?.message?.content?.[0]?.toolCallId
      calls.delete(id)
    }
  }
  return [...calls.keys()]
}

export function buildVoiceFence(payload) {
  const spec = {
    voiceReplyId: payload.voiceReplyId,
    audioUrl: payload.audioUrl,
    title: payload.title || '语音回复',
    duration: Number(payload.duration || 0),
    profileName: payload.profileName || '',
    emotion: payload.emotion || '平静',
    autoplay: Boolean(payload.autoplay),
    kind: payload.kind || 'reply',
    downloadUrl: payload.downloadUrl || payload.audioUrl,
  }
  return `\`\`\`dsh-voice\n${JSON.stringify(spec)}\n\`\`\``
}

const MAX_PENDING = 20
const PENDING_TTL_MS = 12 * 60 * 60 * 1000

export class SessionDelivery {
  constructor({ ctx, store, logger } = {}) {
    this.ctx = ctx
    this.store = store
    this.logger = logger
    /**
     * Live turn/tool state fed by the session/event hook. `session.events` can
     * lag behind the current in-flight turn (a voice_speak tool executes while
     * the assistant tool_use is still being appended), so never rely on it
     * alone for ordering.
     */
    this.live = new Map()
  }

  /** Durable queue of payloads that could not be appended to a session. */
  get pending() {
    const state = this.store?.state
    if (!state) return []
    if (!Array.isArray(state.pendingVoice)) state.pendingVoice = []
    return state.pendingVoice
  }

  rememberPending(payload, reason) {
    const list = this.pending
    const cutoff = Date.now() - PENDING_TTL_MS
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (!(Number(list[index]?.at) > cutoff)) list.splice(index, 1)
    }
    // Never queue the same audio twice (status polling can hit deliver() again).
    if (list.some((entry) => entry?.payload?.audioUrl === payload.audioUrl)) return
    list.push({ at: Date.now(), reason: reason || '', sessionId: payload.sessionId || '', payload })
    if (list.length > MAX_PENDING) list.splice(0, list.length - MAX_PENDING)
    this.store?.touch?.()
  }

  dropPending(audioUrl) {
    const list = this.pending
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (list[index]?.payload?.audioUrl === audioUrl) list.splice(index, 1)
    }
  }

  noteEvent(sessionId, event) {
    const id = String(sessionId || '')
    if (!id || !event) return
    let st = this.live.get(id)
    if (!st) {
      st = { turn: null, step: null, calls: new Set(), lastTurn: 0 }
      this.live.set(id, st)
    }
    const data = event.data || {}
    if (typeof data.turn === 'number') st.lastTurn = Math.max(st.lastTurn, data.turn)
    if (event.type === 'turn/start') {
      st.turn = data.turn
      st.step = null
      st.calls.clear()
    } else if (event.type === 'turn/end') {
      st.turn = null
      st.step = null
      st.calls.clear()
    } else if (event.type === 'step/start') {
      st.step = data.step
    } else if (event.type === 'step/end') {
      st.step = null
    } else if (event.type === 'tool/call') {
      if (data.callId) st.calls.add(data.callId)
    } else if (event.type === 'assistant/message') {
      for (const block of data.message?.content || []) {
        if (block?.type === 'tool-call' && block.id) st.calls.add(block.id)
      }
    } else if (event.type === 'tool/result') {
      const callId = data.toolCallId
        ?? data.callId
        ?? data.message?.source?.callId
        ?? data.message?.content?.[0]?.toolCallId
      if (callId) st.calls.delete(callId)
    }
  }

  resolveSession(sessionId) {
    const id = sessionId || this.store?.state?.lastSessionId
    if (!id) return { id: '', session: null }
    const session = this.ctx?.sessions?.get?.(id) || null
    return { id, session }
  }

  /** True only when appending a message cannot break tool_use/tool_result order. */
  canAppend(session, id) {
    if (!session || typeof session.append !== 'function') return false
    const events = session.events || []
    const live = this.live.get(id)
    // live 只用来判断“工具调用是否还没结束”：它比 events 更及时。
    if (live?.calls?.size) return false
    if (unresolvedToolCalls(events).length) return false
    // turn/step 的开合状态以 events 为准，避免进程中途启动时 live 为空值卡死投递。
    const open = openTurnState(events)
    return open.turn !== null && open.step !== null
  }

  /**
   * Build a voice card for `payload`.
   *
   * Returns `{ ok, mode, fence, ... }`. `mode: 'fence'` means the caller must
   * echo `fence` in its own reply; `mode: 'session'` means the card is already
   * part of the session log.
   */
  deliver(payload = {}) {
    const { sessionId, audioUrl, title, duration, profileName, emotion, autoplay, kind, downloadUrl } = payload
    if (!audioUrl) return { ok: false, code: 'NO_AUDIO', error: '没有可播放的音频地址。' }
    const { id, session } = this.resolveSession(sessionId)
    const voiceReplyId = newId('vr')
    const fence = buildVoiceFence({
      voiceReplyId,
      audioUrl,
      title,
      duration,
      profileName,
      emotion,
      autoplay,
      kind,
      downloadUrl,
    })
    const base = { ok: true, voiceReplyId, audioUrl, fence, mode: 'fence' }

    if (!session) {
      this.rememberPending({ ...payload, sessionId: id }, 'session-not-live')
      return { ...base, deferred: true, reason: 'SESSION_NOT_LIVE', note: '会话不在线，语音卡片已记入待投递队列。' }
    }

    const events = session.events || []
    if (!this.canAppend(session, id)) {
      this.rememberPending({ ...payload, sessionId: id }, 'turn-busy')
      return { ...base, deferred: true, reason: 'TURN_BUSY', note: '当前回合仍在执行，播放器已随工具结果返回，请原样写进回复。' }
    }

    const open = openTurnState(events)
    const message = {
      id: `msg_${voiceReplyId}`,
      role: 'assistant',
      source: { kind: 'model', provider: 'dsh-voice-unified', model: 'voice-output' },
      content: [{ type: 'text', text: fence }],
    }
    try {
      const event = session.append('assistant/message', {
        turn: open.turn,
        step: open.step,
        message,
        stream: [],
      }, { surfaceOp: 'append' })
      this.store.state.lastSessionId = id
      this.store.touch()
      this.dropPending(audioUrl)
      return { ...base, mode: 'session', sessionId: id, seq: event?.seq }
    } catch (error) {
      this.logger?.warn?.(`[dsh-voice-unified] append voice message failed: ${error?.message || error}`)
      this.rememberPending({ ...payload, sessionId: id }, 'append-failed')
      return { ...base, deferred: true, reason: 'APPEND_FAILED', note: '写入会话失败，播放器已随工具结果返回。' }
    }
  }

  /**
   * 把待投递队列里的卡片补投到会话里（只在真正安全的时候）。
   * 返回成功投递的条数。
   */
  flushPending(sessionId) {
    const list = this.pending
    if (!list.length) return 0
    const targetId = String(sessionId || this.store?.state?.lastSessionId || '')
    const session = this.ctx?.sessions?.get?.(targetId)
    if (!session || !this.canAppend(session, targetId)) return 0
    let delivered = 0
    for (const entry of [...list]) {
      const owner = entry?.sessionId
      const ownerSession = owner && owner !== targetId ? this.ctx?.sessions?.get?.(owner) : null
      // Only adopt cards whose original session is gone; never steal a live one.
      if (ownerSession) continue
      const result = this.deliver({ ...entry.payload, sessionId: targetId })
      if (result?.ok && result.mode === 'session') {
        this.dropPending(entry.payload.audioUrl)
        delivered += 1
      }
    }
    if (delivered) {
      this.logger?.info?.(`[dsh-voice-unified] deferred voice delivered: ${delivered}`)
      this.store?.touch?.()
    }
    return delivered
  }

  /** Fence text for a payload that was queued but never surfaced to the model. */
  fenceFor(audioUrl) {
    const entry = this.pending.find((item) => item?.payload?.audioUrl === audioUrl)
    if (!entry) return ''
    return buildVoiceFence({ ...entry.payload, voiceReplyId: newId('vr') })
  }

  rememberSession(sessionId, turn) {
    if (!sessionId) return
    this.store.state.lastSessionId = sessionId
    if (typeof turn === 'number') this.store.state.lastTurn = turn
    this.store.touch()
  }

  /** Recent assistant text for a session, used by status/diagnostics. */
  static lastAssistantText(session, turn) {
    const events = session?.events || []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type !== 'assistant/message') continue
      if (turn !== undefined && event.data?.turn !== turn) continue
      const blocks = event.data?.message?.content || []
      const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('')
      if (!text.trim()) continue
      if (safeJsonParse(text.replace(/^```dsh-voice\s*/, '').replace(/```$/, ''))) continue
      return text
    }
    return ''
  }
}
