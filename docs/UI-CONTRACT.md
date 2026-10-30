# dsh-voice-unified UI 契约（内部）

服务端 API 基址：`/plugins/dsh-voice-unified/api`。所有响应 `content-type: application/json`；
成功至少含 `ok: true`；失败 HTTP 4xx/5xx 且 `{ok:false, code:"...", error:"中文说明"}`。

## 客户端插件形状

```js
window.__ModuleLoader__.load({
  id: 'dsh-voice-unified',
  factory: (require) => {
    const inject = ['slots', 'locale']
    function apply(ctx) { /* 注册 settings.section；挂 DOM 管理面板；安装围栏观察器 */ }
    return { name: 'dsh-voice-unified', inject, apply }
  },
})
```

- 必须容忍 `ctx.slots`、`ctx.locale`、`ctx.sessions` 不存在。
- 建议在 `settings.section` 注册「声音」页；若设置页被 profile 禁用，右下/左下浮动按钮仍必须能打开管理面板。
- 管理面板为纯 DOM（可用 `require('react')` 但不要强依赖），四页：音色管理、语音设置、翻唱任务、全局状态。
- 不要把面板写进对话流；fixed 定位，可关闭，移动端宽度自适应。
- 围栏播放器：扫描 `.md-code-block`，解析 `pre` 文本 JSON；仅当对象含 `voiceReplyId` 与 `audioUrl` 时接管，隐藏代码块并插入播放器。
- 历史消息首次扫描只渲染、不自动播放；后续新增节点在 `settings.autoplay && settings.autoReply` 时尝试 `audio.play()`，失败静默显示播放按钮。
- 播放器需有：播放/暂停、进度条、时间、下载、音色/情绪标签、标题。
- 管理面板每 1.5s 轮询当前打开页的数据；训练/翻唱状态实时刷新。

## 读取

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok,platform,ttsEngine,ffmpeg,defaultProfileId,autoReply,activeJobs,engine:{ok,detail}}` |
| GET | `/profiles` | `{ok,defaultProfileId,profiles:[ProfileSummary]}` |
| GET | `/profiles/:id` | `{ok,profile:ProfileDetail}` |
| GET | `/profiles/:id/versions` | `{ok,versions:[Version]}` |
| GET | `/settings` | `{ok,settings:Settings}` |
| GET | `/cover/jobs?limit=30` | `{ok,jobs:[CoverJob]}` |
| GET | `/cover/jobs/:id` | `{ok,job:CoverJob}` |
| GET | `/music/cache` | `{ok,directories:[string],entries:[CacheEntry]}` |

### ProfileSummary

```json
{
  "id":"p_xxx","name":"温柔女声","description":"...","tags":["温柔","女声"],
  "kind":"builtin|cloned","status":"active|disabled","baseVoice":"Microsoft Huihui Desktop",
  "sampleCount":3,"totalDuration":12.8,"lastTrainedAt":"2026-10-30T...",
  "currentVersion":{"id":"v2","label":"v2","createdAt":"...","sampleCount":3,"quality":87},
  "isDefault":true
}
```

### ProfileDetail

`ProfileSummary` + `samples:[Sample]`、`versions:[Version]`。`Sample`：

```json
{"id":"s_x","filename":"a.wav","duration":3.2,"quality":88,"issues":[],"createdAt":"...","file":"profiles/p_x/samples/a.wav"}
```

`Version`：

```json
{"id":"v2","label":"v2","createdAt":"...","sampleCount":3,"status":"ready|training|failed",
 "metrics":{"similarity":81.2,"quality":88},"previewAudioUrl":"/plugins/.../audio/...","note":""}
```

### Settings

```json
{
  "autoReply": true, "emotionIntensity": 0.7, "speed": 1.0, "volume": 1.0,
  "crossTurnEmotion": true, "autoplay": true, "defaultEmotion": "calm",
  "cloudAuthorized": false, "maxReplyChars": 600
}
```

### CoverJob

```json
{
  "id":"c_xxx","songName":"demo","status":"queued|running|done|failed",
  "stage":"separating|converting|mixing|encoding|delivering|done",
  "progress":0,"deliver":true,"profileId":"p_xxx","profileName":"默认音色",
  "createdAt":"...","updatedAt":"...","logs":["[10:00:01] ..."],
  "output":{"mp3":"/plugins/.../audio/...","wav":"...","duration":23.4,"size":123456},
  "previewAudioUrl":"...","error":null,"downloadUrl":"/plugins/.../audio/...?download=1"
}
```

## 写入

| 方法 | 路径 | body |
|---|---|---|
| POST | `/profiles` | `{name,description?,tags?,kind?,baseVoice?}` |
| PATCH | `/profiles/:id` | `{name?,description?,tags?,status?,baseVoice?}` |
| DELETE | `/profiles/:id` | 无 |
| POST | `/profiles/:id/default` | 无 |
| POST | `/profiles/:id/samples` | `{filename,dataBase64,slice?}`（≤48MB，支持 wav/mp3/m4a/flac） |
| POST | `/profiles/:id/samples/:sampleId/delete` | 无 |
| POST | `/profiles/:id/samples/:sampleId/slice` | 无 |
| POST | `/profiles/:id/train` | `{note?}` → `{ok,jobId}`；训练完成看 ProfileDetail |
| POST | `/profiles/:id/rollback` | `{versionId}` |
| POST | `/profiles/:id/preview` | `{text?,emotion?,versionId?}` → `{ok,previewId,audioUrl,duration,similarity}` |
| PATCH | `/settings` | Settings 任意子集 |
| POST | `/synthesize` | `{text,profileId?,emotion?,sessionId?,deliver?}` |
| POST | `/cover/upload` | `{filename,dataBase64}` → `{ok,path}` |
| POST | `/cover/run` | `{sourcePath?,sourceUrl?,songName?,profileId?,sessionId?,deliver?,format?}` |
| POST | `/cover/jobs/:id/retry` | 无 |
| POST | `/cover/jobs/:id/export` | `{format?}` |
| POST | `/music/bind-cache` | `{directory}` |
| POST | `/music/use-current` | `{url,songName?}` → 下载音乐插件当前流到缓存 |

## 音频

`GET /audio/<rel>?download=1` 支持 Range。播放器直接将该 URL 作为 `<audio src>`。

## 围栏 JSON（服务端写入助手消息）

````markdown
```dsh-voice
{"voiceReplyId":"vr_xxx","audioUrl":"/plugins/dsh-voice-unified/api/audio/replies/vr_xxx.mp3","title":"语音回复","duration":4.2,"profileName":"温柔女声","emotion":"温柔","autoplay":true}
```
````

客户端只按 JSON 内容识别；允许未知键忽略，但必须有 `voiceReplyId` 和 `audioUrl`。

## 管理面板要点

1. 音色页：列表 + 新建 + 编辑名称/描述/标签 + 上传样本 + 训练 + 试听 + 设为默认 + 版本列表/回滚 + 删除。
2. 设置页：自动回复、自动播放、情感强度、语速、音量、跨轮情绪、重置情绪、默认情感。
3. 翻唱页：缓存列表/绑定目录、上传本地音频、选择音色、直出开关、开始翻唱、任务进度/日志/重试/导出/播放。
4. 状态页：默认音色、样本总数、最近训练时间、TTS/ffmpeg/引擎状态、当前队列。
5. 失败必须有红色错误文案和“重试”按钮。
