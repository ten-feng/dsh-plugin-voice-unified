# 示例音频与验收脚本

## 文件

```text
examples/
  demo/
    demo-original.wav       20 秒示例“原唱”：人声居中，伴奏左右声场不同
    demo-song-meta.json     歌曲与样本说明
    samples/profile-a|b|c/  三组各 3 个 3 秒样本（不同音色参数）
  sample-voice-preview.mp3  插件真实生成的语音回复示例
  screenshots/              管理面板、自动语音回复、翻唱直出截图
  seed-demo.mjs             通过运行中的 API 创建并训练 3 个验收音色
```

`demo-original.wav` 与样本由纯 numpy 合成，可复现；用于验证“分离→换声→混音”和
训练版本链路，不包含任何第三方版权音频。

## 用示例素材跑验收

```powershell
# 1. 启动 DSH（已安装插件）
#    假设 http://127.0.0.1:61999

# 2. 创建/训练 3 个示例音色，设 A 为默认
node examples/seed-demo.mjs http://127.0.0.1:61999

# 3. 打开管理面板查看 3 个音色与版本
```

`seed-demo.mjs` 会：

1. 依次创建 `示例音色A/B/C`；
2. 从 `demo/samples/profile-a|b|c` 上传样本；
3. 训练并等待完成；
4. 把 A 设为全局默认；
5. 打印每个音色的版本、相似度和试听 URL。

## 用示例原唱翻唱

管理面板「翻唱任务」：

1. 点「绑定缓存目录」，选择 `examples/demo`；
2. 在缓存列表选择 `demo-original.wav`；
3. 选择音色 A/B/C；
4. 保持“完成后直出语音回复”开启，点「开始翻唱」；
5. 约 3~5 秒后当前对话出现「翻唱 · demo-original」播放器，同时可导出 MP3/WAV。
