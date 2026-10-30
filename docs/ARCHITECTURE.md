# 架构与引擎替换

## 模块边界

```text
index.js
  ├─ VoiceStore          state.json / 目录布局 / 原子写
  ├─ AudioEngine         SAPI + ffmpeg + Python DSP 的统一调用层
  ├─ VoiceService        档案、样本、训练版本、情感 TTS、试听、设置
  ├─ CoverService        翻唱队列、阶段、日志、直出、导出
  ├─ MusicCache          缓存目录扫描/监听、URL 下载、按名查找
  ├─ SessionDelivery     持久化助手语音消息（含回合/步骤安全写入）
  ├─ createApi           HTTP 管理/音乐桥接/音频 Range
  └─ tools.mjs           14 个命令 + 别名 + voice 统一入口
```

各模块只依赖对方的窄接口：

- `VoiceService` 不知道 HTTP/UI，只接收文本、档案、输出目录。
- `CoverService` 不知道 SAPI，只调用 `AudioEngine` 的
  `decodeToWav/convert/mix/encodeAudio`。
- `SessionDelivery` 只依赖 `ctx.sessions` 和 session 事件结构。
- `AudioEngine` 可整体替换为外部命令/云端适配器；上层不依赖 ffmpeg 参数。
- `MusicCache` 只产出 `{path, songName}`，翻唱不关心来源。

## 音频处理链

```text
文本
 → Windows SAPI 合成 WAV（本地）
 → Python 相位声码器/频谱包络处理（音高/共振峰/亮度/变速/颤音）
 → ffmpeg 编码 MP3/WAV
 → 文件 URL

原唱
 → ffmpeg 解码 44.1kHz 立体声
 → 中置人声 / 左右差分伴奏
 → Python 音色转换
 → Python 混音（软限幅）
 → ffmpeg MP3 + WAV
```

## 引擎替换点

### TTS

`AudioEngine.sapiTts()` 是唯一 TTS 调用点。要接 GPT-SoVITS / CosyVoice / Azure /
本地神经 TTS，实现同样输入输出即可：

```js
await engine.sapiTts({ text, outWav, voice, rate, volume, pauseMs })
// 产出 16-bit PCM WAV 到 outWav
```

或继承 `AudioEngine` 覆盖 `sapiTts`，在 `index.js` 构造时传入子类。

### 变声 / 情感

`AudioEngine.convert()` / `emotion()` / `mix()` 调用
`engine/voice_engine.py`。要换 RVC/So-VITS 等，只需让对应方法产出同格式 WAV：

```js
await engine.convert(inputWav, outputWav, { pitchSemitones, formant, strength, speed, vibrato })
```

### 人声分离

`CoverService` 里唯一的 ffmpeg `filter_complex` 是分离点。要换 Demucs/UVR，替换为
外部命令并输出 `vocal.wav` + `instrumental.wav` 即可；其余阶段不变。

### 云端引擎

默认**不启用**云端。若要接云端：

1. 在设置/环境变量中显式设置 `cloudAuthorized: true` 或你自己的授权变量；
2. 新增适配器实现与 `sapiTts` 相同的接口；
3. 在文档和 UI 中明确数据会离开本机；
4. 失败必须回退/报错，不得静默上传样本。

当前实现不包含任何云端上传代码。

## 会话输出设计

- **围栏优先**：`SessionDelivery.deliver()` 总是返回一个 `dsh-voice` 围栏
  （`{ ok, mode: 'fence', fence }`）。工具把它放进结果，模型原样写进最终回复，
  客户端把该代码块渲染成播放器。这条路径不写会话日志，天然免疫回合边界问题。
- 只有同时满足「`turn` 与 `step` 都处于打开状态」且「没有未完成工具调用」时，
  才会额外走 `mode: 'session'`：把围栏作为 `assistant/message` 追加进当前
  `turn/step`（此时 tool_use 一定已经有 tool_result，不会触发服务端
  `INVALID_REQUEST`）。
- **绝不伪造 turn**。早期版本在回合关闭后会补一个自包含合成回合，实际会让日志
  校验失败（`turn/start does not open the expected turn`），整段会话读不出来。
- 条件不满足时卡片进入 `state.pendingVoice`（去重、最多 20 条、12 小时过期），
  在后续 `tool/result` / `step/end` / `turn/end` 边界由 `flushPending()` 补投；
  能补投就补投，不能就继续等，绝不丢弃。
- 任何失败都被捕获，只记录 `lastError`/日志，不向 `turn-stopping` 抛错，因此不阻塞
  普通对话。
