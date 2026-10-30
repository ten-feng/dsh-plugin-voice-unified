# 已知限制与故障排查

## 1. 音质与“克隆”的边界

- 本插件默认使用**本地 DSP 音色适配**：从样本估计基频、谱质心、亮度，训练出版本
  参数，再用相位声码器/频谱包络把 SAPI 合成结果往目标音色靠。
- 它不是神经声码器/RVC 级克隆。样本越多、越清晰，参数越稳定、转换强度越高，
  听感会逐步接近，但不可能达到真人级复刻。
- 这是有意的默认：**零上传、零云端授权、离线可用**。需要神经克隆时按
  [ARCHITECTURE.md](ARCHITECTURE.md) 替换 `sapiTts`/`convert` 引擎。
- 内置音色只有两个 Windows SAPI 基础声线（Huihui 中文女声、Zira 英文女声），
  其余“男声/少年/英文旁白”是 DSP 变声预设。

## 2. 工具名点号限制（平台约束）

DeepSeek API 校验工具名 `^[a-zA-Z0-9_-]+$`。如果直接注册
`voice.profile.create`，整个模型请求会失败：
`Invalid 'tools[N].name': string does not match pattern`。

本插件的处理：

- 默认注册 14 个下划线别名 + 统一 `voice` 入口；
- `voice` 的 `action` 取值是**精确点号命令名**，参数/返回完全一致；
- `DSH_VOICE_DOTTED_TOOLS=1` 可额外注册原名（仅用于允许点号的宿主/提供方）。

这是平台能力限制下的已实现降级，不是删除功能。

## 3. 音频与分离

- 人声分离是**中置/声道差分的轻量 DSP**，不是 Demucs/UVR 神经网络分离：
  - 立体声且人声居中的歌曲效果最好；
  - 单声道、现场版、人声偏侧的歌曲会残留伴奏或损失人声；
  - 需要更高质量时替换分离阶段即可。
- 翻唱输出默认 44.1kHz MP3 192k + WAV；不做响度标准化，只做峰值软限幅。
- 内置 ffmpeg 为 3.0.1 GPL 构建，支持本项目用到的 pan/aeval/highpass/lowpass/
  libmp3lame；极新的编码格式可能不支持，可设置 `DSH_VOICE_FFMPEG` 指向新版。
- 样本 WAV 支持 PCM 8/16/24/32-bit；float WAV 会明确报错，请先用 ffmpeg 转
  `pcm_s16le`。

## 4. 会话与浏览器

