/** Real-browser smoke test through Edge CDP. Requires --remote-debugging-port=9222. */
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(ROOT, 'output', 'shots')
await mkdir(OUT, { recursive: true })

const pages = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = pages.find((item) => item.type === 'page' && item.url.includes('61999'))
if (!page) throw new Error('DSH page not found on CDP port 9222')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
let nextId = 1
const pending = new Map()
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  }
})
function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description || 'eval failed')
  return result.result?.value
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 2
}

await send('Runtime.enable')
await send('Page.enable')
await sleep(3000)

const title = await evaluate('document.title')
check(title.includes('DeepSeek'), '页面加载', title)

const hasLauncher = await evaluate('Boolean(document.querySelector(".dshv-fab"))')
check(hasLauncher, '左下角声音按钮存在')
if (!hasLauncher) throw new Error('launcher missing')

await evaluate('document.querySelector(".dshv-fab").click()')
await sleep(1200)
const panel = await evaluate(`(() => {
  const overlay = document.querySelector('.dshv-overlay')
  const text = overlay ? overlay.innerText : ''
  return {
    open: Boolean(overlay && !overlay.hidden),
    hasTabs: ['音色管理','语音设置','翻唱任务','全局状态'].every((item) => text.includes(item)),
    text: text.slice(0, 800),
    profiles: document.querySelectorAll('[data-page="profiles"] .dshv-card, [data-page="profiles"] [data-profile-id]').length,
    body: text.length,
  }
})()`)
check(panel.open, '管理面板可打开')
check(panel.hasTabs, '四个页签齐全')
check(panel.body > 40, '音色页有内容', `cards=${panel.profiles}`)

const shot = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(path.join(OUT, 'voice-panel.png'), Buffer.from(shot.data, 'base64'))
console.log('SHOT', path.join(OUT, 'voice-panel.png'))

// Exercise the tab switching.
for (const tab of ['settings', 'cover', 'status', 'profiles']) {
  await evaluate(`document.querySelector('.dshv-tab[data-tab="${tab}"]').click()`)
  await sleep(500)
  const visible = await evaluate(`(() => { const page = document.querySelector('[data-page="${tab}"]'); return Boolean(page && !page.hidden && page.innerText.length > 10) })()`)
  check(visible, `页签可切换：${tab}`)
}

// Inject a synthetic voice fence into a conversation-like code-block surface and
// verify the DOM renderer replaces it with an audio player.
const player = await evaluate(`(() => {
  document.querySelector('.dshv-overlay[hidden]') || document.querySelector('.dshv-overlay')?.setAttribute('hidden','')
  const host = document.createElement('div')
  host.id = 'dshv-test-host'
  host.innerHTML = '<div class="md-code-block"><div class="md-code-block-label">dsh-voice</div><pre><code>{"voiceReplyId":"vr_test","audioUrl":"/plugins/dsh-voice-unified/api/file/audio/test.mp3","title":"测试语音","duration":3.4,"profileName":"温柔女声","emotion":"温柔","autoplay":false}</code></pre></div>'
  document.querySelector('#root')?.appendChild(host)
  return true
})()`)
await sleep(800)
const playerState = await evaluate(`(() => {
  const wrap = document.querySelector('[data-dshv-voice-player]')
  const code = document.querySelector('#dshv-test-host .md-code-block')
  return {
    player: Boolean(wrap),
    hidden: code ? getComputedStyle(code).display === 'none' : false,
    text: wrap ? wrap.innerText.slice(0, 200) : '',
    audio: wrap ? Boolean(wrap.querySelector('audio')) : false,
  }
})()`)
check(playerState.player, '对话围栏渲染为语音播放器')
check(playerState.hidden, '原始代码块被隐藏')
check(playerState.audio, '播放器包含 audio 元素', playerState.text)
const shot2 = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(path.join(OUT, 'voice-player.png'), Buffer.from(shot2.data, 'base64'))
console.log('SHOT', path.join(OUT, 'voice-player.png'))

// Console errors are useful evidence for client-side breakage.
const errors = await evaluate(`(() => (window.__dshvErrors || []).slice(0, 5))()`)
if (errors.length) console.log('CONSOLE_ERRORS', JSON.stringify(errors))
ws.close()
console.log('UI CDP SMOKE DONE')
