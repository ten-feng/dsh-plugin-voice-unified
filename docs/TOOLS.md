# 工具接口文档

## 1. 调用方式

DSH 中模型实际看到两类入口：

1. **下划线别名**（DeepSeek 工具名语法 `^[a-zA-Z0-9_-]+$` 可用）
   例：`voice_profile_create`、`voice_speak`、`voice_cover_run`。
2. **统一入口 `voice`**
   ```json
   {"action":"voice.profile.create","params":{"name":"温柔男声","tags":["男声"]}}
   ```
   `action` 使用本文档中的精确点号命令名，`params` 与对应别名参数一致。

设 `DSH_VOICE_DOTTED_TOOLS=1` 时还会额外注册点号原名，供允许点号的宿主/提供方使用；
DeepSeek 官方 API 不接受点号，默认不要开启。

## 2. 必需命令（14 个）

| 精确命令名 | 下划线别名 | 作用 |
|---|---|---|
| `voice.profile.create` | `voice_profile_create` | 创建音色档案 |
| `voice.profile.addSample` | `voice_profile_add_sample` | 追加本地音频样本 |
| `voice.profile.train` | `voice_profile_train` | 异步训练/增量微调 |
| `voice.profile.list` | `voice_profile_list` | 列出音色摘要 |
| `voice.profile.setDefault` | `voice_profile_set_default` | 设置全局默认 |
| `voice.profile.rollback` | `voice_profile_rollback` | 回滚版本 |
| `voice.profile.preview` | `voice_profile_preview` | 试听并返回相似度 |
| `voice.reply.toggle` | `voice_reply_toggle` | 开关自动语音回复 |
| `voice.speak` | `voice_speak` | 用默认/临时音色朗读 |
| `voice.cover.run` | `voice_cover_run` | 异步翻唱 |
| `voice.cover.status` | `voice_cover_status` | 查询任务/列表 |
| `voice.cover.export` | `voice_cover_export` | 导出 MP3/WAV |
| `voice.music.bindCache` | `voice_music_bind_cache` | 绑定音乐缓存目录 |
| `voice.settings.update` | `voice_settings_update` | 更新语音设置 |

### 参数与返回

#### voice.profile.create

```json
{"name":"磁性男声","description":"低沉、克制","tags":["男声","低沉"],"base_voice":"Microsoft Huihui Desktop"}
```

返回文本：档案 id、下一步提示。名称重复/为空会报错。

#### voice.profile.addSample

```json
{"profile_id":"p_xxx","file":"C:\\samples\\a.wav","slice":true}
```

支持 wav/mp3/m4a/flac/ogg；长音频自动切片。返回新增样本、时长、质量、问题列表。

#### voice.profile.train

```json
{"profile_id":"p_xxx","note":"v2 追加 2 个样本"}
```

返回 `jobId`。训练异步；用 `voice.profile.list` 或档案详情查看
`training.status/progress/error`。失败可直接再次调用。

#### voice.profile.list

无参数。返回每个音色的样本数、总时长、最近训练、当前版本、状态、默认标记。

#### voice.profile.setDefault

```json
{"profile_id":"p_xxx"}
```

只允许已训练、启用中的档案。全局唯一。

#### voice.profile.rollback

```json
{"profile_id":"p_xxx","version_id":"v1"}
```

版本不删除，可回滚到任意历史版本。

#### voice.profile.preview

```json
{"profile_id":"p_xxx","text":"你好，这是试听。","emotion":"温柔","version_id":"v2"}
```

返回 `audioUrl`、时长、情感、相似度（0~100）。

#### voice.reply.toggle

```json
{"enabled":false}
```

`false` = 按需语音（默认）：仅当用户说“唱/说/语音/朗读/翻唱”等时语音；
`true` = 始终语音。返回最新开关状态。

#### voice.speak

```json
{"text":"晚安，做个好梦。","profile_id":"p_xxx","emotion":"温柔","deliver":true,"title":"晚安"}
```

- `profile_id` 省略 = 全局默认；临时指定不改变默认。
- `emotion` 省略 = 自动分析。
- `deliver` 默认 true，写入当前会话；false 仅生成文件。
- 语音回复省略过程：工具只返回简短结果，不向用户描述参数/路径/引擎步骤。

#### voice.cover.run

```json
{
  "source_path":"C:\\music\\demo.mp3",
  "song_name":"晚风里的旋律",
  "profile_id":"p_xxx",
  "deliver":true,
  "format":"mp3",
  "transcript":"雨纷飞，飞在天空里是我的眼泪……",
  "start_time":68.45,
  "end_time":82.0
}
```

