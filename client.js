/**
 * dsh-voice-unified 浏览器半区（client half）。
 *
 * 部署形态与 DSH Web 客户端插件一致：用 `window.__ModuleLoader__.load({ id, factory })`
 * 注册工厂。工厂内是纯 DOM 的「声音」管理面板（音色 / 语音设置 / 翻唱任务 / 全局状态），
 * 以及对话内 dsh-voice 围栏播放器。零构建、零 JSX、零 TypeScript；React 仅用于可选的
 * 设置页区块（`settings.section`），拿不到 react 时面板依然完全可用。
 *
 * 约定见 docs/UI-CONTRACT.md：所有 HTTP 请求走 `/plugins/dsh-voice-unified/api`，
 * 失败响应的 `error` 直接作为中文提示展示；不使用 alert。
 *
 * @module dsh-voice-unified/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-voice-unified',
  factory: (require) => {
    const inject = ['slots', 'locale']

    /* ================= 常量 ================= */

    const API_BASE = '/plugins/dsh-voice-unified/api'
    const STYLE_ID = 'dshv-style'
    const BOOT_KEY = '__DSH_VOICE_BOOTED__'

    const EMOTIONS = [
      ['calm', '平静'],
      ['happy', '开心'],
      ['tender', '温柔'],
      ['serious', '认真'],
      ['comforting', '安慰'],
      ['excited', '兴奋'],
      ['sad', '难过'],
    ]

    const STAGE_LABEL = {
      queued: '排队中',
      preparing: '准备素材',
      separating: '分离人声',
      converting: '转换音色',
      mixing: '混音',
      encoding: '编码',
      delivering: '交付',
      done: '完成',
      failed: '失败',
    }

    const JOB_STATUS_LABEL = {
      queued: '排队中',
      running: '进行中',
      done: '已完成',
      failed: '失败',
    }

    const VERSION_STATUS_LABEL = {
      ready: '可用',
      training: '训练中',
      failed: '失败',
    }

    const DEFAULT_SETTINGS = {
      autoReply: false,
      intentReply: true,
      emotionIntensity: 0.7,
      speed: 1,
      volume: 1,
      crossTurnEmotion: true,
      autoplay: true,
      defaultEmotion: 'calm',
      cloudAuthorized: false,
      maxReplyChars: 600,
    }

    /* ================= 小工具 ================= */

    const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))

    const fmtTime = (sec) => {
      if (!Number.isFinite(sec) || sec < 0) return '0:00'
      const m = Math.floor(sec / 60)
      return m + ':' + String(Math.floor(sec % 60)).padStart(2, '0')
    }

    const fmtSec = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(1) + ' 秒' : '—')

    const fmtDate = (iso) => {
      if (!iso) return '—'
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return '—'
      const p = (n) => String(n).padStart(2, '0')
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    const fmtBytes = (v) => {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0) return '—'
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1024 / 1024).toFixed(1) + ' MB'
    }

    const basename = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''

    function h(tag, cls, html) {
      const el = document.createElement(tag)
      if (cls) el.className = cls
      if (html !== undefined) el.innerHTML = html
      return el
    }

    const FAB_POS_KEY = 'dsh-voice-unified.fab.pos.v1'
    const PANEL_POS_KEY = 'dsh-voice-unified.panel.pos.v1'

    function readPosition(key) {
      try {
        const value = JSON.parse(localStorage.getItem(key) || 'null')
        if (value && Number.isFinite(value.left) && Number.isFinite(value.top)) {
          return { left: value.left, top: value.top }
        }
      } catch (error) {
        /* ignore */
      }
      return null
    }

    function writePosition(key, position) {
      try {
        if (position) localStorage.setItem(key, JSON.stringify(position))
        else localStorage.removeItem(key)
      } catch (error) {
        /* ignore */
      }
    }

    function clampPosition(left, top, width, height) {
      const margin = 6
      return {
        left: clamp(left, margin, Math.max(margin, window.innerWidth - width - margin)),
        top: clamp(top, margin, Math.max(margin, window.innerHeight - height - margin)),
      }
    }

    function friendly(err) {
      if (err == null) return '操作失败，请稍后重试'
      if (typeof err === 'string') return err
      const m = err.message ? String(err.message) : '操作失败，请稍后重试'
      if (/Failed to fetch|NetworkError|Load failed|fetch failed|ECONNREFUSED/i.test(m)) {
        return '无法连接声音服务，请确认 dsh-voice-unified 已启用并重启 DSH'
      }
      if (/AbortError|timeout/i.test(m)) return '请求超时，请稍后重试'
      return m || '操作失败，请稍后重试'
    }

    const normalizeSettings = (s) => Object.assign({}, DEFAULT_SETTINGS, s && typeof s === 'object' ? s : {})

    const kindLabel = (k) => (k === 'builtin' ? '内置音色' : k === 'cloned' ? '克隆音色' : '音色')
    const profileStatusLabel = (s) => (s === 'disabled' ? '已停用' : '启用中')
    const jobStatusLabel = (s) => JOB_STATUS_LABEL[s] || s || '未知'
    const versionStatusLabel = (s) => VERSION_STATUS_LABEL[s] || s || '未知'
    const stageLabel = (s) => STAGE_LABEL[s] || s || '处理中'

    /* ================= SVG 图标 ================= */

    const icon = (paths, fill) => '<svg viewBox="0 0 24 24" aria-hidden="true" ' +
      (fill ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"') +
      '>' + paths + '</svg>'

    const I = {
      mic: icon('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 19v3"/><path d="M8 22h8"/>'),
      play: icon('<path d="M8 5v14l11-7z"/>', true),
      pause: icon('<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>', true),
      download: icon('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
      refresh: icon('<path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/>'),
      close: icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
      locate: icon('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/>'),
      plus: icon('<path d="M12 5v14"/><path d="M5 12h14"/>'),
      trash: icon('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 15h10l1-15"/>'),
    }

    /* ================= API ================= */

    async function api(path, options) {
      const opts = options || {}
      const init = {
        method: opts.method || 'GET',
        credentials: 'same-origin',
        headers: {},
      }
      if (opts.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(opts.body)
      }
      let res
      try {
        res = await fetch(API_BASE + path, init)
      } catch (error) {
        throw new Error('无法连接声音服务，请确认 dsh-voice-unified 已启用并重启 DSH')
      }
      let data = null
      try {
        const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || ''
        data = ct.indexOf('json') >= 0 ? await res.json() : JSON.parse(await res.text())
      } catch (error) {
        data = null
      }
      if (!res.ok) {
        const fallback = res.status === 404
          ? '接口不存在（404），插件前后端版本可能不一致'
          : res.status === 403
            ? '没有权限执行该操作（403）'
            : res.status === 413
              ? '文件太大，服务端拒绝接收（413）'
              : '声音服务返回错误（HTTP ' + res.status + '）'
        const err = new Error((data && data.error) || fallback)
        err.status = res.status
        err.code = data && data.code
        throw err
      }
      if (data && data.ok === false) {
        const err = new Error(data.error || '操作失败，请稍后重试')
        err.code = data.code
        throw err
      }
      return data
    }

    const enc = (v) => encodeURIComponent(String(v == null ? '' : v))

    const API = {
      health: () => api('/health'),
      profiles: () => api('/profiles'),
      profile: (id) => api('/profiles/' + enc(id)),
      versions: (id) => api('/profiles/' + enc(id) + '/versions'),
      settings: () => api('/settings'),
      saveSettings: (patch) => api('/settings', { method: 'PATCH', body: patch }),
      createProfile: (body) => api('/profiles', { method: 'POST', body }),
      updateProfile: (id, body) => api('/profiles/' + enc(id), { method: 'PATCH', body }),
      deleteProfile: (id) => api('/profiles/' + enc(id), { method: 'DELETE' }),
      setDefault: (id) => api('/profiles/' + enc(id) + '/default', { method: 'POST' }),
      addSample: (id, body) => api('/profiles/' + enc(id) + '/samples', { method: 'POST', body }),
      deleteSample: (id, sampleId) => api('/profiles/' + enc(id) + '/samples/' + enc(sampleId) + '/delete', { method: 'POST' }),
      sliceSample: (id, sampleId) => api('/profiles/' + enc(id) + '/samples/' + enc(sampleId) + '/slice', { method: 'POST' }),
      train: (id, body) => api('/profiles/' + enc(id) + '/train', { method: 'POST', body }),
      rollback: (id, versionId) => api('/profiles/' + enc(id) + '/rollback', { method: 'POST', body: { versionId } }),
      preview: (id, body) => api('/profiles/' + enc(id) + '/preview', { method: 'POST', body }),
      coverJobs: () => api('/cover/jobs?limit=30'),
      coverJob: (id) => api('/cover/jobs/' + enc(id)),
      retryJob: (id) => api('/cover/jobs/' + enc(id) + '/retry', { method: 'POST' }),
      exportJob: (id, format) => api('/cover/jobs/' + enc(id) + '/export', { method: 'POST', body: { format } }),
      musicCache: () => api('/music/cache'),
      bindCache: (directory) => api('/music/bind-cache', { method: 'POST', body: { directory } }),
      uploadCover: (body) => api('/cover/upload', { method: 'POST', body }),
      runCover: (body) => api('/cover/run', { method: 'POST', body }),
      transcribe: (audioUrl) => api('/transcribe', { method: 'POST', body: { audioUrl } }),
    }

    function readAsDataURL(file) {
      return new Promise((resolve, reject) => {
        let reader
        try {
          reader = new FileReader()
        } catch (error) {
          reject(new Error('当前浏览器不支持读取本地文件'))
          return
        }
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new Error('读取「' + (file && file.name ? file.name : '文件') + '」失败，请重试'))
        reader.readAsDataURL(file)
      })
    }

    function base64Of(dataUrl) {
      const s = String(dataUrl || '')
      const i = s.indexOf(',')
      return i >= 0 ? s.slice(i + 1) : s
    }

    /* ================= 状态 ================= */

    const state = {
      open: false,
      active: 'profiles',
      panel: null,
      overlay: null,
      fab: null,
      pages: {},
      errors: {},
      settings: normalizeSettings(null),
      settingsLoaded: false,
      settingTimers: {},
      profiles: [],
      defaultProfileId: '',
      profilesLoaded: false,
      selectedProfileId: '',
      profileDetail: null,
      profileDetailError: '',
      health: null,
      jobs: [],
      jobsLoaded: false,
      cache: { directories: [], entries: [] },
      cacheLoaded: false,
      training: null,
      confirmDelete: null,
      coverSource: { path: '', name: '' },
      coverJobId: '',
      sessionId: '',
      sessions: null,
      pollTimer: null,
      pollBusy: false,
      toastTimer: null,
      fabDragGuardUntil: 0,
      panelDrag: null,
      lastToast: '',
      preview: { url: '', label: '', playing: false, position: 0, duration: 0 },
    }

    /* ================= 样式 ================= */

    const CSS = `
.dshv-fab{position:fixed;left:18px;bottom:18px;z-index:2147482400;display:inline-flex;align-items:center;gap:7px;
  height:42px;padding:0 15px 0 12px;border-radius:21px;cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));
  background:var(--dsw-alias-bg-layer-2,#1f2023);color:var(--dsw-alias-label-primary,#f5f5f5);
  box-shadow:0 10px 28px -12px rgba(0,0,0,.5);
  font:13px/1 system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
  transition:transform .15s ease,box-shadow .15s ease}
.dshv-fab:hover{transform:translateY(-1px);box-shadow:0 14px 30px -12px rgba(0,0,0,.55)}
.dshv-fab:active{transform:scale(.97)}
.dshv-fab{touch-action:none;user-select:none}
.dshv-fab.dshv-dragging{transition:none;cursor:grabbing;transform:none}
.dshv-fab svg{width:17px;height:17px;color:var(--dsw-alias-brand-primary,currentColor)}
.dshv-fab .dshv-fab-badge{min-width:16px;height:16px;padding:0 4px;border-radius:8px;font-size:10px;line-height:16px;
  text-align:center;background:var(--dsw-alias-state-error-primary,#d54941);color:#fff;display:none}
.dshv-fab .dshv-fab-badge.on{display:inline-block}

.dshv-overlay{position:fixed;inset:0;z-index:2147482500;display:flex;align-items:center;justify-content:center;
  padding:18px;background:rgba(0,0,0,.36);animation:dshv-fade .14s ease both;
  -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}
.dshv-overlay[hidden]{display:none}
.dshv-panel{width:min(940px,100%);height:min(740px,100%);display:flex;flex-direction:column;overflow:hidden;
  border-radius:18px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));
  background:var(--dsw-alias-bg-layer-1,#191a1d);color:var(--dsw-alias-label-primary,#f2f3f5);
  box-shadow:0 32px 90px -28px rgba(0,0,0,.7);
  font:13px/1.5 system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;isolation:isolate}
.dshv-panel.dshv-floating{position:fixed;margin:0;max-width:none;max-height:none}
.dshv-panel.dshv-panel-dragging{transition:none}
.dshv-head{cursor:grab;touch-action:none;user-select:none}
.dshv-head.dshv-head-dragging{cursor:grabbing}
.dshv-panel *{box-sizing:border-box;min-width:0}
.dshv-panel button{font:inherit;color:inherit;background:none;border:none;cursor:pointer;padding:0}
.dshv-panel svg{width:15px;height:15px;display:block}
.dshv-panel input,.dshv-panel select,.dshv-panel textarea{font:inherit;color:inherit}
.dshv-panel ::-webkit-scrollbar{width:7px;height:7px}
.dshv-panel ::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:99px}

.dshv-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:13px 16px 11px;
  border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}
.dshv-brand{display:flex;align-items:center;gap:8px;font-weight:650;font-size:14px}
.dshv-brand svg{width:18px;height:18px;color:var(--dsw-alias-brand-primary,#6b8afe)}
.dshv-brand-sub{font-weight:400;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a1);margin-left:2px}
.dshv-head-actions{margin-left:auto;display:flex;align-items:center;gap:6px}
.dshv-iconbtn{width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;
  color:var(--dsw-alias-label-secondary,#b6bbc4);transition:background .15s,color .15s}
.dshv-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#fff)}

.dshv-tabs{flex:0 0 auto;display:flex;gap:2px;padding:0 12px;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}
.dshv-tab{position:relative;padding:10px 12px 9px;border-bottom:2px solid transparent;font-size:13px;
  color:var(--dsw-alias-label-tertiary,#8b93a1);transition:color .15s,border-color .15s;white-space:nowrap}
.dshv-tab:hover{color:var(--dsw-alias-label-primary,#fff)}
.dshv-tab.on{color:var(--dsw-alias-brand-primary,#6b8afe);border-bottom-color:var(--dsw-alias-brand-primary,#6b8afe);font-weight:600}
.dshv-tab .dshv-tab-count{display:inline-block;margin-left:5px;min-width:15px;height:15px;padding:0 4px;border-radius:8px;
  font-size:10px;line-height:15px;text-align:center;background:var(--dsw-alias-state-error-primary,#d54941);color:#fff;
  vertical-align:1px;display:none}
.dshv-tab .dshv-tab-count.on{display:inline-block}

.dshv-toast{flex:0 0 auto;margin:10px 16px 0;padding:8px 12px;border-radius:9px;font-size:12.5px;line-height:18px;
  border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));color:var(--dsw-alias-label-secondary,#c3c8d0);
  animation:dshv-in .18s ease both}
.dshv-toast[hidden]{display:none}
.dshv-toast.err{border-color:var(--dsw-alias-state-error-primary,#d54941);
  color:var(--dsw-alias-state-error-primary,#ff7b72);background:var(--dsw-alias-interactive-bg-hover-danger,rgba(213,73,65,.12))}
.dshv-toast.ok{border-color:var(--dsw-alias-state-success-primary,#3fb950);
  color:var(--dsw-alias-state-success-primary,#56d364);background:rgba(63,185,80,.1)}

.dshv-body{flex:1;min-height:0;overflow-y:auto;padding:14px 16px 22px;overscroll-behavior:contain}
.dshv-page[hidden]{display:none}
.dshv-err{margin:0 0 12px;padding:9px 12px;border-radius:9px;font-size:12.5px;line-height:18px;
  border:.5px solid var(--dsw-alias-state-error-primary,#d54941);
  color:var(--dsw-alias-state-error-primary,#ff7b72);background:var(--dsw-alias-interactive-bg-hover-danger,rgba(213,73,65,.1))}
.dshv-err[hidden]{display:none}

.dshv-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.dshv-toolbar .dshv-hint{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a1)}
.dshv-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:30px;padding:0 12px;
  border-radius:8px;font-size:12.5px;white-space:nowrap;text-decoration:none;transition:background .15s,border-color .15s,opacity .15s;
  border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));
  background:transparent;color:var(--dsw-alias-label-primary,#f2f3f5)}
.dshv-btn svg{width:13px;height:13px}
.dshv-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dshv-btn:active{transform:scale(.97)}
.dshv-btn:disabled{opacity:.45;cursor:not-allowed}
.dshv-btn.primary{background:var(--dsw-alias-brand-primary,#4f6ef7);border-color:transparent;
  color:var(--dsw-alias-label-primary-inverted,#fff)}
.dshv-btn.primary:hover{filter:brightness(1.08)}
.dshv-btn.danger{border-color:var(--dsw-alias-state-error-primary,#d54941);
  color:var(--dsw-alias-state-error-primary,#ff7b72)}
.dshv-btn.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(213,73,65,.12))}
.dshv-btn.sm{height:26px;padding:0 9px;font-size:12px;border-radius:7px}
.dshv-btn.ghost{border-color:transparent}
.dshv-btn.on{background:var(--dsw-alias-brand-primary,#4f6ef7);border-color:transparent;
  color:var(--dsw-alias-label-primary-inverted,#fff)}

.dshv-group{margin-bottom:12px;padding:12px 14px;border-radius:12px;
  border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.26));
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05))}
.dshv-group>h3{margin:0 0 10px;font-size:13px;font-weight:650;display:flex;align-items:center;gap:8px}
.dshv-group>h3 .dshv-muted{margin-left:auto;font-weight:400}
.dshv-sub{margin:14px 0 8px;font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:8px}
.dshv-sub .dshv-muted{margin-left:auto;font-weight:400}

.dshv-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshv-row+.dshv-row{margin-top:9px}
.dshv-field{display:flex;flex-direction:column;gap:5px;margin-bottom:9px}
.dshv-field>span{font-size:12px;color:var(--dsw-alias-label-secondary,#b6bbc4)}
.dshv-input,.dshv-select{height:32px;padding:0 10px;border-radius:8px;outline:none;
  border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));
  background:var(--dsw-alias-bg-base,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,#f2f3f5)}
.dshv-input:focus,.dshv-select:focus{border-color:var(--dsw-alias-brand-primary,#6b8afe)}
.dshv-input.grow{flex:1;min-width:160px}
.dshv-input::placeholder{color:var(--dsw-alias-label-caption,#7d8490)}
.dshv-select{cursor:pointer}

.dshv-list{display:flex;flex-direction:column;gap:9px}
.dshv-empty{padding:20px 14px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-tertiary,#8b93a1);
  border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.32));border-radius:10px}
.dshv-muted{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b93a1);font-weight:400}
.dshv-warn{font-size:11.5px;color:var(--dsw-alias-state-warn-primary,#d29922)}
.dshv-loading{display:flex;align-items:center;gap:8px;padding:14px;font-size:12.5px;color:var(--dsw-alias-label-tertiary,#8b93a1)}
.dshv-spin{display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:-1px;
  border:2px solid var(--dsw-alias-brand-primary,#6b8afe);border-top-color:transparent;
  animation:dshv-rot .8s linear infinite}

.dshv-card{padding:11px 12px;border-radius:11px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));
  background:var(--dsw-alias-bg-base,rgba(127,127,127,.04));transition:border-color .15s}
.dshv-card:hover{border-color:var(--dsw-alias-border-l4,rgba(127,127,127,.5))}
.dshv-card.on{border-color:var(--dsw-alias-brand-primary,#6b8afe);
  box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#6b8afe) inset}
.dshv-card-head{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}
.dshv-card-title{font-size:13.5px;font-weight:650;display:flex;align-items:center;gap:6px;min-width:0;overflow-wrap:anywhere}
.dshv-badge{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:9px;font-size:10.5px;font-weight:600;
  white-space:nowrap;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));
  color:var(--dsw-alias-label-secondary,#b6bbc4);background:rgba(127,127,127,.08)}
.dshv-badge.default{color:var(--dsw-alias-state-warn-primary,#d29922);
  border-color:var(--dsw-alias-state-warn-primary,#d29922);background:rgba(210,153,34,.12)}
.dshv-badge.active,.dshv-badge.done,.dshv-badge.ready{color:var(--dsw-alias-state-success-primary,#3fb950);
  border-color:var(--dsw-alias-state-success-primary,#3fb950);background:rgba(63,185,80,.1)}
.dshv-badge.disabled{color:var(--dsw-alias-label-tertiary,#8b93a1)}
.dshv-badge.failed{color:var(--dsw-alias-state-error-primary,#ff7b72);
  border-color:var(--dsw-alias-state-error-primary,#ff7b72);background:rgba(213,73,65,.1)}
.dshv-badge.running,.dshv-badge.training,.dshv-badge.queued{color:var(--dsw-alias-state-warn-primary,#d29922);
  border-color:var(--dsw-alias-state-warn-primary,#d29922);background:rgba(210,153,34,.1)}
.dshv-card-meta{margin-top:5px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b93a1);
  display:flex;gap:4px 10px;flex-wrap:wrap}
.dshv-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}
.dshv-tag{font-size:10.5px;padding:1px 7px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));
  color:var(--dsw-alias-label-secondary,#b6bbc4)}
.dshv-card-desc{margin-top:5px;font-size:12px;color:var(--dsw-alias-label-secondary,#b6bbc4);overflow-wrap:anywhere}
.dshv-card-acts{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}

.dshv-detail{margin-top:12px;border-radius:12px;padding:13px 14px;
  border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05))}
.dshv-detail-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.dshv-detail-title{font-size:14px;font-weight:650}
.dshv-form{display:grid;grid-template-columns:1fr 1fr;gap:2px 12px}
.dshv-form .dshv-field.full{grid-column:1 / -1}
.dshv-form .dshv-row{grid-column:1 / -1;margin-top:2px}
.dshv-sample{display:flex;align-items:flex-start;gap:8px;padding:7px 9px;border-radius:8px;
  border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));margin-bottom:6px}
.dshv-sample-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dshv-sample-name{font-size:12.5px;overflow-wrap:anywhere}
.dshv-sample-acts{display:flex;gap:5px;flex:0 0 auto}
.dshv-version{display:flex;align-items:flex-start;gap:8px;padding:7px 9px;border-radius:8px;
  border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));margin-bottom:6px}
.dshv-version-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dshv-version-acts{display:flex;gap:5px;flex:0 0 auto}
.dshv-newform{margin-bottom:12px;padding:12px 14px;border-radius:11px;
  border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06))}
.dshv-newform[hidden]{display:none}

.dshv-previewbar{position:sticky;bottom:0;margin-top:12px;display:flex;align-items:center;gap:9px;padding:9px 11px;
  border-radius:10px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));
  background:var(--dsw-alias-bg-layer-2,#1f2023);box-shadow:0 -6px 18px -12px rgba(0,0,0,.6)}
.dshv-previewbar[hidden]{display:none}
.dshv-previewbar .dshv-muted{margin-left:auto}

.dshv-switch{display:flex;align-items:flex-start;gap:10px;padding:9px 0;cursor:pointer;
  border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))}
.dshv-switch:last-child{border-bottom:none}
.dshv-switch input{appearance:none;-webkit-appearance:none;flex:0 0 auto;width:34px;height:19px;border-radius:10px;margin:2px 0 0;
  background:var(--dsw-alias-border-l3,rgba(127,127,127,.45));position:relative;cursor:pointer;transition:background .15s;outline:none}
.dshv-switch input::after{content:'';position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;
  background:#fff;transition:transform .15s;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.dshv-switch input:checked{background:var(--dsw-alias-brand-primary,#4f6ef7)}
.dshv-switch input:checked::after{transform:translateX(15px)}
.dshv-switch input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#6b8afe);outline-offset:2px}
.dshv-switch-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.dshv-switch-text b{font-size:12.5px;font-weight:600}
.dshv-switch-text small{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b93a1)}
.dshv-slider{display:grid;grid-template-columns:110px 1fr 54px;align-items:center;gap:10px;padding:7px 0}
.dshv-slider>span{font-size:12.5px}
.dshv-slider output{font-size:12px;text-align:right;color:var(--dsw-alias-label-secondary,#b6bbc4);font-variant-numeric:tabular-nums}
.dshv-slider input[type=range]{appearance:none;-webkit-appearance:none;height:4px;border-radius:99px;outline:none;cursor:pointer;
  background:linear-gradient(to right,var(--dsw-alias-brand-primary,#6b8afe) 0 var(--p,0%),var(--dsw-alias-border-l3,rgba(127,127,127,.4)) var(--p,0%) 100%)}
.dshv-slider input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:13px;height:13px;border-radius:50%;
  background:#fff;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#6b8afe) 40%,transparent)}
.dshv-slider input[type=range]::-moz-range-thumb{width:13px;height:13px;border:none;border-radius:50%;background:#fff}

.dshv-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px;margin-bottom:12px}
.dshv-stat{padding:10px 12px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05));display:flex;flex-direction:column;gap:3px}
.dshv-stat>span{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b93a1)}
.dshv-stat>b{font-size:14px;font-weight:650;overflow-wrap:anywhere}
.dshv-statusrow{display:flex;align-items:center;gap:9px;padding:7px 0;
  border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));font-size:12.5px}
.dshv-statusrow:last-child{border-bottom:none}
.dshv-statusrow>span:first-child{width:76px;flex:0 0 auto;color:var(--dsw-alias-label-secondary,#b6bbc4)}
.dshv-statusrow>span:last-child{margin-left:auto;color:var(--dsw-alias-label-tertiary,#8b93a1);text-align:right;overflow-wrap:anywhere}
.dshv-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-label-quaternary,#6b7280)}
.dshv-dot.ok{background:var(--dsw-alias-state-success-primary,#3fb950)}
.dshv-dot.bad{background:var(--dsw-alias-state-error-primary,#d54941)}
.dshv-dot.warn{background:var(--dsw-alias-state-warn-primary,#d29922)}

.dshv-dir{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12px;overflow-wrap:anywhere}
.dshv-dir code{flex:1;min-width:0;padding:2px 6px;border-radius:5px;font-size:11.5px;
  background:var(--dsw-alias-bg-base,rgba(127,127,127,.1));color:var(--dsw-alias-label-secondary,#b6bbc4);
  overflow-wrap:anywhere;font-family:ui-monospace,Consolas,monospace}
.dshv-cache{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:12px;
  border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))}
.dshv-cache:last-child{border-bottom:none}
.dshv-cache-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dshv-cache-name{overflow-wrap:anywhere}
.dshv-cache-path{font-size:10.5px;color:var(--dsw-alias-label-caption,#7d8490);overflow-wrap:anywhere}

.dshv-job{padding:11px 12px;border-radius:11px;margin-bottom:9px;
  border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));
  background:var(--dsw-alias-bg-base,rgba(127,127,127,.04))}
.dshv-job.failed{border-color:var(--dsw-alias-state-error-primary,#d54941)}
.dshv-job-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.dshv-job-title{font-size:13px;font-weight:650;overflow-wrap:anywhere}
.dshv-job-head .dshv-muted{margin-left:auto}
.dshv-progress{margin:8px 0 3px;height:7px;border-radius:99px;overflow:hidden;
  background:var(--dsw-alias-border-l1,rgba(127,127,127,.25));position:relative}
.dshv-progress>i{display:block;height:100%;border-radius:99px;
  background:linear-gradient(90deg,var(--dsw-alias-brand-primary,#6b8afe),var(--dsw-alias-state-business-secondary,#8b5cf6));
  transition:width .35s ease}
.dshv-job.failed .dshv-progress>i{background:var(--dsw-alias-state-error-primary,#d54941)}
.dshv-progress-text{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b93a1)}
.dshv-progress-text .dshv-muted{margin-left:auto}
.dshv-logs{margin:8px 0 0;max-height:96px;overflow:auto;padding:7px 9px;border-radius:7px;
  background:var(--dsw-alias-bg-base,rgba(0,0,0,.18));font:11px/1.5 ui-monospace,Consolas,monospace;
  color:var(--dsw-alias-label-secondary,#b6bbc4);white-space:pre-wrap;overflow-wrap:anywhere}
.dshv-job-error{margin-top:7px;padding:6px 9px;border-radius:7px;font-size:12px;
  color:var(--dsw-alias-state-error-primary,#ff7b72);background:rgba(213,73,65,.1);
  border:.5px solid var(--dsw-alias-state-error-primary,#d54941);overflow-wrap:anywhere}
.dshv-job-audio{margin-top:8px;width:100%;height:32px}
.dshv-job-acts{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}

.dshv-note{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8b93a1)}

/* 对话内语音播放器：用 currentColor 半透明着色，同时适配 DSH 深色/浅色主题 */
.dshv-vplayer{--dshv-vp-accent:var(--dsw-alias-brand-primary,#6b8afe);
  display:flex;align-items:center;gap:10px;max-width:560px;margin:8px 0;padding:9px 11px;
  border-radius:12px;border:1px solid rgba(127,127,127,.3);border-color:color-mix(in srgb,currentColor 18%,transparent);
  background:rgba(127,127,127,.07);background:color-mix(in srgb,currentColor 5%,transparent);
  color:inherit;font:13px/1.4 system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
  animation:dshv-in .22s ease both}
.dshv-vplayer *{box-sizing:border-box;min-width:0}
.dshv-vplayer button{font:inherit;color:inherit;background:none;border:none;cursor:pointer;padding:0}
.dshv-vplayer svg{width:15px;height:15px;display:block}
.dshv-vp-icon{flex:0 0 auto;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  background:color-mix(in srgb,currentColor 10%,transparent);color:var(--dshv-vp-accent,#6b8afe)}
.dshv-vp-icon svg{width:17px;height:17px}
.dshv-vp-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}
.dshv-vp-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshv-vp-title{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshv-vp-chip{font-size:10px;line-height:16px;padding:0 6px;border-radius:8px;
  border:1px solid color-mix(in srgb,currentColor 22%,transparent);
  color:color-mix(in srgb,currentColor 72%,transparent);white-space:nowrap}
.dshv-vp-time{margin-left:auto;font-size:10.5px;color:color-mix(in srgb,currentColor 60%,transparent);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.dshv-vp-seek{appearance:none;-webkit-appearance:none;width:100%;height:3px;border-radius:99px;outline:none;cursor:pointer;
  background:linear-gradient(to right,var(--dshv-vp-accent,#6b8afe) 0 var(--p,0%),color-mix(in srgb,currentColor 22%,transparent) var(--p,0%) 100%)}
.dshv-vp-seek::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:10px;border-radius:50%;background:currentColor}
.dshv-vp-seek::-moz-range-thumb{width:10px;height:10px;border:none;border-radius:50%;background:currentColor}
.dshv-vp-acts{flex:0 0 auto;display:flex;align-items:center;gap:3px}
.dshv-vp-btn{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  color:color-mix(in srgb,currentColor 75%,transparent);transition:background .15s}
.dshv-vp-btn:hover{background:color-mix(in srgb,currentColor 12%,transparent);color:currentColor}
.dshv-vp-btn.main{width:32px;height:32px;background:var(--dshv-vp-accent,#6b8afe);color:#fff}
.dshv-vp-btn.main:hover{filter:brightness(1.08);background:var(--dshv-vp-accent,#6b8afe)}
.dshv-vp-err{font-size:11px;color:var(--dsw-alias-state-error-primary,#d54941)}
.dshv-vplayer audio{display:none}

/* 微信式语音消息气泡 */
.dshv-wx-wrap{display:flex;flex-direction:column;align-items:flex-start;gap:3px;margin:4px 0;max-width:280px}
.dshv-wx-voice{position:relative;display:inline-flex;align-items:center;gap:9px;min-height:40px;max-width:260px;
  padding:8px 13px 8px 11px;border:none;border-radius:18px;background:#95ec69;color:#101010;
  font:14px/1.3 system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
  cursor:pointer;text-align:left;box-shadow:0 1px 2px rgba(0,0,0,.10);
  transition:filter .15s ease,transform .15s ease;animation:dshv-in .2s ease both}
.dshv-wx-voice::before{content:'';position:absolute;left:-6px;top:14px;width:0;height:0;
  border-top:6px solid transparent;border-bottom:6px solid transparent;border-right:7px solid #95ec69}
.dshv-wx-voice:hover{filter:brightness(.97)}
.dshv-wx-voice:active{transform:scale(.98)}
.dshv-wx-voice .dshv-wx-icon{width:22px;height:22px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;color:#101010}
.dshv-wx-voice .dshv-wx-icon svg{width:20px;height:20px;display:block}
.dshv-wx-bars{display:inline-flex;align-items:center;gap:3px;height:18px;flex:0 0 auto}
.dshv-wx-bars i{display:block;width:3px;border-radius:2px;background:currentColor;opacity:.55;height:7px}
.dshv-wx-bars i:nth-child(2){height:13px}
.dshv-wx-bars i:nth-child(3){height:9px}
.dshv-wx-bars i:nth-child(4){height:15px}
.dshv-wx-bars i:nth-child(5){height:8px}
.dshv-wx-voice.is-playing .dshv-wx-bars i{animation:dshv-wx-wave .75s ease-in-out infinite;opacity:.8}
.dshv-wx-voice.is-playing .dshv-wx-bars i:nth-child(2){animation-delay:.12s}
.dshv-wx-voice.is-playing .dshv-wx-bars i:nth-child(3){animation-delay:.24s}
.dshv-wx-voice.is-playing .dshv-wx-bars i:nth-child(4){animation-delay:.36s}
.dshv-wx-voice.is-playing .dshv-wx-bars i:nth-child(5){animation-delay:.48s}
.dshv-wx-duration{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;margin-left:1px}
.dshv-wx-voice audio{display:none}
.dshv-wx-err{font-size:11px;line-height:15px;color:var(--dsw-alias-state-error-primary,#d54941);padding-left:4px}
@keyframes dshv-wx-wave{0%,100%{transform:scaleY(.6)}50%{transform:scaleY(1.25)}}

/* 右键转文字浮层 */
.dshv-transcript{position:fixed;z-index:2147482600;width:min(340px,calc(100vw - 24px));max-height:min(420px,70vh);
  display:flex;flex-direction:column;border-radius:14px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);
  background:var(--dsw-alias-bg-layer-1,#191a1d);color:var(--dsw-alias-label-primary,#f2f3f5);
  box-shadow:0 24px 70px -24px rgba(0,0,0,.75);padding:12px 13px;font:13px/1.55 system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}
.dshv-transcript-head{display:flex;align-items:center;gap:8px;font-weight:600;font-size:12.5px}
.dshv-transcript-head span{flex:1;min-width:0}
.dshv-transcript-head button{font:inherit;color:var(--dsw-alias-label-secondary,#b6bbc4);background:none;border:none;cursor:pointer;padding:2px 4px;border-radius:6px}
.dshv-transcript-head button:hover{background:color-mix(in srgb,currentColor 12%,transparent);color:currentColor}
.dshv-transcript-body{margin-top:9px;overflow:auto;white-space:pre-wrap;word-break:break-word;
  color:var(--dsw-alias-label-primary,#f2f3f5);font-size:13px;line-height:21px;user-select:text}
.dshv-transcript-meta{margin-top:8px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b93a1)}
.dshv-transcript-actions{margin-top:10px;display:flex;justify-content:flex-end;gap:8px}
.dshv-transcript-actions button{font:inherit;font-size:12px;height:28px;padding:0 12px;border-radius:8px;cursor:pointer;
  border:1px solid color-mix(in srgb,currentColor 20%,transparent);background:transparent;color:inherit}
.dshv-transcript-actions button:hover{background:color-mix(in srgb,currentColor 10%,transparent)}

@media (max-width:680px){
  .dshv-overlay{padding:0;align-items:stretch;justify-content:stretch}
  .dshv-panel{width:100%;height:100dvh;max-height:100dvh;border-radius:0;border:none}
  .dshv-form{grid-template-columns:1fr}
  .dshv-slider{grid-template-columns:88px 1fr 46px}
  .dshv-fab{left:12px;bottom:12px}
}
@media (prefers-reduced-motion:reduce){
  .dshv-overlay,.dshv-toast,.dshv-vplayer{animation:none}
  .dshv-spin{animation:none}
}
@keyframes dshv-fade{from{opacity:0}to{opacity:1}}
@keyframes dshv-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
@keyframes dshv-rot{to{transform:rotate(360deg)}}
`

    /* ================= React（仅设置页区块） ================= */

    let ReactLib = null
    let ReactTried = false

    function getReact() {
      if (ReactLib) return ReactLib
      try {
        ReactLib = require('react')
        ReactTried = true
      } catch (error) {
        // The client module system may not expose React at plugin-apply time;
        // retry on the next settings render instead of caching a failure.
        ReactLib = null
      }
      return ReactLib
    }

    const sectionStyles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '560px' },
      text: { margin: 0, fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary,#6b7280)' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      btn: {
        font: 'inherit', fontSize: '13px', height: '32px', padding: '0 14px', borderRadius: '8px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', background: 'transparent', color: 'inherit',
      },
      btnPrimary: {
        font: 'inherit', fontSize: '13px', height: '32px', padding: '0 14px', borderRadius: '8px', cursor: 'pointer',
        border: '1px solid transparent', background: 'var(--dsw-alias-brand-primary,#4f6ef7)',
        color: 'var(--dsw-alias-label-primary-inverted,#fff)',
      },
    }

    /** 设置页「声音」区块：只做入口；真正的管理界面在纯 DOM 面板里。 */
    function VoiceSettingsSection() {
      const React = getReact()
      if (!React) return null
      const e = React.createElement
      return e('div', { style: sectionStyles.wrap },
        e('p', { style: sectionStyles.text }, '语音回复、音色克隆、翻唱任务与全局状态集中在「声音」管理面板中。'),
        e('div', { style: sectionStyles.row },
          e('button', { type: 'button', style: sectionStyles.btnPrimary, onClick: () => openPanel('profiles') }, '打开声音管理面板'),
          e('button', { type: 'button', style: sectionStyles.btn, onClick: () => openPanel('settings') }, '语音设置'),
        ),
        e('p', { style: sectionStyles.text }, '提示：也可以按 Ctrl+Shift+V 直接打开同一个管理面板。'),
      )
    }

    /* ================= 面板基础 ================= */

    function toast(message, kind) {
      const msg = String(message || '')
      if (!msg) return
      state.lastToast = msg
      if (!state.panel) return
      const box = state.panel.querySelector('[data-role=toast]')
      if (!box) return
      box.textContent = msg
      box.className = 'dshv-toast' + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : '')
      box.hidden = false
      clearTimeout(state.toastTimer)
      state.toastTimer = setTimeout(() => {
        if (box) box.hidden = true
      }, kind === 'err' ? 6000 : 2600)
    }

    function setPageError(page, message) {
      state.errors[page] = message || ''
      const el = state.pages[page] && state.pages[page].querySelector('[data-role=page-error]')
      if (!el) return
      el.textContent = message || ''
      el.hidden = !message
    }

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      ;(document.head || document.documentElement).appendChild(style)
    }

    function applyFabPosition(fab) {
      const saved = readPosition(FAB_POS_KEY)
      if (!saved) return
      const rect = fab.getBoundingClientRect()
      const pos = clampPosition(saved.left, saved.top, rect.width || fab.offsetWidth, rect.height || fab.offsetHeight)
      fab.style.left = pos.left + 'px'
      fab.style.top = pos.top + 'px'
      fab.style.right = 'auto'
      fab.style.bottom = 'auto'
    }

    function installFabDrag(fab) {
      let drag = null
      const finish = (event) => {
        if (!drag) return
        const current = drag
        drag = null
        try { fab.releasePointerCapture?.(current.pointerId) } catch (error) { /* ignore */ }
        fab.classList.remove('dshv-dragging')
        if (current.moved) {
          state.fabDragGuardUntil = Date.now() + 320
          writePosition(FAB_POS_KEY, {
            left: parseFloat(fab.style.left) || fab.getBoundingClientRect().left,
            top: parseFloat(fab.style.top) || fab.getBoundingClientRect().top,
          })
          if (event?.cancelable) event.preventDefault()
        }
      }
      fab.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) return
        const rect = fab.getBoundingClientRect()
        drag = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          left: rect.left,
          top: rect.top,
          moved: false,
        }
        try { fab.setPointerCapture?.(event.pointerId) } catch (error) { /* ignore */ }
      })
      fab.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        if (!drag.moved && Math.hypot(dx, dy) < 4) return
        drag.moved = true
        fab.classList.add('dshv-dragging')
        const pos = clampPosition(drag.left + dx, drag.top + dy, fab.offsetWidth, fab.offsetHeight)
        fab.style.left = pos.left + 'px'
        fab.style.top = pos.top + 'px'
        fab.style.right = 'auto'
        fab.style.bottom = 'auto'
        if (event.cancelable) event.preventDefault()
      })
      fab.addEventListener('pointerup', finish)
      fab.addEventListener('pointercancel', finish)
      fab.addEventListener('lostpointercapture', finish)
    }

    function applyPanelPosition(panel) {
      if (!panel) return
      if (window.innerWidth < 720) {
        panel.classList.remove('dshv-floating')
        panel.style.left = ''
        panel.style.top = ''
        return
      }
      const saved = readPosition(PANEL_POS_KEY)
      if (!saved) return
      panel.classList.add('dshv-floating')
      const pos = clampPosition(saved.left, saved.top, panel.offsetWidth, panel.offsetHeight)
      panel.style.left = pos.left + 'px'
      panel.style.top = pos.top + 'px'
    }

    function installPanelDrag(panel) {
      const head = panel.querySelector('.dshv-head')
      if (!head) return
      let drag = null
      const finish = () => {
        if (!drag) return
        const current = drag
        drag = null
        try { head.releasePointerCapture?.(current.pointerId) } catch (error) { /* ignore */ }
        head.classList.remove('dshv-head-dragging')
        panel.classList.remove('dshv-panel-dragging')
        if (current.moved && panel.classList.contains('dshv-floating')) {
          writePosition(PANEL_POS_KEY, {
            left: parseFloat(panel.style.left) || panel.getBoundingClientRect().left,
            top: parseFloat(panel.style.top) || panel.getBoundingClientRect().top,
          })
        }
      }
      head.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) return
        if (event.target instanceof Element && event.target.closest('button')) return
        if (window.innerWidth < 720) return
        const rect = panel.getBoundingClientRect()
        if (!panel.classList.contains('dshv-floating')) {
          panel.classList.add('dshv-floating')
          panel.style.left = rect.left + 'px'
          panel.style.top = rect.top + 'px'
        }
        drag = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          left: rect.left,
          top: rect.top,
          moved: false,
        }
        head.classList.add('dshv-head-dragging')
        panel.classList.add('dshv-panel-dragging')
        try { head.setPointerCapture?.(event.pointerId) } catch (error) { /* ignore */ }
      })
      head.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        if (!drag.moved && Math.hypot(dx, dy) < 4) return
        drag.moved = true
        const pos = clampPosition(drag.left + dx, drag.top + dy, panel.offsetWidth, panel.offsetHeight)
        panel.style.left = pos.left + 'px'
        panel.style.top = pos.top + 'px'
        if (event.cancelable) event.preventDefault()
      })
      head.addEventListener('pointerup', finish)
      head.addEventListener('pointercancel', finish)
      head.addEventListener('lostpointercapture', finish)
      head.addEventListener('dblclick', (event) => {
        if (event.target instanceof Element && event.target.closest('button')) return
        writePosition(PANEL_POS_KEY, null)
        panel.classList.remove('dshv-floating')
        panel.style.left = ''
        panel.style.top = ''
      })
    }

    function resetFloatingPositions() {
      writePosition(FAB_POS_KEY, null)
      writePosition(PANEL_POS_KEY, null)
      if (state.fab) {
        state.fab.style.left = ''
        state.fab.style.top = ''
        state.fab.style.right = ''
        state.fab.style.bottom = ''
      }
      if (state.panel) {
        state.panel.classList.remove('dshv-floating')
        state.panel.style.left = ''
        state.panel.style.top = ''
      }
    }

    function ensurePanel() {
      if (state.overlay) return
      ensureStyles()

      const overlay = h('div', 'dshv-overlay')
      overlay.hidden = true
      overlay.innerHTML = `
<div class="dshv-panel" role="dialog" aria-modal="true" aria-label="声音管理">
  <div class="dshv-head">
    <div class="dshv-brand">${I.mic}<span>声音</span><span class="dshv-brand-sub">dsh-voice-unified</span></div>
    <div class="dshv-head-actions">
      <button type="button" class="dshv-iconbtn" data-act="reset-position" title="恢复默认位置（也可双击标题栏）">${I.locate}</button>
      <button type="button" class="dshv-iconbtn" data-act="refresh" title="刷新当前页">${I.refresh}</button>
      <button type="button" class="dshv-iconbtn" data-act="close" title="关闭">${I.close}</button>
    </div>
  </div>
  <div class="dshv-tabs">
    <button type="button" class="dshv-tab" data-tab="profiles">音色管理</button>
    <button type="button" class="dshv-tab" data-tab="settings">语音设置</button>
    <button type="button" class="dshv-tab" data-tab="cover">翻唱任务<span class="dshv-tab-count" data-role="cover-tab-count"></span></button>
    <button type="button" class="dshv-tab" data-tab="status">全局状态</button>
  </div>
  <div class="dshv-toast" data-role="toast" hidden></div>
  <div class="dshv-body">
    <section class="dshv-page" data-page="profiles" hidden></section>
    <section class="dshv-page" data-page="settings" hidden></section>
    <section class="dshv-page" data-page="cover" hidden></section>
    <section class="dshv-page" data-page="status" hidden></section>
  </div>
</div>`

      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closePanel()
      })

      const panel = overlay.querySelector('.dshv-panel')

      panel.addEventListener('click', (event) => {
        const target = event.target
        if (!(target instanceof Element)) return

        const tab = target.closest('[data-tab]')
        if (tab) {
          switchTab(tab.getAttribute('data-tab'))
          return
        }
        const btn = target.closest('[data-act]')
        if (!btn || btn.disabled) return
        const act = btn.getAttribute('data-act')
        if (act === 'close') {
          closePanel()
          return
        }
        if (act === 'reset-position') {
          resetFloatingPositions()
          toast('已恢复默认位置；双击标题栏也可重置面板位置。', 'ok')
          return
        }
        void handleAction(act, btn).catch((error) => {
          const message = friendly(error)
          setPageError(state.active, message)
          toast(message, 'err')
        })
      })

      panel.addEventListener('input', (event) => {
        const target = event.target
        if (!(target instanceof Element)) return
        if (target.hasAttribute('data-setting')) onSettingInput(target)
        else if (target.hasAttribute('data-cover-song')) {
          updateCoverReadout()
        }
      })

      panel.addEventListener('change', (event) => {
        const target = event.target
        if (!(target instanceof Element)) return
        if (target.hasAttribute('data-setting')) {
          onSettingInput(target)
          return
        }
        if (target.getAttribute('data-role') === 'sample-input') {
          const picked = target.files ? Array.from(target.files) : []
          target.value = ''
          const id = state.selectedProfileId
          if (picked.length && id) {
            void uploadSamples(id, picked).catch((error) => {
              setPageError('profiles', friendly(error))
              toast(friendly(error), 'err')
            })
          }
          return
        }
        if (target.getAttribute('data-role') === 'cover-file-input') {
          const picked = target.files ? Array.from(target.files) : []
          target.value = ''
          if (picked.length) {
            void uploadCoverFile(picked[0]).catch((error) => {
              setPageError('cover', friendly(error))
              toast(friendly(error), 'err')
            })
          }
          return
        }
        if (target.hasAttribute('data-cover-deliver') || target.hasAttribute('data-cover-format') || target.hasAttribute('data-cover-profile')) {
          updateCoverReadout()
        }
      })

      document.body.appendChild(overlay)
      state.overlay = overlay
      state.panel = panel
      installPanelDrag(panel)

      buildPage('profiles')
      buildPage('settings')
      buildPage('cover')
      buildPage('status')
      switchTab(state.active, { skipRefresh: true })

      state.badgeTimer = setInterval(updateBadges, 3000)
      window.addEventListener('resize', () => {
        if (state.open) applyPanelPosition(state.panel)
      })
    }

    function openPanel(tab) {
      ensurePanel()
      if (!state.overlay) return
      state.open = true
      state.overlay.hidden = false
      applyPanelPosition(state.panel)
      switchTab(tab || state.active)
      startPolling()
    }

    function closePanel() {
      state.open = false
      if (state.overlay) state.overlay.hidden = true
      stopPolling()
      try {
        if (previewAudio) previewAudio.pause()
      } catch (error) {
        /* ignore */
      }
    }

    function switchTab(tab, opts) {
      if (!['profiles', 'settings', 'cover', 'status'].includes(tab)) tab = 'profiles'
      state.active = tab
      if (!state.panel) return
      state.panel.querySelectorAll('.dshv-tab').forEach((el) => {
        el.classList.toggle('on', el.getAttribute('data-tab') === tab)
      })
      state.panel.querySelectorAll('[data-page]').forEach((el) => {
        el.hidden = el.getAttribute('data-page') !== tab
      })
      if (!opts || !opts.skipRefresh) void refreshActive()
      updateBadges()
    }

    function updateBadges() {
      if (!state.panel) return
      const running = state.jobs.filter((j) => j.status === 'queued' || j.status === 'running').length
      const coverBadge = state.panel.querySelector('[data-role=cover-tab-count]')
      if (coverBadge) {
        coverBadge.textContent = String(running)
        coverBadge.classList.toggle('on', running > 0)
      }
    }

    /* ================= 数据加载 ================= */

    async function loadSettings() {
      const res = await API.settings()
      state.settings = normalizeSettings(res && res.settings)
      state.settingsLoaded = true
      if (state.open && state.active === 'settings') syncSettingsForm()
      return state.settings
    }

    async function loadProfiles() {
      const res = await API.profiles()
      state.profiles = Array.isArray(res && res.profiles) ? res.profiles : []
      state.defaultProfileId = (res && res.defaultProfileId) || ''
      state.profilesLoaded = true
      if (state.selectedProfileId && !state.profiles.some((p) => p.id === state.selectedProfileId)) {
        state.selectedProfileId = ''
        state.profileDetail = null
      }
      if (state.open && state.active === 'profiles') renderProfilesPage()
      if (state.open && state.active === 'cover') renderCoverProfileOptions()
      if (state.open && state.active === 'status') renderStatusPage()
      return state.profiles
    }

    async function loadHealth() {
      state.health = await API.health()
      if (state.open && state.active === 'status') renderStatusPage()
      return state.health
    }

    async function loadJobs() {
      const res = await API.coverJobs()
      state.jobs = Array.isArray(res && res.jobs) ? res.jobs : []
      state.jobsLoaded = true
      if (state.open && state.active === 'cover') renderJobs()
      updateBadges()
      return state.jobs
    }

    async function loadCache() {
      const res = await API.musicCache()
      state.cache = {
        directories: Array.isArray(res && res.directories) ? res.directories : [],
        entries: Array.isArray(res && res.entries) ? res.entries : [],
      }
      state.cacheLoaded = true
      if (state.open && state.active === 'cover') renderCache()
      return state.cache
    }

    async function loadProfileDetail(id, force) {
      if (!id) return null
      try {
        const res = await API.profile(id)
        if (state.selectedProfileId !== id) return null
        state.profileDetail = (res && res.profile) || null
        state.profileDetailError = ''
        checkTraining(state.profileDetail)
        if (state.open && state.active === 'profiles') renderProfileDetail(Boolean(force))
        return state.profileDetail
      } catch (error) {
        if (state.selectedProfileId === id) {
          state.profileDetailError = friendly(error)
          if (state.open && state.active === 'profiles') renderProfileDetail(true)
        }
        throw error
      }
    }

    async function refreshActive(force) {
      if (!state.open) return
      const page = state.active
      setPageError(page, '')
      try {
        if (page === 'profiles') {
          await loadProfiles()
          if (state.selectedProfileId) await loadProfileDetail(state.selectedProfileId, force)
        } else if (page === 'settings') {
          await loadSettings()
        } else if (page === 'cover') {
          await Promise.all([loadCache(), loadJobs()])
          if (!state.profilesLoaded) await loadProfiles()
          renderCoverProfileOptions()
        } else if (page === 'status') {
          await Promise.all([loadHealth(), loadProfiles()])
          renderStatusPage()
        }
      } catch (error) {
        const message = friendly(error)
        setPageError(page, message)
      }
    }

    function startPolling() {
      stopPolling()
      state.pollTimer = setInterval(() => {
        if (!state.open || state.pollBusy) return
        state.pollBusy = true
        Promise.resolve()
          .then(() => refreshActive(false))
          .catch(() => {})
          .finally(() => { state.pollBusy = false })
      }, 1500)
    }

    function stopPolling() {
      if (state.pollTimer) {
        clearInterval(state.pollTimer)
        state.pollTimer = null
      }
    }

    /* ================= 音色页 ================= */

    function buildProfilesPage() {
      const page = state.pages.profiles
      page.innerHTML = `
<div class="dshv-err" data-role="page-error" hidden></div>
<div class="dshv-toolbar">
  <button type="button" class="dshv-btn primary" data-act="new-profile">${I.plus}新建音色</button>
  <button type="button" class="dshv-btn" data-act="reload-profiles">${I.refresh}刷新</button>
  <span class="dshv-hint" data-role="profiles-hint"></span>
</div>
<form class="dshv-newform" data-role="new-form" hidden autocomplete="off">
  <div class="dshv-sub" style="margin-top:0">新建音色</div>
  <div class="dshv-form">
    <label class="dshv-field"><span>名称 *</span><input class="dshv-input" data-new="name" placeholder="例如：温柔女声"></label>
    <label class="dshv-field"><span>类型</span>
      <select class="dshv-select" data-new="kind">
        <option value="cloned">克隆音色</option>
        <option value="builtin">内置变声</option>
      </select>
    </label>
    <label class="dshv-field full"><span>描述</span><input class="dshv-input" data-new="description" placeholder="这个音色听起来怎样"></label>
    <label class="dshv-field"><span>标签（逗号分隔）</span><input class="dshv-input" data-new="tags" placeholder="温柔, 女声"></label>
    <label class="dshv-field"><span>基础音色</span>
      <input class="dshv-input" data-new="baseVoice" list="dshv-voice-list" placeholder="Microsoft Huihui Desktop">
    </label>
    <div class="dshv-row">
      <button type="button" class="dshv-btn primary" data-act="create-profile">创建</button>
      <button type="button" class="dshv-btn" data-act="cancel-new">取消</button>
      <span class="dshv-muted">创建后上传 2~4 段清晰语音再训练。</span>
    </div>
  </div>
  <datalist id="dshv-voice-list">
    <option value="Microsoft Huihui Desktop"></option>
    <option value="Microsoft Zira Desktop"></option>
  </datalist>
</form>
<div class="dshv-list" data-role="profile-list"><div class="dshv-loading"><i class="dshv-spin"></i>正在加载音色…</div></div>
<div class="dshv-detail" data-role="profile-detail"></div>
<div class="dshv-previewbar" data-role="preview-bar" hidden>
  <button type="button" class="dshv-btn sm" data-act="preview-toggle">播放</button>
  <button type="button" class="dshv-btn sm ghost" data-act="preview-stop">停止</button>
  <span data-role="preview-label" class="dshv-muted">试听</span>
  <span data-role="preview-time" class="dshv-muted" style="margin-left:auto">0:00</span>
</div>`
    }

    function renderProfilesPage() {
      const page = state.pages.profiles
      if (!page) return
      const hint = page.querySelector('[data-role=profiles-hint]')
      if (hint) hint.textContent = state.profilesLoaded ? '共 ' + state.profiles.length + ' 个音色' : ''

      const list = page.querySelector('[data-role=profile-list]')
      if (list) {
        if (!state.profilesLoaded) {
          list.innerHTML = '<div class="dshv-loading"><i class="dshv-spin"></i>正在加载音色…</div>'
        } else if (!state.profiles.length) {
          list.innerHTML = '<div class="dshv-empty">还没有音色。点击左上角「新建音色」创建，或先使用内置音色。</div>'
        } else {
          list.innerHTML = state.profiles.map((p) => profileCardHtml(p)).join('')
        }
      }
      renderProfileDetail(false)
      renderPreviewBar()
    }

    function profileCardHtml(p) {
      const tags = Array.isArray(p.tags) ? p.tags : []
      const isDefault = p.isDefault === true || (state.defaultProfileId && p.id === state.defaultProfileId)
      const selected = state.selectedProfileId === p.id
      const version = p.currentVersion || null
      const meta = []
      meta.push('样本 ' + (p.sampleCount != null ? p.sampleCount : 0))
      meta.push('总时长 ' + fmtSec(p.totalDuration))
      meta.push('最近训练 ' + fmtDate(p.lastTrainedAt))
      if (version) meta.push('版本 ' + (version.label || version.id || '—'))
      if (version && version.quality != null) meta.push('质量 ' + version.quality)
      return `
<article class="dshv-card${selected ? ' on' : ''}" data-id="${esc(p.id)}">
  <div class="dshv-card-head">
    <div class="dshv-card-title">${esc(p.name || '未命名音色')}
      ${isDefault ? '<span class="dshv-badge default">默认</span>' : ''}
      <span class="dshv-badge ${esc(p.status || 'active')}">${esc(profileStatusLabel(p.status))}</span>
      <span class="dshv-badge">${esc(kindLabel(p.kind))}</span>
    </div>
  </div>
  <div class="dshv-card-meta">${meta.map((m) => '<span>' + esc(m) + '</span>').join('')}</div>
  ${p.baseVoice ? '<div class="dshv-card-meta"><span>基础音色：' + esc(p.baseVoice) + '</span></div>' : ''}
  ${tags.length ? '<div class="dshv-tags">' + tags.map((t) => '<span class="dshv-tag">' + esc(t) + '</span>').join('') + '</div>' : ''}
  ${p.description ? '<div class="dshv-card-desc">' + esc(p.description) + '</div>' : ''}
  <div class="dshv-card-acts">
    <button type="button" class="dshv-btn sm" data-act="select-profile" data-id="${esc(p.id)}">管理 / 样本</button>
    <button type="button" class="dshv-btn sm" data-act="rename-profile" data-id="${esc(p.id)}">重命名</button>
    ${isDefault ? '' : '<button type="button" class="dshv-btn sm" data-act="set-default" data-id="' + esc(p.id) + '">设为默认</button>'}
    <button type="button" class="dshv-btn sm" data-act="toggle-status" data-id="${esc(p.id)}" data-status="${esc(p.status || 'active')}">${p.status === 'disabled' ? '启用' : '停用'}</button>
    <button type="button" class="dshv-btn sm" data-act="preview" data-id="${esc(p.id)}">试听</button>
    <button type="button" class="dshv-btn sm danger" data-act="delete-profile" data-id="${esc(p.id)}">删除</button>
  </div>
</article>`
    }

    function renderProfileDetail(force) {
      const page = state.pages.profiles
      if (!page) return
      const box = page.querySelector('[data-role=profile-detail]')
      if (!box) return
      if (!state.selectedProfileId) {
        box.innerHTML = '<div class="dshv-empty">选择上方任意音色，查看样本、训练与版本历史。</div>'
        return
      }
      if (state.profileDetailError) {
        box.innerHTML = '<div class="dshv-err">' + esc(state.profileDetailError) +
          ' <button type="button" class="dshv-btn sm" data-act="reload-detail">重试</button></div>'
        return
      }
      const p = state.profileDetail
      if (!p || p.id !== state.selectedProfileId) {
        box.innerHTML = '<div class="dshv-loading"><i class="dshv-spin"></i>正在加载音色详情…</div>'
        return
      }
      if (!force && box.contains(document.activeElement)) return

      const samples = Array.isArray(p.samples) ? p.samples : []
      // 服务端版本按训练顺序追加（旧→新），展示时倒序，最新版本在最上面。
      const versions = (Array.isArray(p.versions) ? p.versions : []).slice().reverse()
      const defaultEmotion = state.settings && state.settings.defaultEmotion ? state.settings.defaultEmotion : 'calm'
      const localTraining = Boolean(state.training && state.training.profileId === p.id)
      const serverTraining = p.training && p.training.status === 'training' ? p.training : null
      const training = Boolean(localTraining || serverTraining)
      const trainProgress = serverTraining && Number.isFinite(Number(serverTraining.progress))
        ? Math.round(Number(serverTraining.progress))
        : null
      const trainError = p.training && p.training.status === 'failed' ? String(p.training.error || '') : ''

      const samplesHtml = samples.length ? samples.map((s) => {
        const issues = Array.isArray(s.issues) ? s.issues : []
        return `
<div class="dshv-sample" data-sample-id="${esc(s.id)}">
  <div class="dshv-sample-main">
    <span class="dshv-sample-name">${esc(s.filename || s.id || '样本')}</span>
    <span class="dshv-muted">${fmtSec(s.duration)} · 质量 ${s.quality != null ? esc(s.quality) : '—'} · ${esc(fmtDate(s.createdAt))}</span>
    ${issues.length ? '<span class="dshv-warn">' + esc(issues.join('；')) + '</span>' : ''}
  </div>
  <div class="dshv-sample-acts">
    <button type="button" class="dshv-btn sm" data-act="slice-sample" data-id="${esc(s.id)}">切片</button>
    <button type="button" class="dshv-btn sm danger" data-act="delete-sample" data-id="${esc(s.id)}">删除</button>
  </div>
</div>`
      }).join('') : '<div class="dshv-empty">还没有样本。建议上传 2~4 段 3~10 秒的清晰语音。</div>'

      const versionsHtml = versions.length ? versions.map((v) => {
        const metrics = v.metrics || {}
        const isCurrent = v.isCurrent === true || Boolean(p.currentVersion && p.currentVersion.id === v.id)
        return `
<div class="dshv-version">
  <div class="dshv-version-main">
    <span><b>${esc(v.label || v.id || '版本')}</b> ${isCurrent ? '<span class="dshv-badge default">当前</span>' : ''} <span class="dshv-badge ${esc(v.status || 'ready')}">${esc(versionStatusLabel(v.status))}</span></span>
    <span class="dshv-muted">${esc(fmtDate(v.createdAt))} · ${v.sampleCount != null ? esc(v.sampleCount) : 0} 个样本${metrics.similarity != null ? ' · 相似度 ' + esc(metrics.similarity) : ''}${metrics.quality != null ? ' · 质量 ' + esc(metrics.quality) : ''}</span>
    ${v.note ? '<span class="dshv-muted">' + esc(v.note) + '</span>' : ''}
  </div>
  <div class="dshv-version-acts">
    ${v.previewAudioUrl ? '<button type="button" class="dshv-btn sm" data-act="preview-version" data-id="' + esc(v.id) + '" data-url="' + esc(v.previewAudioUrl) + '">试听</button>' : ''}
    <button type="button" class="dshv-btn sm" data-act="rollback" data-id="${esc(v.id)}"${isCurrent ? ' disabled' : ''}>回滚</button>
  </div>
</div>`
      }).join('') : '<div class="dshv-empty">暂无训练版本。</div>'

      box.innerHTML = `
<div class="dshv-detail-head">
  <span class="dshv-detail-title">${esc(p.name || '未命名音色')}</span>
  ${p.isDefault ? '<span class="dshv-badge default">全局默认</span>' : ''}
  <span class="dshv-badge ${esc(p.status || 'active')}">${esc(profileStatusLabel(p.status))}</span>
  <span class="dshv-muted">${esc(kindLabel(p.kind))} · ${p.sampleCount != null ? esc(p.sampleCount) : samples.length} 个样本 · 总时长 ${fmtSec(p.totalDuration)}</span>
</div>
<div class="dshv-form" data-role="meta-form">
  <label class="dshv-field"><span>名称</span><input class="dshv-input" data-field="name" value="${esc(p.name)}"></label>
  <label class="dshv-field"><span>标签（逗号分隔）</span><input class="dshv-input" data-field="tags" value="${esc((Array.isArray(p.tags) ? p.tags : []).join('，'))}"></label>
  <label class="dshv-field full"><span>描述</span><input class="dshv-input" data-field="description" value="${esc(p.description)}"></label>
  <label class="dshv-field"><span>基础音色</span><input class="dshv-input" data-field="baseVoice" list="dshv-voice-list" value="${esc(p.baseVoice)}"></label>
  <div class="dshv-row"><button type="button" class="dshv-btn primary" data-act="save-meta">保存资料</button><span class="dshv-muted">最近训练：${esc(fmtDate(p.lastTrainedAt))}</span></div>
</div>

<div class="dshv-sub">样本（${samples.length}）
  <span class="dshv-muted">
    <button type="button" class="dshv-btn sm" data-act="upload-samples">上传样本</button>
    <input type="file" data-role="sample-input" accept=".wav,.mp3,.m4a,.flac,audio/*" multiple hidden>
  </span>
</div>
<div data-role="samples">${samplesHtml}</div>

<div class="dshv-sub">训练
  <span class="dshv-muted" data-role="train-status">${training
    ? '<i class="dshv-spin"></i> 训练中' + (trainProgress != null ? ' ' + trainProgress + '%' : '') + '…'
    : trainError
      ? '<span class="dshv-warn">上次训练失败：' + esc(trainError) + '</span>'
      : ''}</span>
</div>
<div class="dshv-row">
  <input class="dshv-input grow" data-role="train-note" placeholder="训练备注（可选）">
  <button type="button" class="dshv-btn primary" data-act="train"${training ? ' disabled' : ''}>${training ? '训练中…' : '开始训练'}</button>
</div>

<div class="dshv-sub">试听
  <span class="dshv-muted">按当前设置合成一句试听音频</span>
</div>
<div class="dshv-row">
  <input class="dshv-input grow" data-role="preview-text" value="你好，这是声音试听。" placeholder="试听文本">
  <select class="dshv-select" data-role="preview-emotion">
    ${EMOTIONS.map((it) => '<option value="' + it[0] + '"' + (it[0] === defaultEmotion ? ' selected' : '') + '>' + it[1] + '</option>').join('')}
  </select>
  <button type="button" class="dshv-btn" data-act="preview">试听</button>
</div>

<div class="dshv-sub">版本历史（${versions.length}）
  <span class="dshv-muted">回滚会把当前版本切到选中的历史版本</span>
</div>
<div data-role="versions">${versionsHtml}</div>`

      wireSampleInput(page)
    }

    function wireSampleInput(page) {
      /* 文件输入用 change 事件委托，无需额外绑定；这里保留占位以便后续扩展。 */
      void page
    }

    function renderPreviewBar() {
      const page = state.pages.profiles
      if (!page) return
      const bar = page.querySelector('[data-role=preview-bar]')
      if (!bar) return
      const pv = state.preview
      bar.hidden = !pv.url
      const label = bar.querySelector('[data-role=preview-label]')
      if (label) label.textContent = pv.label || '试听'
      const time = bar.querySelector('[data-role=preview-time]')
      if (time) time.textContent = fmtTime(pv.position) + ' / ' + fmtTime(pv.duration)
      const toggle = bar.querySelector('[data-act=preview-toggle]')
      if (toggle) toggle.textContent = pv.playing ? '暂停' : '播放'
    }

    /* ================= 设置页 ================= */

    function buildSettingsPage() {
      const page = state.pages.settings
      page.innerHTML = `
<div class="dshv-err" data-role="page-error" hidden></div>
<div class="dshv-group">
  <h3>回复与播放</h3>
  <label class="dshv-switch">
    <input type="checkbox" data-setting="autoReply">
    <span class="dshv-switch-text"><b>始终语音回复</b><small>默认关闭；开启后每条助手回复都合成语音</small></span>
  </label>
  <label class="dshv-switch">
    <input type="checkbox" data-setting="intentReply">
    <span class="dshv-switch-text"><b>按需语音回复</b><small>只在你说“唱/说/语音/朗读/翻唱”等时才生成语音（推荐）</small></span>
  </label>
  <label class="dshv-switch">
    <input type="checkbox" data-setting="autoplay">
    <span class="dshv-switch-text"><b>自动播放语音</b><small>新消息里的语音自动尝试播放；历史消息不自动播放</small></span>
  </label>
  <label class="dshv-switch">
    <input type="checkbox" data-setting="crossTurnEmotion">
    <span class="dshv-switch-text"><b>跨轮情绪延续</b><small>让情绪从上一轮延续到下一轮，对话更自然</small></span>
  </label>
</div>

<div class="dshv-group">
  <h3>声音参数</h3>
  <div class="dshv-slider">
    <span>情感强度</span>
    <input type="range" data-setting="emotionIntensity" min="0" max="1" step="0.05">
    <output data-out="emotionIntensity">0.70</output>
  </div>
  <div class="dshv-slider">
    <span>语速</span>
    <input type="range" data-setting="speed" min="0.75" max="1.3" step="0.01">
    <output data-out="speed">1.00×</output>
  </div>
  <div class="dshv-slider">
    <span>音量</span>
    <input type="range" data-setting="volume" min="0" max="1" step="0.05">
    <output data-out="volume">100%</output>
  </div>
  <div class="dshv-row" style="margin-top:9px">
    <label class="dshv-field" style="margin:0;flex:1;min-width:150px">
      <span>默认情感</span>
      <select class="dshv-select" data-setting="defaultEmotion">
        ${EMOTIONS.map((it) => '<option value="' + it[0] + '">' + it[1] + '</option>').join('')}
      </select>
    </label>
    <label class="dshv-field" style="margin:0;width:130px">
      <span>回复字数上限</span>
      <input class="dshv-input" type="number" data-setting="maxReplyChars" min="50" max="4000" step="50">
    </label>
  </div>
  <div class="dshv-row" style="margin-top:9px">
    <button type="button" class="dshv-btn" data-act="reset-emotion">重置情绪</button>
    <span class="dshv-muted">恢复为平静、默认强度 0.70，并重新开启跨轮情绪</span>
  </div>
</div>

<div class="dshv-group">
  <h3>授权与存储</h3>
  <div class="dshv-statusrow"><span>云端授权</span><span data-role="cloud-state">—</span></div>
  <p class="dshv-note">设置改动会立即保存到服务端并生效。</p>
</div>`
    }

    function syncSettingsForm() {
      const page = state.pages.settings
      if (!page) return
      const s = state.settings
      page.querySelectorAll('[data-setting]').forEach((input) => {
        const key = input.getAttribute('data-setting')
        if (!(key in s)) return
        if (document.activeElement === input && input.type !== 'checkbox') return
        if (input.type === 'checkbox') {
          input.checked = Boolean(s[key])
          return
        }
        input.value = String(s[key] == null ? '' : s[key])
      })
      updateSettingsOutputs()
      const cloud = page.querySelector('[data-role=cloud-state]')
      if (cloud) cloud.textContent = s.cloudAuthorized ? '已授权' : '未授权（仅本地引擎）'
    }

    function updateSettingsOutputs() {
      const page = state.pages.settings
      if (!page) return
      const s = state.settings
      const setOut = (key, text) => {
        const out = page.querySelector('[data-out="' + key + '"]')
        if (out) out.textContent = text
      }
      const intensity = Number(s.emotionIntensity)
      setOut('emotionIntensity', Number.isFinite(intensity) ? intensity.toFixed(2) : '—')
      const speed = Number(s.speed)
      setOut('speed', Number.isFinite(speed) ? speed.toFixed(2) + '×' : '—')
      const volume = Number(s.volume)
      setOut('volume', Number.isFinite(volume) ? Math.round(volume * 100) + '%' : '—')
      page.querySelectorAll('.dshv-slider input[type=range]').forEach((input) => {
        const min = Number(input.min || 0)
        const max = Number(input.max || 1)
        const val = Number(input.value || 0)
        const pct = max > min ? clamp((val - min) / (max - min), 0, 1) * 100 : 0
        input.style.setProperty('--p', pct.toFixed(1) + '%')
      })
    }

    function onSettingInput(input) {
      const key = input.getAttribute('data-setting')
      if (!key) return
      let value
      if (input.type === 'checkbox') value = input.checked
      else if (input.type === 'range' || input.type === 'number') value = Number(input.value)
      else value = input.value
      if (input.type === 'number' && !Number.isFinite(value)) return
      state.settings[key] = value
      updateSettingsOutputs()
      queueSettingSave(key, value)
    }

    function queueSettingSave(key, value) {
      clearTimeout(state.settingTimers[key])
      state.settingTimers[key] = setTimeout(() => {
        void API.saveSettings({ [key]: value })
          .then((res) => {
            if (res && res.settings) state.settings = normalizeSettings(Object.assign({}, state.settings, res.settings))
            toast('设置已保存', 'ok')
          })
          .catch((error) => toast('保存失败：' + friendly(error), 'err'))
      }, 160)
    }

    async function resetEmotion() {
      Object.keys(state.settingTimers).forEach((key) => clearTimeout(state.settingTimers[key]))
      state.settingTimers = {}
      const patch = { defaultEmotion: 'calm', emotionIntensity: 0.7, crossTurnEmotion: true }
      const res = await API.saveSettings(patch)
      state.settings = normalizeSettings(Object.assign({}, state.settings, patch, res && res.settings ? res.settings : {}))
      syncSettingsForm()
      toast('情绪已重置', 'ok')
    }

    /* ================= 翻唱页 ================= */

    function buildCoverPage() {
      const page = state.pages.cover
      page.innerHTML = `
<div class="dshv-err" data-role="page-error" hidden></div>

<div class="dshv-group">
  <h3>音乐缓存
    <span class="dshv-muted"><button type="button" class="dshv-btn sm" data-act="reload-cache">${I.refresh}刷新</button></span>
  </h3>
  <div data-role="cache-dirs"></div>
  <div class="dshv-row" style="margin-top:8px">
    <input class="dshv-input grow" data-role="cache-directory" placeholder="缓存目录，例如 D:\\Music\\cache">
    <button type="button" class="dshv-btn" data-act="bind-cache">绑定目录</button>
  </div>
  <div class="dshv-sub">缓存文件 <span class="dshv-muted">点击「使用」作为翻唱素材</span></div>
  <div data-role="cache-list"></div>
</div>

<div class="dshv-group">
  <h3>翻唱任务</h3>
  <div class="dshv-row">
    <button type="button" class="dshv-btn" data-act="upload-audio">上传本地音频</button>
    <input type="file" data-role="cover-file-input" accept=".wav,.mp3,.m4a,.flac,audio/*" hidden>
    <span class="dshv-muted" data-role="cover-source">未选择素材</span>
  </div>
  <div class="dshv-form" style="margin-top:8px">
    <label class="dshv-field"><span>歌曲名</span><input class="dshv-input" data-cover-song placeholder="默认取素材文件名"></label>
    <label class="dshv-field"><span>音色</span><select class="dshv-select" data-cover-profile></select></label>
    <label class="dshv-field"><span>输出格式</span>
      <select class="dshv-select" data-cover-format>
        <option value="mp3">mp3</option>
        <option value="wav">wav</option>
      </select>
    </label>
    <label class="dshv-switch" style="border:none;padding:4px 0">
      <input type="checkbox" data-cover-deliver checked>
      <span class="dshv-switch-text"><b>直出</b><small>跳过额外导唱/伴奏步骤，直接输出成品</small></span>
    </label>
  </div>
  <div class="dshv-row">
    <button type="button" class="dshv-btn primary" data-act="run-cover">开始翻唱</button>
    <span class="dshv-muted" data-role="cover-runmsg"></span>
  </div>
</div>

<div class="dshv-group">
  <h3>任务队列
    <span class="dshv-muted"><button type="button" class="dshv-btn sm" data-act="reload-jobs">${I.refresh}刷新</button></span>
  </h3>
  <div data-role="job-list"><div class="dshv-loading"><i class="dshv-spin"></i>正在加载任务…</div></div>
</div>`
    }

    function renderCache() {
      const page = state.pages.cover
      if (!page) return
      const dirs = page.querySelector('[data-role=cache-dirs]')
      if (dirs) {
        const list = state.cache.directories
        dirs.innerHTML = list.length
          ? list.map((d) => '<div class="dshv-dir"><span>📁</span><code>' + esc(d) + '</code></div>').join('')
          : '<p class="dshv-note">还没有绑定缓存目录。绑定后可直接选用音乐插件已缓存的音频。</p>'
      }
      const box = page.querySelector('[data-role=cache-list]')
      if (box) {
        const entries = state.cache.entries
        box.innerHTML = entries.length ? entries.map((entry, i) => {
          const name = entry.name || entry.title || entry.filename || basename(entry.path || entry.file) || ('缓存文件 ' + (i + 1))
          const path = entry.path || entry.file || entry.fullPath || (entry.directory ? entry.directory + (String(entry.directory).includes('\\') ? '\\' : '/') + name : '')
          const meta = []
          if (entry.size != null) meta.push(fmtBytes(entry.size))
          if (entry.duration != null) meta.push(fmtSec(entry.duration))
          if (entry.mtime || entry.modifiedAt || entry.createdAt) meta.push(fmtDate(entry.mtime || entry.modifiedAt || entry.createdAt))
          return '<div class="dshv-cache">' +
            '<div class="dshv-cache-main"><span class="dshv-cache-name">' + esc(name) + '</span>' +
            '<span class="dshv-cache-path">' + esc(path || '—') + (meta.length ? ' · ' + esc(meta.join(' · ')) : '') + '</span></div>' +
            '<button type="button" class="dshv-btn sm" data-act="use-cache" data-path="' + esc(path || name) + '" data-name="' + esc(name) + '">使用</button>' +
            '</div>'
        }).join('') : '<div class="dshv-empty">缓存目录里还没有音频文件。</div>'
      }
      updateCoverReadout()
    }

    function renderCoverProfileOptions() {
      const page = state.pages.cover
      if (!page) return
      const select = page.querySelector('[data-cover-profile]')
      if (!select) return
      const prev = select.value
      const options = ['<option value="">跟随默认音色</option>'].concat(
        state.profiles.map((p) => {
          const isDefault = p.isDefault === true || p.id === state.defaultProfileId
          return '<option value="' + esc(p.id) + '">' + esc(p.name || p.id) + (isDefault ? '（默认）' : '') + '</option>'
        })
      )
      select.innerHTML = options.join('')
      if (prev && state.profiles.some((p) => p.id === prev)) select.value = prev
      else if (state.defaultProfileId) select.value = state.defaultProfileId
    }

    function updateCoverReadout() {
      const page = state.pages.cover
      if (!page) return
      const src = page.querySelector('[data-role=cover-source]')
      if (src) src.textContent = state.coverSource.path ? ('已选择：' + (state.coverSource.name || basename(state.coverSource.path))) : '未选择素材'
      const song = page.querySelector('[data-cover-song]')
      if (song && !song.value && state.coverSource.name) {
        song.value = state.coverSource.name.replace(/\.[^.]+$/, '')
      }
      const msg = page.querySelector('[data-role=cover-runmsg]')
      if (msg) msg.textContent = state.coverJobId ? ('最近任务：' + state.coverJobId) : ''
    }

    function renderJobs() {
      const page = state.pages.cover
      if (!page) return
      const box = page.querySelector('[data-role=job-list]')
      if (!box) return
      if (!state.jobsLoaded) {
        box.innerHTML = '<div class="dshv-loading"><i class="dshv-spin"></i>正在加载任务…</div>'
        return
      }
      if (!state.jobs.length) {
        state.jobsSig = '[]'
        box.innerHTML = '<div class="dshv-empty">还没有翻唱任务。选择素材和音色后点击「开始翻唱」。</div>'
        return
      }
      // 内嵌 audio 正在播放时不要重建列表，避免 1.5s 轮询打断播放；
      // 数据没变化时也跳过重绘。
      const playing = Array.prototype.some.call(box.querySelectorAll('audio'), (a) => !a.paused)
      if (playing) return
      const sig = JSON.stringify(state.jobs.map((job) => [
        job.id, job.status, job.progress, job.stage, job.error, job.updatedAt,
        job.previewAudioUrl, job.output && (job.output.mp3 || job.output.wav),
        Array.isArray(job.logs) ? job.logs.length : 0,
      ]))
      if (state.jobsSig === sig) return
      state.jobsSig = sig
      box.innerHTML = state.jobs.map((job) => jobCardHtml(job)).join('')
    }

    function jobCardHtml(job) {
      const status = job.status || 'queued'
      const progress = clamp(Number(job.progress) || 0, 0, 100)
      const logs = Array.isArray(job.logs) ? job.logs.slice(-6) : []
      const output = job.output || {}
      const audioUrl = job.previewAudioUrl || output.mp3 || output.wav || ''
      const downloadUrl = job.downloadUrl || (audioUrl ? audioUrl + (audioUrl.indexOf('?') >= 0 ? '&' : '?') + 'download=1' : '')
      const profileName = job.profileName || ''
      return `
<article class="dshv-job${status === 'failed' ? ' failed' : ''}" data-job-id="${esc(job.id)}">
  <div class="dshv-job-head">
    <span class="dshv-job-title">${esc(job.songName || '未命名歌曲')}</span>
    <span class="dshv-badge ${esc(status)}">${esc(jobStatusLabel(status))}</span>
    ${profileName ? '<span class="dshv-muted">音色：' + esc(profileName) + '</span>' : ''}
    <span class="dshv-muted">${esc(fmtDate(job.createdAt))}</span>
  </div>
  <div class="dshv-progress"><i style="width:${progress.toFixed(1)}%"></i></div>
  <div class="dshv-progress-text">
    <span>${progress.toFixed(0)}%</span>
    <span>阶段：${esc(stageLabel(job.stage))}</span>
    ${output.duration != null ? '<span>' + fmtSec(output.duration) + '</span>' : ''}
    ${output.size != null ? '<span>' + fmtBytes(output.size) + '</span>' : ''}
  </div>
  ${logs.length ? '<div class="dshv-logs">' + esc(logs.join('\n')) + '</div>' : ''}
  ${job.error ? '<div class="dshv-job-error">失败：' + esc(job.error) + '</div>' : ''}
  ${audioUrl ? '<audio class="dshv-job-audio" controls preload="none" src="' + esc(audioUrl) + '"></audio>' : ''}
  <div class="dshv-job-acts">
    ${(status === 'failed') ? '<button type="button" class="dshv-btn sm primary" data-act="retry-job" data-id="' + esc(job.id) + '">重试</button>' : ''}
    ${(status === 'done' || audioUrl) ? '<button type="button" class="dshv-btn sm" data-act="export-job" data-id="' + esc(job.id) + '" data-format="' + esc((output.mp3 ? 'mp3' : 'wav')) + '">导出</button>' : ''}
    ${downloadUrl ? '<a class="dshv-btn sm" href="' + esc(downloadUrl) + '" download>下载</a>' : ''}
    <span class="dshv-muted">任务 ${esc(job.id || '')}</span>
  </div>
</article>`
    }

    /* ================= 状态页 ================= */

    function buildStatusPage() {
      const page = state.pages.status
      page.innerHTML = `
<div class="dshv-err" data-role="page-error" hidden></div>
<div class="dshv-stats">
  <div class="dshv-stat"><span>默认音色</span><b data-role="stat-default">—</b></div>
  <div class="dshv-stat"><span>总样本数</span><b data-role="stat-samples">—</b></div>
  <div class="dshv-stat"><span>最近训练</span><b data-role="stat-trained">—</b></div>
  <div class="dshv-stat"><span>活动任务</span><b data-role="stat-jobs">—</b></div>
</div>
<div class="dshv-group">
  <h3>服务状态
    <span class="dshv-muted"><button type="button" class="dshv-btn sm" data-act="reload-health">${I.refresh}刷新</button></span>
  </h3>
  <div class="dshv-statusrow"><span>平台</span><span class="dshv-dot" data-role="dot-platform"></span><span data-role="stat-platform">—</span></div>
  <div class="dshv-statusrow"><span>TTS 引擎</span><span class="dshv-dot" data-role="dot-tts"></span><span data-role="stat-tts">—</span></div>
  <div class="dshv-statusrow"><span>ffmpeg</span><span class="dshv-dot" data-role="dot-ffmpeg"></span><span data-role="stat-ffmpeg">—</span></div>
  <div class="dshv-statusrow"><span>声音引擎</span><span class="dshv-dot" data-role="dot-engine"></span><span data-role="stat-engine">—</span></div>
  <div class="dshv-statusrow"><span>语音回复</span><span class="dshv-dot" data-role="dot-autoreply"></span><span data-role="stat-autoreply">—</span></div>
</div>
<div class="dshv-group">
  <h3>当前队列</h3>
  <div data-role="status-jobs"><div class="dshv-empty">暂无活动任务</div></div>
  <p class="dshv-note" data-role="status-updated" style="margin-top:8px"></p>
</div>`
    }

    function statusValue(v) {
      if (v == null || v === '') return { ok: null, text: '未知' }
      if (typeof v === 'boolean') return { ok: v, text: v ? '可用' : '不可用' }
      if (typeof v === 'number') return { ok: v > 0, text: String(v) }
      if (typeof v === 'string') return { ok: true, text: v }
      if (typeof v === 'object') {
        const ok = v.ok !== false
        const text = v.detail || v.path || v.version || v.name || (ok ? '可用' : '不可用')
        return { ok, text: String(text) }
      }
      return { ok: null, text: String(v) }
    }

    function setDot(page, role, ok) {
      const dot = page.querySelector('[data-role="dot-' + role + '"]')
      if (!dot) return
      dot.className = 'dshv-dot' + (ok === true ? ' ok' : ok === false ? ' bad' : '')
    }

    function renderStatusPage() {
      const page = state.pages.status
      if (!page) return
      const health = state.health
      const profiles = state.profiles
      const defaultId = (health && health.defaultProfileId) || state.defaultProfileId
      const defaultProfile = profiles.find((p) => p.id === defaultId) || profiles.find((p) => p.isDefault)
      const totalSamples = profiles.reduce((sum, p) => sum + (Number(p.sampleCount) || 0), 0)
      const lastTrained = profiles
        .map((p) => p.lastTrainedAt)
        .filter(Boolean)
        .sort()
        .pop()

      const setText = (role, text) => {
        const el = page.querySelector('[data-role="' + role + '"]')
        if (el) el.textContent = text
      }
      setText('stat-default', defaultProfile ? (defaultProfile.name || defaultProfile.id) : '—')
      setText('stat-samples', profiles.length ? String(totalSamples) : '—')
      setText('stat-trained', lastTrained ? fmtDate(lastTrained) : '—')
      setText('stat-jobs', health ? activeJobsText(health.activeJobs) : '—')

      const platform = health && health.platform ? health.platform : '未知'
      const tts = statusValue(health && health.ttsEngine)
      const ffmpeg = statusValue(health && health.ffmpeg)
      const engine = statusValue(health && health.engine)
      setText('stat-platform', platform)
      setText('stat-tts', tts.text)
      setText('stat-ffmpeg', ffmpeg.text)
      setText('stat-engine', engine.text)
      setDot(page, 'platform', true)
      setDot(page, 'tts', tts.ok)
      setDot(page, 'ffmpeg', ffmpeg.ok)
      setDot(page, 'engine', engine.ok)
      const autoReply = health && health.autoReply != null ? health.autoReply : state.settings.autoReply
      const intentReply = state.settings.intentReply !== false
      setText('stat-autoreply', autoReply ? '始终开启' : (intentReply ? '按需开启' : '已关闭'))
      setDot(page, 'autoreply', Boolean(autoReply || intentReply))

      const jobsBox = page.querySelector('[data-role=status-jobs]')
      if (jobsBox) {
        const active = state.jobs.filter((j) => j.status === 'queued' || j.status === 'running')
        jobsBox.innerHTML = active.length
          ? active.map((j) => '<div class="dshv-statusrow"><span>' + esc(j.songName || j.id) + '</span><span>' +
              esc(jobStatusLabel(j.status)) + ' · ' + Math.round(Number(j.progress) || 0) + '%</span></div>').join('')
          : '<div class="dshv-empty">暂无活动任务</div>'
      }
      const updated = page.querySelector('[data-role=status-updated]')
      if (updated) updated.textContent = '状态每 1.5 秒自动刷新 · ' + new Date().toLocaleTimeString()

      if (!state.profilesLoaded) {
        setText('stat-samples', '加载中…')
      }
    }

    function activeJobsText(v) {
      if (Array.isArray(v)) return v.length ? String(v.length) : '0'
      if (typeof v === 'number') return String(v)
      if (v && typeof v === 'object') {
        if (Array.isArray(v.jobs)) return String(v.jobs.length)
        if (v.count != null) return String(v.count)
        if (v.total != null) return String(v.total)
        const sum = ['queued', 'running'].reduce((n, k) => n + (Number(v[k]) || 0), 0)
        return String(sum)
      }
      return '0'
    }

    /* ================= 页面构建与事件 ================= */

    function buildPage(name) {
      const page = state.panel.querySelector('[data-page="' + name + '"]')
      if (!page) return
      state.pages[name] = page
      if (name === 'profiles') buildProfilesPage()
      else if (name === 'settings') buildSettingsPage()
      else if (name === 'cover') buildCoverPage()
      else if (name === 'status') buildStatusPage()
    }

    async function handleAction(act, btn) {
      const id = btn.getAttribute('data-id') || ''
      switch (act) {
        case 'refresh': {
          await refreshActive(true)
          const err = state.errors[state.active]
          toast(err ? '刷新失败：' + err : '已刷新', err ? 'err' : 'ok')
          return
        }
        case 'new-profile': {
          const form = state.pages.profiles.querySelector('[data-role=new-form]')
          if (form) {
            form.hidden = !form.hidden
            if (!form.hidden) {
              const input = form.querySelector('[data-new=name]')
              if (input) input.focus()
            }
          }
          return
        }
        case 'cancel-new': {
          const form = state.pages.profiles.querySelector('[data-role=new-form]')
          if (form) form.hidden = true
          return
        }
        case 'create-profile':
          await createProfile()
          return
        case 'reload-profiles':
          await refreshActive(true)
          return
        case 'reload-detail':
          await loadProfileDetail(state.selectedProfileId, true)
          return
        case 'select-profile':
          selectProfile(id)
          return
        case 'rename-profile':
          selectProfile(id)
          setTimeout(() => {
            const input = state.pages.profiles.querySelector('[data-role=profile-detail] [data-field=name]')
            if (input) {
              input.focus()
              input.select()
            }
          }, 180)
          return
        case 'set-default':
          await API.setDefault(id)
          toast('已设为全局默认音色', 'ok')
          await refreshActive(true)
          return
        case 'toggle-status': {
          const status = btn.getAttribute('data-status') === 'disabled' ? 'active' : 'disabled'
          await API.updateProfile(id, { status })
          toast(status === 'disabled' ? '音色已停用' : '音色已启用', 'ok')
          await loadProfiles()
          if (state.selectedProfileId === id) await loadProfileDetail(id, true)
          return
        }
        case 'delete-profile':
          await handleDeleteProfile(id, btn)
          return
        case 'save-meta':
          await saveProfileMeta()
          return
        case 'upload-samples':
          state.pages.profiles.querySelector('[data-role=sample-input]').click()
          return
        case 'delete-sample':
          await API.deleteSample(state.selectedProfileId, id)
          toast('样本已删除', 'ok')
          await loadProfileDetail(state.selectedProfileId, true)
          await loadProfiles()
          return
        case 'slice-sample':
          toast('正在按静音切片…')
          await API.sliceSample(state.selectedProfileId, id)
          toast('切片完成，已生成样本', 'ok')
          await loadProfileDetail(state.selectedProfileId, true)
          await loadProfiles()
          return
        case 'train':
          await trainProfile()
          return
        case 'preview':
          await previewProfile(id || state.selectedProfileId, '')
          return
        case 'preview-version':
          await previewProfile(state.selectedProfileId, btn.getAttribute('data-url'), id)
          return
        case 'rollback':
          await API.rollback(state.selectedProfileId, id)
          toast('已回滚到版本 ' + id, 'ok')
          await loadProfileDetail(state.selectedProfileId, true)
          await loadProfiles()
          return
        case 'preview-toggle':
          togglePreviewAudio()
          return
        case 'preview-stop':
          stopPreviewAudio()
          return
        case 'reset-emotion':
          await resetEmotion()
          return
        case 'reload-cache':
          await loadCache()
          toast('缓存列表已刷新', 'ok')
          return
        case 'bind-cache':
          await bindCache()
          return
        case 'use-cache':
          chooseCacheEntry(btn.getAttribute('data-path'), btn.getAttribute('data-name'))
          return
        case 'upload-audio':
          state.pages.cover.querySelector('[data-role=cover-file-input]').click()
          return
        case 'run-cover':
          await runCover()
          return
        case 'reload-jobs':
          await loadJobs()
          toast('任务队列已刷新', 'ok')
          return
        case 'retry-job':
          await API.retryJob(id)
          toast('已提交重试', 'ok')
          await loadJobs()
          return
        case 'export-job':
          await exportJob(id, btn.getAttribute('data-format') || 'mp3')
          return
        case 'reload-health': {
          await refreshActive(true)
          const err = state.errors[state.active]
          toast(err ? '刷新失败：' + err : '状态已刷新', err ? 'err' : 'ok')
          return
        }
        default:
          return
      }
    }

    /* ================= 音色操作 ================= */

    function selectProfile(id) {
      state.selectedProfileId = id
      state.profileDetail = null
      state.profileDetailError = ''
      renderProfilesPage()
      void loadProfileDetail(id, true).catch((error) => {
        setPageError('profiles', friendly(error))
        toast(friendly(error), 'err')
      })
    }

    async function createProfile() {
      const page = state.pages.profiles
      const form = page.querySelector('[data-role=new-form]')
      const get = (key) => {
        const input = form.querySelector('[data-new="' + key + '"]')
        return input ? String(input.value || '').trim() : ''
      }
      const name = get('name')
      if (!name) {
        toast('请填写音色名称', 'err')
        const input = form.querySelector('[data-new=name]')
        if (input) input.focus()
        return
      }
      const body = { name }
      const description = get('description')
      if (description) body.description = description
      const tags = get('tags').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
      if (tags.length) body.tags = tags
      const kind = get('kind')
      if (kind) body.kind = kind
      const baseVoice = get('baseVoice')
      if (baseVoice) body.baseVoice = baseVoice
      const res = await API.createProfile(body)
      const created = res && res.profile ? res.profile : null
      toast('音色「' + name + '」已创建', 'ok')
      form.hidden = true
      form.querySelectorAll('input').forEach((input) => { input.value = '' })
      await loadProfiles()
      if (created && created.id) selectProfile(created.id)
    }

    async function saveProfileMeta() {
      const id = state.selectedProfileId
      if (!id) return
      const box = state.pages.profiles.querySelector('[data-role=profile-detail]')
      const val = (field) => {
        const input = box.querySelector('[data-field="' + field + '"]')
        return input ? String(input.value || '').trim() : ''
      }
      const name = val('name')
      if (!name) {
        toast('音色名称不能为空', 'err')
        return
      }
      const body = {
        name,
        description: val('description'),
        tags: val('tags').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
      }
      const baseVoice = val('baseVoice')
      if (baseVoice) body.baseVoice = baseVoice
      await API.updateProfile(id, body)
      toast('资料已保存', 'ok')
      await loadProfiles()
      await loadProfileDetail(id, true)
    }

    async function uploadSamples(id, files) {
      if (!id) return
      const list = Array.from(files || [])
      let ok = 0
      for (const file of list) {
        if (!file) continue
        if (file.size > 48 * 1024 * 1024) {
          toast('「' + file.name + '」超过 48MB，已跳过', 'err')
          continue
        }
        toast('正在上传 ' + file.name + '…')
        const dataUrl = await readAsDataURL(file)
        await API.addSample(id, { filename: file.name, dataBase64: base64Of(dataUrl) })
        ok += 1
      }
      if (ok > 0) toast('已上传 ' + ok + ' 个样本', 'ok')
      await loadProfiles()
      await loadProfileDetail(id, true)
    }

    async function trainProfile() {
      const id = state.selectedProfileId
      if (!id) return
      const box = state.pages.profiles.querySelector('[data-role=profile-detail]')
      const noteInput = box.querySelector('[data-role=train-note]')
      const note = noteInput ? String(noteInput.value || '').trim() : ''
      const body = note ? { note } : {}
      const res = await API.train(id, body)
      const jobId = (res && (res.jobId || res.id)) || ''
      const currentVersionId = state.profileDetail && state.profileDetail.currentVersion ? state.profileDetail.currentVersion.id : ''
      state.training = {
        profileId: id,
        jobId,
        startedAt: Date.now(),
        previousVersionId: currentVersionId || '',
        announced: false,
      }
      toast('训练已开始' + (jobId ? '（任务 ' + jobId + '）' : ''), 'ok')
      await loadProfileDetail(id, true)
    }

    function checkTraining(profile) {
      const t = state.training
      if (!t || !profile || profile.id !== t.profileId || t.announced) return
      const server = profile.training
      if (server && server.jobId === t.jobId) {
        if (server.status === 'failed') {
          t.announced = true
          state.training = null
          toast('训练失败：' + (server.error || '请检查样本后重试'), 'err')
          return
        }
        if (server.status === 'done') {
          t.announced = true
          state.training = null
          const versions = Array.isArray(profile.versions) ? profile.versions : []
          const latest = versions[versions.length - 1]
          toast('训练完成' + (latest ? '，新版本 ' + (latest.label || latest.id) + ' 已生效' : ''), 'ok')
          return
        }
      }
      const versions = Array.isArray(profile.versions) ? profile.versions : []
      const latest = versions[versions.length - 1]
      if (!latest) return
      if (latest.status === 'failed') {
        t.announced = true
        state.training = null
        toast('训练失败：' + (latest.note || '请检查样本后重试'), 'err')
        return
      }
      if (latest.status === 'ready' && latest.id !== t.previousVersionId) {
        t.announced = true
        state.training = null
        toast('训练完成，新版本 ' + (latest.label || latest.id) + ' 已生效', 'ok')
      }
    }

    async function previewProfile(id, directUrl, versionId) {
      if (!id) return
      if (directUrl) {
        playPreviewAudio(directUrl, '历史版本试听')
        return
      }
      const page = state.pages.profiles
      const textInput = page.querySelector('[data-role=preview-text]')
      const emotionSelect = page.querySelector('[data-role=preview-emotion]')
      const text = (textInput && textInput.value.trim()) || '你好，这是声音试听。'
      const emotion = (emotionSelect && emotionSelect.value) || state.settings.defaultEmotion || 'calm'
      toast('正在生成试听…')
      const body = { text, emotion }
      if (versionId) body.versionId = versionId
      const res = await API.preview(id, body)
      if (!res || !res.audioUrl) throw new Error('试听生成失败：服务端没有返回音频地址')
      playPreviewAudio(res.audioUrl, '试听 · ' + (res.similarity != null ? '相似度 ' + res.similarity : '生成成功'))
      toast('试听已生成' + (res.similarity != null ? '（相似度 ' + res.similarity + '）' : ''), 'ok')
    }

    async function handleDeleteProfile(id, btn) {
      const now = Date.now()
      if (state.confirmDelete && state.confirmDelete.id === id && state.confirmDelete.until > now) {
        await API.deleteProfile(id)
        state.confirmDelete = null
        toast('音色已删除', 'ok')
        if (state.selectedProfileId === id) {
          state.selectedProfileId = ''
          state.profileDetail = null
        }
        await refreshActive(true)
        return
      }
      state.confirmDelete = { id, until: now + 4000 }
      btn.textContent = '再次点击确认删除'
      btn.classList.add('on')
      setTimeout(() => {
        if (state.confirmDelete && state.confirmDelete.id === id && Date.now() >= state.confirmDelete.until) {
          state.confirmDelete = null
          if (state.open && state.active === 'profiles') renderProfilesPage()
        }
      }, 4200)
    }

    /* ================= 试听音频（面板内） ================= */

    let previewAudio = null

    function ensurePreviewAudio() {
      if (previewAudio) return previewAudio
      const audio = document.createElement('audio')
      audio.preload = 'auto'
      audio.style.display = 'none'
      audio.addEventListener('play', () => {
        state.preview.playing = true
        renderPreviewBar()
      })
      audio.addEventListener('pause', () => {
        state.preview.playing = false
        renderPreviewBar()
      })
      audio.addEventListener('timeupdate', () => {
        state.preview.position = audio.currentTime
        if (Number.isFinite(audio.duration)) state.preview.duration = audio.duration
        renderPreviewBar()
      })
      audio.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(audio.duration)) state.preview.duration = audio.duration
        renderPreviewBar()
      })
      audio.addEventListener('ended', () => {
        state.preview.playing = false
        renderPreviewBar()
      })
      document.body.appendChild(audio)
      previewAudio = audio
      return audio
    }

    function playPreviewAudio(url, label) {
      const audio = ensurePreviewAudio()
      state.preview = { url, label, playing: false, position: 0, duration: 0 }
      audio.src = url
      renderPreviewBar()
      audio.play().then(() => {
        renderPreviewBar()
      }).catch(() => {
        toast('浏览器阻止了自动播放，请点击试听栏的「播放」', 'err')
      })
    }

    function togglePreviewAudio() {
      if (!previewAudio || !state.preview.url) return
      if (previewAudio.paused) {
        previewAudio.play().catch(() => toast('播放失败，请重试', 'err'))
      } else {
        previewAudio.pause()
      }
    }

    function stopPreviewAudio() {
      if (!previewAudio) return
      previewAudio.pause()
      try { previewAudio.currentTime = 0 } catch (error) { /* ignore */ }
      state.preview.playing = false
      state.preview.position = 0
      renderPreviewBar()
    }

    /* ================= 翻唱操作 ================= */

    async function bindCache() {
      const page = state.pages.cover
      const input = page.querySelector('[data-role=cache-directory]')
      const dir = input ? String(input.value || '').trim() : ''
      if (!dir) {
        toast('请填写要绑定的缓存目录', 'err')
        if (input) input.focus()
        return
      }
      await API.bindCache(dir)
      toast('缓存目录已绑定', 'ok')
      if (input) input.value = ''
      await loadCache()
    }

    function chooseCacheEntry(path, name) {
      if (!path) {
        toast('这个缓存文件没有可用路径', 'err')
        return
      }
      state.coverSource = { path, name: name || basename(path) }
      const page = state.pages.cover
      const song = page.querySelector('[data-cover-song]')
      if (song && !song.value) song.value = String(name || basename(path)).replace(/\.[^.]+$/, '')
      updateCoverReadout()
      toast('已选择素材：' + (name || basename(path)), 'ok')
    }

    async function uploadCoverFile(file) {
      if (!file) return
      if (file.size > 100 * 1024 * 1024) {
        toast('「' + file.name + '」超过 100MB，请换一个更小的文件', 'err')
        return
      }
      toast('正在上传 ' + file.name + '…')
      const dataUrl = await readAsDataURL(file)
      const res = await API.uploadCover({ filename: file.name, dataBase64: base64Of(dataUrl) })
      if (!res || !res.path) throw new Error('上传失败：服务端没有返回文件路径')
      state.coverSource = { path: res.path, name: file.name }
      const page = state.pages.cover
      const song = page.querySelector('[data-cover-song]')
      if (song && !song.value) song.value = file.name.replace(/\.[^.]+$/, '')
      updateCoverReadout()
      toast('本地音频已上传', 'ok')
    }

    async function runCover() {
      const page = state.pages.cover
      if (!state.coverSource.path) {
        toast('请先上传本地音频，或从缓存列表选择素材', 'err')
        return
      }
      const songInput = page.querySelector('[data-cover-song]')
      const profileSelect = page.querySelector('[data-cover-profile]')
      const deliverInput = page.querySelector('[data-cover-deliver]')
      const formatSelect = page.querySelector('[data-cover-format]')
      const songName = (songInput && songInput.value.trim()) || state.coverSource.name.replace(/\.[^.]+$/, '') || '未命名歌曲'
      const body = {
        sourcePath: state.coverSource.path,
        songName,
        deliver: !deliverInput || deliverInput.checked,
        format: (formatSelect && formatSelect.value) || 'mp3',
        sessionId: currentSessionId(),
      }
      if (profileSelect && profileSelect.value) body.profileId = profileSelect.value
      const msg = page.querySelector('[data-role=cover-runmsg]')
      if (msg) msg.textContent = '正在提交…'
      try {
        const res = await API.runCover(body)
        const jobId = (res && (res.jobId || (res.job && res.job.id))) || ''
        state.coverJobId = jobId || ''
        toast('翻唱任务已开始' + (jobId ? '（' + jobId + '）' : ''), 'ok')
        await loadJobs()
      } finally {
        updateCoverReadout()
      }
    }

    async function exportJob(id, format) {
      const res = await API.exportJob(id, format || 'mp3')
      const path = res && (res.path || res.downloadUrl)
      toast('已导出' + (path ? '：' + path : ''), 'ok')
      await loadJobs()
    }

    /* ================= 会话 ID ================= */

    function bindSessions(ctx) {
      try {
        if (!ctx || typeof ctx.inject !== 'function') return
        ctx.inject(['sessions'], (scope) => {
          try {
            const sessions = (scope && typeof scope.get === 'function' ? scope.get('sessions') : null) || (scope && scope.sessions) || null
            state.sessions = sessions
            const read = () => {
              try {
                const snap = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : null
                if (snap && typeof snap.current === 'string') state.sessionId = snap.current
              } catch (error) {
                /* ignore */
              }
            }
            read()
            try {
              if (sessions && sessions.list && typeof sessions.list.subscribe === 'function') {
                const off = sessions.list.subscribe(read)
                if (typeof off === 'function') state.sessionUnsub = off
              }
            } catch (error) {
              /* ignore */
            }
          } catch (error) {
            /* ignore */
          }
        })
      } catch (error) {
        /* sessions 可选，拿不到就由服务端兜底最近会话 */
      }
    }

    function currentSessionId() {
      try {
        const snap = state.sessions && state.sessions.list && typeof state.sessions.list.getSnapshot === 'function'
          ? state.sessions.list.getSnapshot()
          : null
        const id = snap && snap.current
        if (typeof id === 'string' && id) {
          state.sessionId = id
          return id
        }
      } catch (error) {
        /* ignore */
      }
      return state.sessionId || ''
    }

    /* ================= 对话内 dsh-voice 围栏播放器 ================= */

    const fence = {
      known: new WeakSet(),
      pendingAutoplay: new Set(),
      initialScanDone: false,
      scanTimer: null,
      observer: null,
    }

    function parseVoiceFence(text) {
      const raw = String(text == null ? '' : text).trim()
      if (!raw || raw.charAt(0) !== '{' || raw.charAt(raw.length - 1) !== '}') return null
      let data
      try {
        data = JSON.parse(raw)
      } catch (error) {
        return null
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null
      if (typeof data.voiceReplyId !== 'string' || !data.voiceReplyId) return null
      if (typeof data.audioUrl !== 'string' || !data.audioUrl) return null
      return data
    }

    function shouldAutoplay() {
      return Boolean(state.settings && state.settings.autoplay)
    }

    function scanVoiceFences(root, initial) {
      const scope = root && typeof root.querySelectorAll === 'function' ? root : document
      const blocks = scope.querySelectorAll('.md-code-block')
      for (const block of blocks) {
        if (!(block instanceof Element)) continue
        if (block.getAttribute('data-dshv-managed') === '1') continue
        if (initial) fence.known.add(block)
        const pre = block.querySelector('pre')
        if (!pre) continue
        const spec = parseVoiceFence(pre.textContent)
        if (!spec) continue
        const isNew = !initial && fence.initialScanDone && !fence.known.has(block)
        fence.known.add(block)
        block.setAttribute('data-dshv-managed', '1')
        block.style.display = 'none'
        const sibling = block.nextElementSibling
        if (sibling && sibling.matches && sibling.matches('[data-dshv-voice-player]')) continue
        const player = createVoicePlayer(spec)
        if (block.parentNode) block.parentNode.insertBefore(player, block.nextSibling)
        if (isNew) {
          if (state.settingsLoaded) {
            if (shouldAutoplay()) attemptAutoplay(player)
          } else {
            fence.pendingAutoplay.add(player)
          }
        }
      }
      fence.initialScanDone = true
    }

    function scheduleFenceScan() {
      if (fence.scanTimer) return
      fence.scanTimer = setTimeout(() => {
        fence.scanTimer = null
        try {
          scanVoiceFences(document, false)
        } catch (error) {
          /* ignore */
        }
      }, 120)
    }

    function installFenceObserver() {
      try {
        scanVoiceFences(document, true)
      } catch (error) {
        /* ignore */
      }
      const observer = new MutationObserver(() => scheduleFenceScan())
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      fence.observer = observer
      return () => {
        try { observer.disconnect() } catch (error) { /* ignore */ }
        fence.observer = null
        if (fence.scanTimer) {
          clearTimeout(fence.scanTimer)
          fence.scanTimer = null
        }
      }
    }

    function flushPendingAutoplay() {
      for (const player of fence.pendingAutoplay) {
        if (shouldAutoplay()) attemptAutoplay(player)
      }
      fence.pendingAutoplay.clear()
    }

    function attemptAutoplay(player) {
      const audio = player && player.__dshvAudio
      if (!audio) return
      try {
        const p = audio.play()
        if (p && typeof p.catch === 'function') p.catch(() => { /* 自动播放被拦截：静默，保留播放按钮 */ })
      } catch (error) {
        /* 静默 */
      }
    }

    let transcriptPanel = null

    function closeTranscript() {
      if (!transcriptPanel) return
      try { transcriptPanel.remove() } catch (error) { /* ignore */ }
      transcriptPanel = null
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch (error) {
        try {
          const area = document.createElement('textarea')
          area.value = text
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          const ok = document.execCommand('copy')
          area.remove()
          return ok
        } catch (inner) {
          return false
        }
      }
    }

    function showTranscript(spec, anchor) {
      closeTranscript()
      const panel = h('div', 'dshv-transcript')
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-label', '语音转文字')
      panel.innerHTML = `
        <div class="dshv-transcript-head">
          <span>语音转文字</span>
          <button type="button" data-role="close" title="关闭">✕</button>
        </div>
        <div class="dshv-transcript-body" data-role="body">正在识别…</div>
        <div class="dshv-transcript-meta" data-role="meta"></div>
        <div class="dshv-transcript-actions">
          <button type="button" data-role="copy" disabled>复制</button>
          <button type="button" data-role="close2">关闭</button>
        </div>`
      document.body.appendChild(panel)
      transcriptPanel = panel
      const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: window.innerWidth - 360, top: 80, bottom: 120 }
      const pos = clampPosition(rect.left, Math.min(rect.bottom + 6, window.innerHeight - 220), panel.offsetWidth, panel.offsetHeight)
      panel.style.left = pos.left + 'px'
      panel.style.top = Math.max(8, pos.top) + 'px'
      const body = panel.querySelector('[data-role=body]')
      const meta = panel.querySelector('[data-role=meta]')
      const copy = panel.querySelector('[data-role=copy]')
      let text = ''
      panel.querySelector('[data-role=close]').addEventListener('click', closeTranscript)
      panel.querySelector('[data-role=close2]').addEventListener('click', closeTranscript)
      copy.addEventListener('click', async () => {
        if (!text) return
        if (await copyText(text)) copy.textContent = '已复制'
      })
      const onDown = (event) => {
        if (!panel.contains(event.target)) closeTranscript()
      }
      setTimeout(() => document.addEventListener('pointerdown', onDown, { once: true }), 0)
      void api('/transcribe', { method: 'POST', body: { audioUrl: spec.audioUrl } })
        .then((data) => {
          text = String(data && data.text || '').trim()
          body.textContent = text || '这段音频没有识别出文字。'
          meta.textContent = data && data.warning ? data.warning : (data && data.source === 'stored' ? '来自原始文本' : '本地识别')
          copy.disabled = !text
        })
        .catch((error) => {
          body.textContent = '转文字失败：' + friendly(error)
          meta.textContent = '可尝试先播放或下载后重试。'
        })
    }

    function attachTranscriptMenu(wrap, spec) {
      const hint = '右键转文字'
      wrap.title = wrap.title ? `${wrap.title} · ${hint}` : hint
      wrap.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        event.stopPropagation()
        showTranscript(spec, wrap)
      })
    }

    function wxDuration(sec) {
      const total = Math.max(0, Math.round(Number(sec) || 0))
      return (total > 0 ? total : 1) + '″'
    }

    function createWeChatVoicePlayer(spec) {
      const wrap = h('section', 'dshv-wx-wrap')
      wrap.setAttribute('data-dshv-voice-player', '1')
      wrap.setAttribute('data-voice-reply-id', spec.voiceReplyId)
      if (spec.title) wrap.title = spec.title
      const seconds = Math.max(1, Number(spec.duration) || 1)
      const bubbleWidth = Math.round(Math.max(96, Math.min(238, 96 + seconds * 4.6)))
      const bubble = h('button', 'dshv-wx-voice')
      bubble.type = 'button'
      bubble.style.width = bubbleWidth + 'px'
      bubble.setAttribute('aria-label', '播放语音 ' + wxDuration(spec.duration))
      bubble.innerHTML = '<span class="dshv-wx-icon">' + I.mic + '</span>' +
        '<span class="dshv-wx-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>' +
        '<span class="dshv-wx-duration" data-role="duration">' + wxDuration(spec.duration) + '</span>'
      const audio = document.createElement('audio')
      audio.preload = 'metadata'
      audio.src = spec.audioUrl
      const err = h('span', 'dshv-wx-err')
      err.hidden = true
      wrap.appendChild(bubble)
      wrap.appendChild(err)
      wrap.appendChild(audio)
      wrap.__dshvAudio = audio
      attachTranscriptMenu(wrap, spec)

      const durationEl = bubble.querySelector('[data-role=duration]')
      audio.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) durationEl.textContent = wxDuration(audio.duration)
      })
      const setPlaying = (playing) => {
        bubble.classList.toggle('is-playing', playing)
        bubble.setAttribute('aria-label', (playing ? '暂停语音 ' : '播放语音 ') + durationEl.textContent)
      }
      audio.addEventListener('play', () => setPlaying(true))
      audio.addEventListener('pause', () => setPlaying(false))
      audio.addEventListener('ended', () => setPlaying(false))
      audio.addEventListener('error', () => {
        setPlaying(false)
        err.hidden = false
        err.textContent = '语音加载失败'
      })
      bubble.addEventListener('click', () => {
        err.hidden = true
        if (audio.paused) {
          const playing = audio.play()
          if (playing && typeof playing.catch === 'function') {
            playing.catch(() => {
              err.hidden = false
              err.textContent = '播放失败，请下载后播放'
            })
          }
        } else {
          audio.pause()
        }
      })
      return wrap
    }

    // All voice messages use the same WeChat-style voice bubble. Covers keep
    // their title in the tooltip and support right-click transcription too.
    function createVoicePlayer(spec) {
      return createWeChatVoicePlayer(spec)
    }

    /* ================= apply ================= */

    function apply(ctx) {
      if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}

      // 设置页「声音」区块：即使 React 尚未注入也要先注册槽位，组件会在
      // 下一次渲染时惰性取 React；不能因为 apply 时机早于模块系统就丢弃入口。
      try {
        if (ctx && ctx.slots && typeof ctx.slots.inject === 'function' && typeof ctx.slots.register === 'function') {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-voice-unified',
            order: 60,
            label: () => '声音',
            inject: () => ({}),
          }, VoiceSettingsSection))
        }
      } catch (error) {
        console.warn('[dsh-voice-unified] 设置页注册失败：', error)
      }

      if (window[BOOT_KEY]) return () => {}
      window[BOOT_KEY] = true

      const boot = () => {
        ensureStyles()
        ensurePanel()
        bindSessions(ctx)

        try {
          installFenceObserver()
        } catch (error) {
          console.warn('[dsh-voice-unified] 围栏观察器安装失败：', error)
        }

        // 预取设置，供围栏自动播放判断使用；失败静默，面板内会显示错误。
        void loadSettings()
          .then(() => flushPendingAutoplay())
          .catch(() => {})
      }

      if (document.body) boot()
      else document.addEventListener('DOMContentLoaded', boot, { once: true })

      try {
        const onKey = (event) => {
          if (event.key === 'Escape' && state.open) closePanel()
          if ((event.ctrlKey || event.metaKey) && event.shiftKey && String(event.key).toLowerCase() === 'v') {
            event.preventDefault()
            if (state.open) closePanel()
            else openPanel(state.active)
          }
        }
        document.addEventListener('keydown', onKey)
        state.keyHandler = onKey
      } catch (error) {
        /* ignore */
      }

      return () => {
        try {
          if (fence.observer) fence.observer.disconnect()
        } catch (error) {
          /* ignore */
        }
        stopPolling()
        if (state.badgeTimer) clearInterval(state.badgeTimer)
        if (state.keyHandler) document.removeEventListener('keydown', state.keyHandler)
        if (state.overlay && state.overlay.parentNode) state.overlay.parentNode.removeChild(state.overlay)
        if (state.fab && state.fab.parentNode) state.fab.parentNode.removeChild(state.fab)
        if (previewAudio && previewAudio.parentNode) previewAudio.parentNode.removeChild(previewAudio)
        if (typeof state.sessionUnsub === 'function') {
          try { state.sessionUnsub() } catch (error) { /* ignore */ }
        }
        window[BOOT_KEY] = false
      }
    }

    return { name: 'dsh-voice-unified', inject, apply }
  },
})
