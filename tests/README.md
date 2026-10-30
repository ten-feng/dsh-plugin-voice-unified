# 测试说明

| 文件 | 作用 |
|---|---|
| `tests/engine/run-tests.mjs` | 调用 Python 引擎 102 项断言 |
| `tests/core-smoke.mjs` | 建档→样本→训练→试听→语音合成 |
| `tests/cover-smoke.mjs` | 20 秒示例原唱→完整翻唱→写入模拟会话 |
| `tests/emotion-smoke.mjs` | 同一句文本 7 种情感，测 F0/时长差异 |
| `tests/api-smoke.mjs` | 启动本地 HTTP 服务，测 API/上传/训练/Range |
| `tests/live-acceptance.mjs` | 对运行中的隔离 DSH 跑 10 条验收的 22 项检查 |
| `tests/ui-cdp.mjs` | 真实 Edge CDP：面板、页签、围栏播放器 |

运行前先生成示例素材：

```powershell
python engine/voice_engine.py demo --outdir output/demo --json output/demo/result.json
```

`live-acceptance` 需要已安装插件并运行隔离 DSH（见 `docs/ACCEPTANCE.md`）。
`ui-cdp` 需要 Edge 以 `--remote-debugging-port=9222` 打开 DSH 页面。