`source_path` / `source_url` / `song_name` 至少一个。`transcript` 可选，用于右键转文字
（翻唱片段歌词）。`start_time` / `end_time` 可选但**片段翻唱必须使用**：`end_time` 要落在
整句歌词结束处，不要切在字中间；引擎会按该窗口从源文件重新截取。
`mode` 默认 `clean`（清唱+伴奏，主唱更清晰、原唱人声关闭）；传 `mix` 使用旧版均衡混音。
返回任务 id、歌曲、音色、直出状态。

#### voice.cover.status

```json
{"job_id":"c_xxx"}
```

省略 `job_id` 返回最近任务列表（`limit` 默认 10）。状态含
`queued/running/done/failed`、阶段、进度、日志、成品、失败原因。

#### voice.cover.export

```json
{"job_id":"c_xxx","format":"mp3","dest_path":"D:\\out\\cover.mp3"}
```

不指定 `dest_path` 返回成品文件路径；指定则复制到目标。

#### voice.music.bindCache

```json
{"directory":"C:\\Users\\你\\Music\\DSH"}
```

返回扫描到的音频文件数。目录不存在会明确报错。

#### voice.settings.update

```json
{
  "auto_reply":false,
  "intent_reply":true,
  "autoplay":true,
  "emotion_intensity":0.7,
  "speed":1.0,
  "volume":1.0,
  "cross_turn_emotion":true,
  "default_emotion":"calm",
  "reset_emotion":false,
  "max_reply_chars":600
}
```

返回最新设置。

## 3. 额外管理命令

| 精确命令名 | 别名 | 说明 |
|---|---|---|
| `voice.profile.update` | `voice_profile_update` | 改名/描述/标签/启停 |
| `voice.profile.delete` | `voice_profile_delete` | 删除克隆音色 |
| `voice.profile.versions` | `voice_profile_versions` | 版本列表 |
| `voice.cover.retry` | `voice_cover_retry` | 重试失败翻唱 |
| `voice.status` | `voice_status` | 全局状态/引擎状态 |

`voice.cover.retry` 复用原参数创建新任务，原任务保留。

## 4. HTTP API

管理界面使用同一套服务，API 基址：

```text
/plugins/dsh-voice-unified/api
```

常用端点：

```text
GET    /health
GET    /status
GET    /profiles
POST   /profiles
GET    /profiles/:id
PATCH  /profiles/:id
DELETE /profiles/:id
POST   /profiles/:id/default
POST   /profiles/:id/samples
POST   /profiles/:id/samples/:sampleId/delete
POST   /profiles/:id/samples/:sampleId/slice
POST   /profiles/:id/train
POST   /profiles/:id/preview
POST   /profiles/:id/rollback
GET    /profiles/:id/versions
GET    /settings
PATCH  /settings
POST   /synthesize
POST   /transcribe
POST   /cover/upload
POST   /cover/run
GET    /cover/jobs
GET    /cover/jobs/:id
POST   /cover/jobs/:id/retry
POST   /cover/jobs/:id/export
GET    /music/cache
POST   /music/bind-cache
POST   /music/use-current
GET    /file/<root-relative-path>      # 音频，支持 Range
GET    /audio/<root-relative-path>     # 兼容别名
```

上传样本 body：`{"filename":"a.wav","dataBase64":"..."}`，≤48MB。
所有错误返回 `{ok:false, code, error}`。

`POST /transcribe` body：`{"audioUrl":"/plugins/.../audio/..."}`。TTS 回复/试听优先返回
生成时的原始文本（`source:"stored"`）；翻唱若带 `transcript` 同样直接返回；否则用
Windows 本地 SAPI 识别（`source:"asr"`，可能不完全准确）。右键播放器即调用该接口。

## 5. 对话内语音围栏

服务端写入助手消息的文本：

````markdown
```dsh-voice
{"voiceReplyId":"vr_xxx","audioUrl":"/plugins/dsh-voice-unified/api/file/audio/replies/x.mp3","title":"语音回复","duration":4.2,"profileName":"温柔女声","emotion":"温柔","autoplay":true}
```
````

客户端按 JSON 内容识别（要求 `voiceReplyId` + `audioUrl`），隐藏代码块并渲染
播放器。历史消息不自动播放；新消息按设置尝试自动播放。
