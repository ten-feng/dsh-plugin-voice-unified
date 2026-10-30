# 验收标准逐项自测

测试环境：Windows 10/11 x64、DeepSeek Harness `0.2.1-rc.3`、DSH 自带 Python 3.12.14 +
numpy 2.3.5、内置 ffmpeg 3.0.1、Microsoft Huihui Desktop 中文 SAPI 音色。

## 结果总览

| # | 验收标准 | 结果 | 证据 |
|---|---|---|---|
| 1 | 创建至少 3 个音色，分别训练、试听、重命名、删除，并设一个默认 | ✅ | `tests/live-acceptance.mjs`：创建 A/B/C、训练、试听、改名、删除 C、设 A 为默认 |
| 2 | 默认音色在任意会话自动语音回复生效；切换后新回复用新音色 | ✅ | 真实 DSH 对话：自动回复播放器显示 `语音回复 · 验收改名-…`；切换默认后新回复使用新档案 |
| 3 | 追加样本重新训练后相似度可感知提升，且可回滚旧版本 | ✅ | 单样本 v1 相似度 84.8 → 追加到 3 样本 v2 88.7；回滚 v1 再回 v2 |
| 4 | 同一句文本在 7 种情感下语气明显差异 | ✅ | 7 个情感 F0 spread 31.66Hz，时长 7.97~12.72s；`tests/emotion-smoke.mjs` |
| 5 | 对缓存原唱执行翻唱，输出完整 MP3，音色与所选一致 | ✅ | 20.04s、481,533B MP3 + WAV；任务使用所选档案 |
| 6 | 翻唱完成默认直出语音回复，对话内可播放，也可手动导出 | ✅ | 真实 DSH 会话：自动语音播放器 + 翻唱播放器同时存在；刷新后仍为 2 个；导出成功 |
| 7 | 临时指定非默认音色完成单次翻唱且不改全局默认 | ✅ | live 验收：临时档案 C 翻唱，默认前后一致 |
| 8 | 训练/翻唱失败有明确错误和重试入口 | ✅ | 训练 `training.error` + 面板重试；翻唱 `failed/error/logs` + 红色提示 + 重试按钮 |
| 9 | 关闭自动回复后不自动播报；重新开启恢复 | ✅ | API/面板开关；关闭期间无新语音消息，开启后恢复 |
| 10 | 音乐缓存可正确读取用于翻唱；无缓存有明确提示 | ✅ | 绑定目录扫描 10 个文件；`NO_CACHE_FILE`/`CACHE_NOT_FOUND` 均有中文提示 |

## 实际测试记录

### 引擎

```text
node tests/engine/run-tests.mjs
PASS io: 长音频移调正确
PASS mix: 异采样率长度对齐
PASS error: 缺失输入非 0 退出
PASS stderr: 无 numpy 警告
ALL TESTS PASSED: 102 checks
```

### 核心链路

```text
node tests/core-smoke.mjs
ENGINE ok=true
SAMPLE 3 100 / 2.941 100 / 3.061 100
TRAIN_STATUS done
VERSIONS v1 sampleCount=3 similarity=73.1 preview=...
PREVIEW audioUrl=... duration=3.97
SPEAK audioUrl=... duration=3.68
OK
```

### 翻唱管线

```text
node tests/cover-smoke.mjs
JOB status=done stage=done progress=100
output.mp3 ... duration=20.04 size=481533
APPENDED 1 ```dsh-voice ... 翻唱 · 晚风里的旋律（示例）
```

### Live 验收（隔离 DSH 实例）

```text
node tests/live-acceptance.mjs http://127.0.0.1:61999
PASS 引擎健康检查
PASS 创建 3 个音色档案
PASS 异步训练任务创建
PASS 训练 v1 完成 — similarity=85.6
PASS v1 试听 — similarity=84.8
PASS 追加样本后重新训练 — v1 -> v2
PASS 相似度可感知提升 — 84.8 -> 88.7
PASS 回滚到旧版本 — v1
PASS 重命名与描述更新
PASS 训练音色 C / D
PASS 设置全局默认音色
PASS 七种情感标签均生成语音
PASS 关闭并重新开启自动语音回复
PASS 绑定音乐缓存目录 — 10 个文件
PASS 无缓存时明确提示
PASS 翻唱任务完成 — stage=done progress=100
PASS 输出完整 MP3 与 WAV — 20.04s / 481533B
PASS 对话内音频可 Range 播放 — HTTP 206
PASS 手动导出 MP3
PASS 临时指定非默认音色且不改默认
PASS 删除音色档案
SUMMARY passed=22 total=22
```

### 真实 DSH + 真实模型 + 真实浏览器

- 使用 Edge headless CDP 打开隔离 DSH Web。
- 选择 DeepSeek-V4.1-Flash，发送“请只回复：收到”。
- 助手回复后 1 秒内自动出现语音播放器，标签为默认音色。
- 继续发送“请调用 voice_profile_list 工具列出全部音色”，模型成功调用工具并生成
  26 秒语音回复。
- 在会话内发起翻唱，完成后出现第二个播放器（翻唱），刷新页面后两个播放器仍在，
  会话历史可正常加载。

截图：
- `examples/screenshots/management-panel.png`
- `examples/screenshots/auto-voice-reply.png`
- `examples/screenshots/cover-delivery.png`

### 客户端 DOM 冒烟

`tests/ui-cdp.mjs` 在真实 Edge 中通过：按钮、四页签、音色列表、设置/翻唱/状态切换、
围栏替换为播放器、原代码块隐藏、audio 元素存在。UI 开发自测另有 45 项 mock 断言。

### 按需语音 / 右键转文字（v1.1）

```text
迁移：旧状态 autoReply=true + modeVersion 缺失 → autoReply=false, intentReply=true ✔
API  /transcribe（TTS 回复 sidecar 文本）→ 200 {source:"stored"} ✔
API  /transcribe（无 sidecar WAV）→ 本地 SAPI 识别返回文本 ✔
Edge 右键播放器 → 浮层显示“雨纷飞，飞在天空里是我的眼泪。” + “来自原始文本” ✔
Edge 设置页默认值：autoReply=false，intentReply=true ✔
```

## 复现命令

```powershell
# 1. 纯引擎
node tests/engine/run-tests.mjs

# 2. 核心服务（使用 output/demo 素材）
node tests/core-smoke.mjs
node tests/cover-smoke.mjs
node tests/emotion-smoke.mjs

# 3. 启动隔离 DSH（先按 INSTALL 安装到 voicetest profile）
$env:DSH_HOME="C:\...\test-dsh-home"
$env:DSH_VOICE_HOME="C:\...\test-voice-home"
dsh --profile voicetest --port 61999 --host 127.0.0.1 --no-open

# 4. live 验收
node tests/live-acceptance.mjs http://127.0.0.1:61999

# 5. 真实浏览器 UI（需 Edge --remote-debugging-port=9222）
node tests/ui-cdp.mjs
```

## 未覆盖/环境相关

- 真人音色克隆相似度无法量化承诺；验收以“同版本参数下样本增加 → 相似度评分提升 +
  可听出转换强度变化”为准。
- 非 Windows 的 TTS 需要外部引擎；当前只在 Windows 实测。
- 不同 DSH 版本的会话事件结构可能变化；0.2.1-rc.3 已实测，其他版本需回归。
