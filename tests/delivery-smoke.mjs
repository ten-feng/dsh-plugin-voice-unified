/**
 * Delivery regression test.
 *
 * 背景：旧实现会在 turn/end 之后伪造一个 turn 把语音卡片写进会话，
 * 结果是 "turn/start does not open the expected turn"，整段会话日志读不出来
 * （见 docs/LIMITATIONS.md 的已知问题）。现在交付策略改为：
 *   1. 围栏优先（模型把 ```dsh-voice 代码块写进回复）；
 *   2. 只有 turn+step 真正打开且没有未完成工具调用时才写入会话；
 *   3. 绝不伪造 turn；写不进去就进持久化队列。
 */
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VoiceStore } from '../lib/store.mjs'
import { SessionDelivery } from '../lib/delivery.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const home = path.join(ROOT, 'output', 'delivery-home')
await rm(home, { recursive: true, force: true })

const store = await new VoiceStore({ root: home }).init()

let seq = 0
const appended = []
const events = []
const session = {
  id: 'session-main',
  events,
  append(type, data, opts) {
    const event = { type, data, ...opts, seq: seq++, time: Date.now() }
    events.push(event)
    appended.push(event)
    return event
  },
}
const ctx = { sessions: { get: (id) => (id === 'session-main' ? session : undefined) } }
const delivery = new SessionDelivery({ ctx, store, logger: { info() {}, warn() {} } })

const failures = []
const check = (name, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : ` :: ${detail}`}`)
  if (!condition) failures.push(name)
}
const audio = (n) => `/plugins/dsh-voice-unified/api/file/audio/test/case-${n}.mp3`

// --- case 1: 工具调用未完成时不能写入，只能给围栏 -------------------------
events.push({ type: 'turn/start', data: { turn: 1 }, seq: seq++ })
events.push({ type: 'step/start', data: { turn: 1, step: 1 }, seq: seq++ })
events.push({ type: 'tool/call', data: { callId: 'call-1', step: 1 }, seq: seq++ })

const r1 = delivery.deliver({ sessionId: 'session-main', audioUrl: audio(1), duration: 12, title: 't1' })
check('case1 延后投递', r1.ok && r1.deferred === true && r1.mode === 'fence', JSON.stringify(r1))
check('case1 返回围栏', String(r1.fence).includes('"voiceReplyId"'), String(r1.fence))
check('case1 未写入会话', appended.length === 0, `appended=${appended.length}`)
check('case1 进入待投递队列', delivery.pending.length === 1, `pending=${delivery.pending.length}`)

// --- case 2: turn/end 之后绝不伪造 turn -------------------------------------
events.push({ type: 'tool/result', data: { toolCallId: 'call-1' }, seq: seq++ })
events.push({ type: 'step/end', data: { turn: 1, step: 1 }, seq: seq++ })
events.push({ type: 'turn/end', data: { turn: 1 }, seq: seq++ })
const flushedAtTurnEnd = delivery.flushPending('session-main')
check('case2 turn/end 不写会话', flushedAtTurnEnd === 0 && appended.length === 0, `delivered=${flushedAtTurnEnd} appended=${appended.length}`)
check('case2 队列保留', delivery.pending.length === 1, `pending=${delivery.pending.length}`)

// --- case 3: 下一个回合 step 打开且无工具调用时可以安全补投 ------------------
events.push({ type: 'turn/start', data: { turn: 2 }, seq: seq++ })
events.push({ type: 'step/start', data: { turn: 2, step: 1 }, seq: seq++ })
const flushed = delivery.flushPending('session-main')
check('case3 补投成功', flushed === 1 && appended.length === 1, `delivered=${flushed} appended=${appended.length}`)
check('case3 写进当前 turn/step', appended[0]?.data?.turn === 2 && appended[0]?.data?.step === 1, JSON.stringify(appended[0]?.data))
check('case3 内容是围栏', String(appended[0]?.data?.message?.content?.[0]?.text || '').startsWith('```dsh-voice'), '')
check('case3 队列清空', delivery.pending.length === 0, `pending=${delivery.pending.length}`)

// --- case 4: 同一段音频不会重复排队 -----------------------------------------
const r4a = delivery.deliver({ sessionId: 'session-main', audioUrl: audio(2) })
delivery.noteEvent('session-main', { type: 'tool/call', data: { callId: 'call-2', step: 1 } })
const r4b = delivery.deliver({ sessionId: 'session-main', audioUrl: audio(2) })
check('case4 重复入队被去重', delivery.pending.length === 1, `pending=${delivery.pending.length} ${r4a.mode}/${r4b.mode}`)
delivery.noteEvent('session-main', { type: 'tool/result', data: { toolCallId: 'call-2' } })
events.push({ type: 'step/end', data: { turn: 2, step: 1 }, seq: seq++ })
events.push({ type: 'turn/end', data: { turn: 2 }, seq: seq++ })
// 清理，避免影响后续断言
store.state.pendingVoice.length = 0

// --- case 5: 会话不在线时入队，之后被新会话接管 ------------------------------
const r5 = delivery.deliver({ sessionId: 'session-gone', audioUrl: audio(3), duration: 5 })
check('case5 离线会话给围栏', r5.ok && r5.mode === 'fence' && Boolean(r5.fence), JSON.stringify(r5))
check('case5 入队', delivery.pending.length === 1, `pending=${delivery.pending.length}`)

events.push({ type: 'turn/start', data: { turn: 3 }, seq: seq++ })
events.push({ type: 'step/start', data: { turn: 3, step: 1 }, seq: seq++ })
const adopted = delivery.flushPending('session-main')
const lastAppended = appended.at(-1)
check('case5 孤儿队列被接管', adopted === 1, `adopted=${adopted}`)
check('case5 使用当前会话 turn', lastAppended?.data?.turn === 3, JSON.stringify(lastAppended?.data?.turn))

// --- case 6: 从未写入未来 turn（不会出现 turn 跳号） ------------------------
const turns = [...new Set(events.filter((e) => e.type === 'turn/start').map((e) => e.data.turn))]
check('case6 turn 序列单调 +1', turns.every((t, i) => t === i + 1), turns.join(','))
const orphanMessages = appended.filter((e) => !events.some((x) => x.data?.turn === e.data?.turn && x.type === 'turn/start'))
check('case6 所有卡片都在已打开的 turn 内', orphanMessages.length === 0, `${orphanMessages.length}`)

await store.flush()
const reloaded = await new VoiceStore({ root: home }).init()
check('case7 队列可持久化', Array.isArray(reloaded.state.pendingVoice), 'missing pendingVoice')

console.log(failures.length ? `\nFAILED: ${failures.join(', ')}` : '\nALL DELIVERY CHECKS PASSED')
if (failures.length) process.exitCode = 2
