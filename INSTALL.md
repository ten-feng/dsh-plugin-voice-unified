# 安装与升级

## 1. 系统要求

- Windows 10/11 x64（Windows 优先；macOS/Linux 预留外部引擎接口，见“非 Windows”）。
- DeepSeek Harness ≥ 0.2.1-rc.3（当前测试版本）。
- Windows 自带中文 TTS 音色：`Microsoft Huihui Desktop`。可在
  “设置 → 时间和语言 → 语音”里添加中文语音包。
- 插件默认使用 `bin/ffmpeg.exe`（GPL 构建）。**GitHub 仓库出于体积原因不附带
  该二进制**，请二选一：
  - 把 ffmpeg.exe 放到 `bin\ffmpeg.exe`（`bin\ffprobe.exe` 可选）；或
  - 设置 `DSH_VOICE_FFMPEG` 指向系统里已有的 ffmpeg。
  否则「健康检查」会显示 `ffmpeg.installed=false`，人声分离/编码类功能不可用。
- 插件使用 DSH 自带 Python（含 numpy）。如果 DSH 运行时没有 Python，设置
  `DSH_VOICE_PYTHON` 指向一个带 numpy 的 Python 3.10+ 即可。

## 2. 安装

### 方式 A：本地目录（开发/验收推荐）

```powershell
# 进入插件目录
cd "C:\你的路径\dsh-voice-unified"

# 安装到 desktop profile（profile 名按需替换为 web/desktop）
dsh plugin --profile desktop add "link:C:\你的路径\dsh-voice-unified"

# 确认插件行已进入组合
dsh --profile desktop --dump-config | Select-String "voice-unified"
```

安装器会自动把 `dsh-voice-unified` 加入 `package.json` 的
`dsh.profile.bundles`，并把包链接到 profile 的 `node_modules`。

### 方式 B：压缩包

```powershell
Expand-Archive .\dsh-voice-unified-1.0.0.zip -DestinationPath C:\dsh-plugins
dsh plugin --profile desktop add "link:C:\dsh-plugins\dsh-voice-unified"
```

### 方式 C：npm tarball

```powershell
dsh plugin --profile desktop add "C:\路径\dsh-voice-unified-1.0.0.tgz"
```

## 3. 重启并验证

1. 完全退出 DeepSeek Harness（托盘也退出），再启动。
2. 打开左下角「声音」按钮，应出现四页管理面板。
3. 访问：
   `http://127.0.0.1:<端口>/plugins/dsh-voice-unified/api/health`
   应返回 `"ok": true`、`"engine": {"ok": true}`。
4. 对话框输入“查看声音插件状态”，模型应能调用 `voice_status` 并返回引擎状态。

> 如果左下角没有按钮：先确认 `--dump-config` 里有 `voice-unified` 行，再看
> DSH 日志里的 `[dsh-voice-unified]` 前缀；大多数问题是端口未重启或插件加载
> 失败，见 [LIMITATIONS.md](LIMITATIONS.md#排查)。

## 4. 首次配置

- 打开「声音 → 语音设置」确认“自动语音回复”已开启。
- 打开「音色管理」新建第一个克隆音色：上传 2~4 段 3~15 秒清晰人声 → 训练 → 试听 → 设为默认。
- 打开「全局状态」确认：默认音色、样本总数、TTS/ffmpeg/DSP 引擎均为绿色。

## 5. 升级

```powershell
# 覆盖目录后重启 DSH 即可；state.json 与样本不会丢失
dsh plugin --profile desktop add "link:C:\新路径\dsh-voice-unified"
```

升级不会删除 `~/.dsh/dsh-voice-unified/`。如需备份：

```powershell
Copy-Item "$HOME\.dsh\dsh-voice-unified" "$HOME\Desktop\voice-backup" -Recurse
```

## 6. 卸载

```powershell
dsh plugin --profile desktop remove dsh-voice-unified
# 可选：删除数据
Remove-Item "$HOME\.dsh\dsh-voice-unified" -Recurse
```

## 7. 非 Windows

插件按平台把 TTS/ffmpeg/DSP 放在独立适配层。macOS/Linux 默认没有 SAPI，会返回
`TTS_ENGINE_UNAVAILABLE`；可通过环境变量替换：

```bash
DSH_VOICE_PYTHON=/usr/bin/python3
DSH_VOICE_FFMPEG=/usr/bin/ffmpeg
# 外部 TTS 引擎需实现与 scripts/sapi-tts.ps1 相同的输入输出契约
```

完整的引擎替换说明见 [ARCHITECTURE.md](ARCHITECTURE.md)。