- **语音卡片采用「围栏优先」投递**：工具结果里带 ` ```dsh-voice ` 代码块，模型把它
  原样写进回复，客户端渲染成播放器。这条链路不写会话日志，因此不受回合是否打开、
  会话是否在线影响，也不会把历史写坏。
- 只有在「回合 + 步骤都在打开状态、且没有未完成工具调用」时，插件才会额外把卡片
  直接追加进会话；其余情况一律进 `state.pendingVoice` 队列（最多 20 条 / 12 小时），
  在下一个安全时机补投。**插件不会伪造 turn**——伪造 turn 会让
  `turn/start does not open the expected turn`，整段会话读不出来。
- 自动语音回复（`autoReply=true`）是后台触发的，没有模型回合可以承载围栏；因此它在
  回合进行中生成时只会进队列，需要等下一次安全补投。按需语音/翻唱（默认模式）不受影响。
- 浏览器自动播放策略可能拦截首条语音；播放器保留播放按钮，点击即可。
- 对话内播放器依赖 `.md-code-block` DOM。若 DSH 未来改版代码块结构，需要更新
  `client.js` 的观察器；当前 0.2.1-rc.3 已实测。
- 管理面板是 fixed 浮动层，与右下角音乐悬浮窗错开；窄屏按 100dvh 适配。

## 5. 按需语音与右键转文字

- 默认 `autoReply=false`、`intentReply=true`：只有用户明确说“唱/说/语音/朗读/念/翻唱/配音/播报”
  等时才自动生成语音；普通对话不会出声。
- 若希望每条回复都读，打开「始终语音回复」。
- 右键播放器“转文字”：
  - TTS 回复/试听有生成时的原始文本，转写 100% 准确；
  - 翻唱若传了 `transcript`/歌词，直接显示；否则用 Windows SAPI 中文识别，
    准确率有限（口音、伴奏、混响都会影响），只作为兜底。
- 转文字是本地处理，不上传音频。

## 6. 情感

- 情感分析是规则 + 标点/表情，不是模型分类；反讽、长段落混合情绪可能判断不准。
- 无情感信号时用默认情感/跨轮情绪；跨轮状态 20 分钟后自然失效，也可手动重置。
- 情感只改变韵律，不改写文本，因此不会改变原意。

## 7. 音乐缓存

- 默认扫描 `~/.dsh/music-cache`、`~/.dsh/music/cache`、`%LOCALAPPDATA%\dsh-music\cache`、
  `~/Music/DSH`。
- 当前 dsh-music 版本可能只在浏览器内流式播放、不落盘；此时：
  - 用翻唱页“从音乐插件当前曲目”抓取当前流到本地缓存；或
  - 直接上传本地音频。
- 完全没有缓存时返回 `NO_CACHE_FILE`；有缓存但按名称找不到返回 `CACHE_NOT_FOUND`。

## 8. 排查

### 左下角没有「声音」按钮

1. `dsh --profile desktop --dump-config | Select-String voice-unified` 是否有插件行。
2. 重启 DSH（客户端插件需要重新加载）。
3. 查看 DSH 日志是否有 `[dsh-voice-unified] init failed`。
4. 直接访问 `/plugins/dsh-voice-unified/api/health`；若 404，宿主半区未加载。

### health 返回 engine.ok=false

- `tts: unavailable`：不是 Windows，或没有 SAPI 中文音色。
- `python.installed=false`：设置 `DSH_VOICE_PYTHON` 指向带 numpy 的 Python。
- `ffmpeg.installed=false`：检查 `bin/ffmpeg.exe` 是否存在/被杀软隔离。

### 训练失败

- 看档案 `training.error` 与 `voice.status` 的 `lastError`。
- 常见：样本太短/全静音/格式不支持/磁盘权限。
- 训练失败不影响旧版本，可直接重试。

### 翻唱失败

- 看任务 `error` 与 `logs`（UI 红色错误 + 重试）。
- `NO_SOURCE` / `SOURCE_NOT_FOUND`：路径/上传问题。
- `NO_CACHE_FILE` / `CACHE_NOT_FOUND`：先缓存或上传本地音频。
- `FFMPEG_FAILED`：输入编码不支持或文件损坏；用播放器确认文件可播放。
- `DSP_FAILED`：看日志末尾 stderr；通常是 WAV 格式/磁盘/内存问题。

### 自动回复没有声音

1. 语音设置里自动语音回复是否开启。
2. 全局状态里默认音色是否已训练/启用。
3. 浏览器是否拦截自动播放（点播放器按钮）。
4. 看 `voice.status` 的 `lastError`；TTS 失败会记录但不阻塞对话。

### 会话历史加载失败 / 日志损坏

早期版本会把语音卡片写到已关闭的回合（伪造 turn），导致
`SessionFormatError: turn/start does not open the expected turn`。1.5.4 起已彻底移除
伪造 turn 的路径：

- 投递改为围栏优先，正常情况根本不写会话日志；
- 需要写入时会先校验 `turn`/`step` 真的处于打开状态，并且没有未完成工具调用；
- 写失败或条件不满足时进 `state.pendingVoice` 持久化队列，不再丢卡片、也不再动日志。

如果旧会话在升级前已经被写坏：该会话的 `session.v4.jsonl.zstd` 保留以取证，界面里
打不开属于历史数据问题，新会话不受影响。不要手动编辑压缩日志。
