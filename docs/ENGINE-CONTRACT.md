# dsh-voice-unified 引擎契约（内部）

服务端通过 `node:child_process` 调用两套本地引擎；两者都可替换，不把具体算法泄漏给上层。

## 1. Windows SAPI TTS

`scripts/sapi-tts.ps1`

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/sapi-tts.ps1 `
  -TextFile <utf8.txt> -OutFile <out.wav> `
  -Voice "Microsoft Huihui Desktop" -Rate 0 -Volume 100 -PauseMs 180
```

- 成功 stdout 一行：`OK|<voiceName>|<bytes>|<outFile>`
- 失败非 0 退出并把原因写 stderr。
- 可用音色：`Microsoft Huihui Desktop`（zh-CN 女声）、`Microsoft Zira Desktop`（en-US 女声）。
  其余内置音色由 DSP 变声参数实现。
- `Rate`：-10..10；`Volume`：0..100；`PauseMs`：句末停顿毫秒。

## 2. Python DSP 引擎

解释器：DSH 自带 Python（含 numpy）。调用：

```bat
<python> engine\voice_engine.py <command> ... --json <result.json>
```

所有命令必须把机器可读结果写到 `--json` 指定文件，并同时打印到 stdout；失败时退出码非 0，stdout/stderr 含可读错误。

### 统一音频格式

内部中间文件统一为 **单声道 / 16-bit PCM WAV**（除非命令另有说明）。上层用 ffmpeg 把 mp3/m4a/flac 解码为 WAV，再调用本引擎。

### `analyze`

```bat
voice_engine.py analyze --input <wav> --json <out.json>
```

输出：

```json
{
  "ok": true,
  "duration": 3.42,
  "sampleRate": 24000,
  "channels": 1,
  "rms": 0.083,
  "peak": 0.91,
  "clipping": 0.0,
  "silenceRatio": 0.12,
  "f0": 212.4,
  "f0Confidence": 0.83,
  "centroid": 1840.2,
  "brightness": 0.48,
  "speechRate": 4.1,
  "quality": 86,
  "issues": []
}
```

`quality` 0..100；`issues` 是中文短句数组（如“音量偏低”“削波”）。

### `slice`

```bat
voice_engine.py slice --input <wav> --outdir <dir> --json <out.json> [--min 0.8] [--max 15]
```

按静音切分，输出 `slice-001.wav`...，JSON：

```json
{"ok":true,"slices":[{"file":"...","duration":4.2,"quality":88,"f0":205.1}]}
```

### `convert`

音色转换 / 情感后处理。输入输出都是 WAV。

```bat
voice_engine.py convert --input <wav> --output <wav> --json <out.json> `
  --pitch-semitones -3.2 --formant 0.94 --brightness 0.12 --strength 0.8 `
  --speed 1.0 --vibrato 0 --tremolo 0
```

- `pitch-semitones`：-12..12，移调但尽量保持时长。
- `formant`：0.8..1.2，频谱包络缩放（近似共振峰）。
- `brightness`：-1..1，频谱倾斜。
- `strength`：0..1，转换强度；0 原样输出。
- `speed`：0.75..1.3，变速不变调。
- `vibrato`/`tremolo`：0..1，颤音/颤幅（翻唱用）。

输出 `{ "ok": true, "duration": 3.1, "f0": 190.2, "centroid": 1700.0 }`

### `emotion`

对已合成语音施加情绪韵律后处理：

```bat
voice_engine.py emotion --input <wav> --output <wav> --json <out.json> `
  --emotion happy --intensity 0.7
```

支持 `calm/happy/tender/serious/comforting/excited/sad`。输出同 `convert`。

### `mix`

```bat
voice_engine.py mix --vocal <wav> --instrumental <wav> --output <wav> --json <out.json> `
  --vocal-gain 1.0 --inst-gain 0.9
```

输出 `{ "ok": true, "duration": 30.0, "peak": 0.95 }`，做限幅避免削波。

### `similarity`

```bat
voice_engine.py similarity --target <target-features.json> --preview <wav> --json <out.json>
```

`target-features.json` 至少含 `f0`、`centroid`、`brightness`、`quality`。输出：

```json
{"ok":true,"similarity":78.4,"f0Distance":0.08,"centroidDistance":0.15}
```

### `demo`

生成验收用示例素材（可复现）：

```bat
voice_engine.py demo --outdir <dir> --json <out.json>
```

生成：
- `demo-original.wav`：一段 18~24 秒的“原唱”（中间人声 + 左右声道伴奏）。
- `samples/profile-a/*.wav`、`samples/profile-b/*.wav`、`samples/profile-c/*.wav`：
  同一句文本经不同音高/共振峰处理后的 2~4 个样本，用于训练验收。
- `demo-song-meta.json`：歌曲名、时长、人声位置说明。

## 3. 上层调用约定

- 超时：analyze/slice 30s；convert/emotion 120s；翻唱 10min。
- 失败日志必须包含 stderr 末 800 字符。
- 引擎路径通过环境变量可覆盖：`DSH_VOICE_PYTHON`、`DSH_VOICE_FFMPEG`。
- 非 Windows 平台若无 SAPI，上层返回明确错误 `TTS_ENGINE_UNAVAILABLE`，可配置外部命令引擎。
