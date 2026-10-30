/** DSH tool surface. Every tool is a thin, validated facade over the services. */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { formatDuration } from './util.mjs'

function jsonText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/** 播放器围栏必须由模型原样回写，客户端才会渲染成语音气泡。 */
const FENCE_INSTRUCTION = '下面这个 dsh-voice 代码块是语音播放器，必须原样放进你的最终回复（单独一段，不要改动或转述其中的 JSON，不要再说“已发送”）：'

function outputSpec() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }
}

function profileLine(profile) {
  return `${profile.isDefault ? '★ ' : ''}${profile.name}（${profile.id}）｜${profile.kind === 'builtin' ? '内置' : '克隆'}｜${profile.status === 'active' ? '启用' : '停用'}｜样本 ${profile.sampleCount}｜时长 ${formatDuration(profile.totalDuration)}｜版本 ${profile.currentVersion?.label || '未训练'}｜最近训练 ${profile.lastTrainedAt ? new Date(profile.lastTrainedAt).toLocaleString('zh-CN') : '从未'}`
}

export function registerTools(ctx, services) {
  const contracts = new Map()
  const add = (spec) => {
    const execute = spec.execute
    const contract = spec.name
    const safeName = contract.replace(/\./g, '_')
    const wrapped = async (args, exec) => {
      await services.ready
      return execute(args, exec)
    }
    contracts.set(contract, { parameters: spec.parameters || {}, execute, description: spec.description })
    ctx.tools.register(defineTool({
      name: safeName,
      description: `[${contract}] ${spec.description}`,
      parameters: spec.parameters || {},
      output: outputSpec(),
      execute: wrapped,
    }))
    // Optional compatibility for hosts/providers whose tool-name grammar permits
    // dots. DeepSeek's API rejects them (`^[a-zA-Z0-9_-]+$`), so this is opt-in.
    if (process.env.DSH_VOICE_DOTTED_TOOLS === '1') {
      ctx.tools.register(defineTool({
        name: contract,
        description: spec.description,
        parameters: spec.parameters || {},
        output: outputSpec(),
        execute: wrapped,
      }))
    }
  }
  const voice = () => services.voice
  const covers = () => services.covers
  const musicCache = () => services.musicCache
  const engine = () => services.engine

  add({
    name: 'voice.profile.create',
    description: '创建一个新的克隆音色档案。创建后需要上传样本并训练。',
    parameters: {
      name: { type: 'string', required: true, description: '音色名称，例如「磁性男声」' },
      description: { type: 'string', description: '音色描述' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签，例如 ["男声","低沉"]' },
      base_voice: { type: 'string', description: '底层 TTS 音色，默认 Microsoft Huihui Desktop' },
    },
    async execute(args) {
      const profile = voice().createProfile({
        name: args.name,
        description: args.description,
        tags: args.tags,
        baseVoice: args.base_voice,
      })
      return `已创建音色「${profile.name}」（${profile.id}）。请上传 2~5 段 3~15 秒参考音频，然后调用 voice.profile.train 训练。`
    },
  })

  add({
    name: 'voice.profile.addSample',
    description: '向已有音色档案追加参考音频样本（本地文件路径）。支持 wav/mp3/m4a/flac/ogg；长音频可自动切片。',
    parameters: {
      profile_id: { type: 'string', required: true, description: '音色档案 id' },
      file: { type: 'string', required: true, description: '本地音频绝对路径' },
      slice: { type: 'boolean', description: '是否按静音切片（长音频默认自动切片）' },
    },
    async execute(args) {
      const fs = await import('node:fs/promises')
      const buffer = await fs.readFile(args.file)
      const result = await voice().addSample(args.profile_id, {
        buffer,
        filename: args.file.split(/[\\/]/).pop(),
        slice: Boolean(args.slice),
      })
      const lines = result.samples.map((sample) => `- ${sample.filename}｜${formatDuration(sample.duration)}｜质量 ${sample.quality}${sample.issues?.length ? `｜${sample.issues.join('、')}` : ''}`)
      return `已追加 ${result.samples.length} 个样本到「${result.profile.name}」。\n${lines.join('\n')}\n当前样本 ${result.profile.sampleCount} 个，总时长 ${formatDuration(result.profile.totalDuration)}。请重新训练以生成新版本。`
    },
  })

  add({
    name: 'voice.profile.train',
    description: '异步训练/增量微调音色。样本越多转换强度与相似度越高；返回训练任务 id，可稍后循环查看档案状态。',
    parameters: {
      profile_id: { type: 'string', required: true, description: '音色档案 id' },
      note: { type: 'string', description: '版本备注' },
    },
    async execute(args) {
      const result = await voice().train(args.profile_id, args.note)
      return `已开始训练「${result.profile.name}」，任务 ${result.jobId}，当前样本 ${result.profile.sampleCount} 个。训练异步执行；失败原因会写回档案 training.error，可直接重试。`
    },
  })

  add({
    name: 'voice.profile.list',
    description: '列出全部音色档案，含样本数、总时长、最近训练时间、当前版本、状态、全局默认标记。',
    parameters: {},
    async execute() {
      const list = voice().list()
      if (!list.length) return '还没有音色档案。'
      return `共 ${list.length} 个音色，全局默认：${list.find((profile) => profile.isDefault)?.name || '未设置'}\n${list.map(profileLine).join('\n')}`
    },
  })

  add({
    name: 'voice.profile.setDefault',
    description: '设置全局唯一默认音色。所有会话的自动语音回复、默认翻唱都会使用它。',
    parameters: {
      profile_id: { type: 'string', required: true, description: '音色档案 id' },
    },
    async execute(args) {
      const result = voice().setDefault(args.profile_id)
      return `全局默认音色已切换为「${result.profile.name}」。之后的新语音回复和默认翻唱都会使用它。`
    },
  })

  add({
    name: 'voice.profile.rollback',
    description: '将音色回滚到历史版本。版本不删除，可再次切换。',
    parameters: {
      profile_id: { type: 'string', required: true, description: '音色档案 id' },
      version_id: { type: 'string', required: true, description: '版本 id，例如 v1、v2' },
    },
    async execute(args) {
      const result = voice().rollback(args.profile_id, args.version_id)
      return `已把「${result.profile.name}」回滚到 ${result.version.label}（${result.version.id}）。`
    },
  })

  add({
    name: 'voice.profile.preview',
    description: '用指定音色/版本试听一段文本，返回试听音频 URL、时长和相似度。',
    parameters: {
      profile_id: { type: 'string', required: true, description: '音色档案 id' },
      text: { type: 'string', description: '试听文本，默认一句问候' },
      emotion: { type: 'string', description: '情感：平静/开心/温柔/严肃/安慰/兴奋/低落' },
      version_id: { type: 'string', description: '指定历史版本，默认当前版本' },
    },
    async execute(args) {
      const result = await voice().preview(args.profile_id, {
        text: args.text,
        emotion: args.emotion,
        versionId: args.version_id,
      })
      return `试听已生成：${result.audioUrl}\n时长 ${formatDuration(result.duration)}｜情感 ${result.emotion}${result.similarity != null ? `｜相似度 ${result.similarity}` : ''}`
    },
  })

  add({
    name: 'voice.reply.toggle',
    description: '切换“始终语音回复”。默认关闭：只在用户明确要求唱/说/语音/朗读/翻唱时语音；开启后每条回复都语音。',
    parameters: {
      enabled: { type: 'boolean', required: true, description: 'true 开启，false 关闭' },
    },
    async execute(args) {
      const settings = voice().updateSettings({ autoReply: Boolean(args.enabled) })
      return `自动语音回复已${settings.autoReply ? '开启' : '关闭'}。`
    },
  })

  add({
    name: 'voice.speak',
    description: '用默认或临时指定音色朗读一段文本。可选择直接作为语音回复发送到当前会话；临时音色不改变全局默认。',
    parameters: {
      text: { type: 'string', required: true, description: '要朗读的文本' },
      profile_id: { type: 'string', description: '临时指定音色 id；省略则用全局默认' },
      emotion: { type: 'string', description: '情感：平静/开心/温柔/严肃/安慰/兴奋/低落；省略则自动分析' },
      deliver: { type: 'boolean', description: '是否作为语音回复写入当前会话，默认 true' },
      title: { type: 'string', description: '语音标题' },
    },
    async execute(args, exec) {
      const result = await voice().speak({
        text: args.text,
        profileId: args.profile_id,
        emotion: args.emotion,
        sessionId: exec.agent?.id,
        deliver: args.deliver !== false,
        title: args.title,
      })
      if (result.delivered?.mode === 'session') return '语音已发送到当前会话。'
      if (result.delivered?.fence) {
        return `${FENCE_INSTRUCTION}\n\n${result.delivered.fence}`
      }
      if (result.delivered?.error) return `语音已生成，但未写入会话：${result.delivered.error}`
      return `语音已生成：${result.audioUrl}`
    },
  })

  add({
    name: 'voice.cover.run',
    description: '异步翻唱：输入原唱文件/URL，按「人声分离→换声→混音→输出」处理，默认完成后直出语音回复。片段翻唱请用 start_time/end_time 落在整句歌词结束处，避免在字中间截断。',
    parameters: {
      source_path: { type: 'string', description: '原唱本地文件绝对路径（优先）' },
      source_url: { type: 'string', description: '音乐插件音频 URL' },
      song_name: { type: 'string', description: '歌曲名，用于缓存查找和标题' },
      profile_id: { type: 'string', description: '临时指定已训练音色；省略用全局默认，不改变默认' },
      deliver: { type: 'boolean', description: '是否完成后直出语音回复，默认 true' },
      format: { type: 'string', description: 'mp3（默认）或 wav；两种都会保留' },
      transcript: { type: 'string', description: '可选：这段翻唱的歌词/文字，用于右键转文字' },
      start_time: { type: 'number', description: '可选：原唱片段开始秒数' },
      end_time: { type: 'number', description: '可选：原唱片段结束秒数，必须落在整句歌词结束处，不要切在字中间' },
      pitch_offset: { type: 'number', description: '可选：额外升降调（半音）。负数让人声更低、更不像原唱，范围 -6~6' },
    },
    async execute(args, exec) {
      if (!args.source_path && !args.source_url && !args.song_name) {
        throw new Error('请提供 source_path、source_url 或 song_name。若音乐插件没有缓存，请先在音乐插件缓存歌曲，或手动指定本地音频。')
      }
      const result = await covers().enqueue({
        sourcePath: args.source_path,
        sourceUrl: args.source_url,
        songName: args.song_name,
        profileId: args.profile_id,
        sessionId: exec.agent?.id,
        deliver: args.deliver !== false,
        format: args.format,
        transcript: args.transcript,
        startTime: args.start_time,
        endTime: args.end_time,
        pitchOffset: args.pitch_offset,
      })
      return `翻唱已提交（${result.job.id}），完成后会直接作为语音回复出现。`
    },
  })

  add({
    name: 'voice.cover.status',
    description: '查看翻唱任务状态、阶段、进度、日志、成品与失败原因。省略 job_id 时列出最近任务。',
    parameters: {
      job_id: { type: 'string', description: '翻唱任务 id' },
      limit: { type: 'number', description: '列表数量，默认 10' },
    },
    async execute(args) {
      if (!args.job_id) {
        const jobs = covers().list(args.limit || 10).map((job) => covers().publicJob(job))
        return jsonText(jobs.map((job) => ({
          id: job.id,
          song: job.songName,
          status: job.status,
          stage: job.stage,
          progress: job.progress,
          profile: job.profileName,
          error: job.error,
          output: job.output,
        })))
      }
      const job = covers().get(args.job_id)
      if (!job) throw new Error(`翻唱任务不存在：${args.job_id}`)
      const pub = covers().publicJob(job)
      const header = `任务 ${pub.id}｜${pub.songName}\n状态：${pub.status}｜阶段：${pub.stage}｜进度：${pub.progress}%\n音色：${pub.profileName}｜直出：${pub.deliver ? '是' : '否'}\n${pub.output?.mp3 ? `成品 MP3：${pub.output.mp3}\n成品 WAV：${pub.output.wav}` : ''}${pub.error ? `\n失败：${pub.error}` : ''}`
      const fence = job.delivery?.fence || ''
      if (fence && job.status === 'done') {
        return `${header}\n\n${FENCE_INSTRUCTION}\n\n${fence}`
      }
      return `${header}\n日志：\n${(pub.logs || []).slice(-20).join('\n')}`
    },
  })

  add({
    name: 'voice.cover.export',
    description: '导出翻唱成品为 mp3 或 wav。可指定目标路径；不指定时返回成品文件路径。',
    parameters: {
      job_id: { type: 'string', required: true, description: '翻唱任务 id' },
      format: { type: 'string', description: 'mp3 或 wav' },
      dest_path: { type: 'string', description: '目标文件绝对路径（可选）' },
    },
    async execute(args) {
      const result = await covers().export(args.job_id, { format: args.format, destPath: args.dest_path })
      return `已导出 ${result.format.toUpperCase()}：${result.path}${result.downloadUrl ? `\n下载：${result.downloadUrl}` : ''}`
    },
  })

  add({
    name: 'voice.music.bindCache',
    description: '绑定音乐插件缓存目录，并立即扫描其中的原唱音频。也可用于告诉翻唱流水线去哪里找缓存文件。',
    parameters: {
      directory: { type: 'string', required: true, description: '缓存目录绝对路径' },
    },
    async execute(args) {
      const result = await musicCache().bind(args.directory)
      return `已绑定音乐缓存目录：${args.directory}\n扫描到 ${result.entries.length} 个音频文件。`
    },
  })

  add({
    name: 'voice.settings.update',
    description: '更新语音设置：按需/始终语音回复、情感强度、语速、音量、跨轮情绪、默认情感、自动播放、回复字数上限。',
    parameters: {
      auto_reply: { type: 'boolean', description: '始终自动语音回复（默认关闭；关闭时仅按用户要求语音）' },
      intent_reply: { type: 'boolean', description: '按需语音回复：用户提到唱/说/语音/朗读/翻唱等才生成（默认开启）' },
      autoplay: { type: 'boolean', description: '语音回复自动播放开关' },
      emotion_intensity: { type: 'number', description: '情感强度 0~1' },
      speed: { type: 'number', description: '语速 0.75~1.3' },
      volume: { type: 'number', description: '音量 0~1.5' },
      cross_turn_emotion: { type: 'boolean', description: '跨轮情绪状态' },
      default_emotion: { type: 'string', description: '无情感信号时的默认语气' },
      reset_emotion: { type: 'boolean', description: '重置跨轮情绪状态' },
      max_reply_chars: { type: 'number', description: '自动语音最大字数 80~1200' },
    },
    async execute(args) {
      const patch = {}
      if (args.auto_reply !== undefined) patch.autoReply = args.auto_reply
      if (args.intent_reply !== undefined) patch.intentReply = args.intent_reply
      if (args.autoplay !== undefined) patch.autoplay = args.autoplay
      if (args.emotion_intensity !== undefined) patch.emotionIntensity = args.emotion_intensity
      if (args.speed !== undefined) patch.speed = args.speed
      if (args.volume !== undefined) patch.volume = args.volume
      if (args.cross_turn_emotion !== undefined) patch.crossTurnEmotion = args.cross_turn_emotion
      if (args.default_emotion !== undefined) patch.defaultEmotion = args.default_emotion
      if (args.reset_emotion) patch.resetEmotion = true
      if (args.max_reply_chars !== undefined) patch.maxReplyChars = args.max_reply_chars
      const settings = voice().updateSettings(patch)
      return `语音设置已更新：${jsonText({
        autoReply: settings.autoReply,
        intentReply: settings.intentReply,
        autoplay: settings.autoplay,
        emotionIntensity: settings.emotionIntensity,
        speed: settings.speed,
        volume: settings.volume,
        crossTurnEmotion: settings.crossTurnEmotion,
        defaultEmotion: settings.defaultEmotion,
        maxReplyChars: settings.maxReplyChars,
      })}`
    },
  })

  add({
    name: 'voice.profile.update',
    description: '重命名音色、修改描述/标签，或启用/停用音色。',
    parameters: {
      profile_id: { type: 'string', required: true, description: '音色档案 id' },
      name: { type: 'string', description: '新名称' },
      description: { type: 'string', description: '新描述' },
      tags: { type: 'array', items: { type: 'string' }, description: '新标签' },
      status: { type: 'string', description: 'active 或 disabled' },
    },
    async execute(args) {
      const profile = voice().updateProfile(args.profile_id, {
        name: args.name,
        description: args.description,
        tags: args.tags,
        status: args.status,
      })
      return `已更新音色「${profile.name}」：${profile.status === 'active' ? '启用' : '停用'}${profile.isDefault ? '（全局默认）' : ''}`
    },
  })

  add({
    name: 'voice.profile.delete',
    description: '删除一个克隆音色档案及其样本/版本音频（内置音色不可删除）。',
    parameters: {
      profile_id: { type: 'string', required: true, description: '音色档案 id' },
    },
    async execute(args) {
      const result = await voice().deleteProfile(args.profile_id)
      return `已删除音色 ${result.id}。当前全局默认：${result.defaultProfileId || '未设置'}`
    },
  })

  add({
    name: 'voice.profile.versions',
    description: '列出一个音色的全部训练版本、样本数、训练时间、相似度与试听地址。',
    parameters: {
      profile_id: { type: 'string', required: true, description: '音色档案 id' },
    },
    async execute(args) {
      const versions = voice().versions(args.profile_id)
      if (!versions.length) return '该音色还没有训练版本。'
      return versions.map((version) => `${version.isCurrent ? '★ ' : ''}${version.label}｜${new Date(version.createdAt).toLocaleString('zh-CN')}｜样本 ${version.sampleCount}｜相似度 ${version.metrics?.similarity ?? '-'}｜${version.previewAudioUrl || '无试听'}`).join('\n')
    },
  })

  add({
    name: 'voice.cover.retry',
    description: '重试失败的翻唱任务，复用原参数与音色选择。',
    parameters: {
      job_id: { type: 'string', required: true, description: '失败的翻唱任务 id' },
    },
    async execute(args) {
      const result = await covers().retry(args.job_id)
      return `已重试，新任务：${result.job.id}（原任务 ${args.job_id}）`
    },
  })

  add({
    name: 'voice.status',
    description: '查看声音插件全局状态：默认音色、样本总数、最近训练、TTS/ffmpeg/DSP 引擎、活动任务与最近错误。',
    parameters: {},
    async execute() {
      const status = await engine().status()
      const store = services.store
      const defaultProfile = store.defaultProfile()
      const samples = store.state.profiles.reduce((sum, profile) => sum + (profile.samples?.length || 0), 0)
      return jsonText({
        defaultProfile: defaultProfile ? voice().summary(defaultProfile) : null,
        profiles: store.state.profiles.length,
        samples,
        engine: status,
        activeJobs: covers().list(20).filter((job) => job.status === 'queued' || job.status === 'running').map((job) => ({ id: job.id, song: job.songName, progress: job.progress })),
        lastError: store.state.lastError,
        settings: voice().settingsView(),
      })
    },
  })

  // DeepSeek's tool-name grammar only accepts `^[a-zA-Z0-9_-]+$`, so a literal
  // dotted tool name cannot be sent on the wire. This umbrella preserves the
  // exact required command vocabulary as `action` values and routes each call
  // to the same implementation used by the safe-name aliases above.
  const actions = [...contracts.keys()]
  ctx.tools.register(defineTool({
    name: 'voice',
    description: `统一声音命令入口。action 必须取以下精确值之一：${actions.join('、')}。params 为对应命令的参数对象；例如 {"action":"voice.profile.create","params":{"name":"温柔男声"}}。`,
    parameters: {
      action: { type: 'string', required: true, description: `精确命令名，可选：${actions.join(' / ')}` },
      params: { type: 'object', additionalProperties: true, description: '命令参数对象，字段与对应 voice_* 工具一致' },
    },
    output: outputSpec(),
    async execute(args, exec) {
      await services.ready
      const entry = contracts.get(args.action)
      if (!entry) throw new Error(`未知声音命令：${args.action}。可用：${actions.join('、')}`)
      const params = { ...(args.params || {}) }
      return entry.execute(params, exec)
    },
  }))
}

