#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""End-to-end tests for engine/voice_engine.py.

Every engine call goes through the real CLI (python engine/voice_engine.py ...)
so the tests cover argument parsing, JSON output and WAV writing as well.

Run directly:
    python tests/engine/test_engine.py
or through the one-command Node wrapper:
    node tests/engine/run-tests.mjs
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / "engine" / "voice_engine.py"
WORK = ROOT / "tests" / "engine" / ".tmp"
PY = os.environ.get("DSH_VOICE_PYTHON") or sys.executable
SR = 24000

CHECKS = 0
FAILURES: list[str] = []
STDERRS: list[tuple[str, str]] = []


def check(cond: bool, label: str, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if cond:
        print(f"PASS  {label}")
    else:
        message = f"FAIL  {label}" + (f" :: {detail}" if detail else "")
        print(message)
        FAILURES.append(message)


def close(a, b, tol) -> bool:
    return abs(float(a) - float(b)) <= tol


def run(args: list[str], expect_ok: bool = True, timeout: int = 240):
    cmd = [PY, str(ENGINE)] + [str(a) for a in args]
    proc = subprocess.run(
        cmd,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    label = args[0]
    STDERRS.append((label, proc.stderr or ""))
    data = None
    out = (proc.stdout or "").strip()
    if out:
        try:
            data = json.loads(out)
        except json.JSONDecodeError as exc:
            raise AssertionError(f"{label}: stdout 不是 JSON ({exc}): {out[:300]}")
    if expect_ok:
        assert proc.returncode == 0, f"{label}: 退出码 {proc.returncode}, stderr={proc.stderr[-500:]}"
        assert isinstance(data, dict) and data.get("ok") is True, f"{label}: {data}"
    return proc, data


def write_wav(path: Path, samples, sr: int = SR, channels: int = 1) -> Path:
    arr = np.asarray(samples, dtype=np.float64)
    if arr.ndim == 1 and channels > 1:
        arr = np.repeat(arr[:, None], channels, axis=1)
    if arr.ndim == 2 and arr.shape[1] == 1:
        arr = arr[:, 0]
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(np.round(arr * 32767.0), -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())
    return path


def read_wav(path: Path):
    with wave.open(str(path), "rb") as wf:
        channels = wf.getnchannels()
        sr = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    data = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    return data.reshape(-1, channels), sr


def tone(freq: float, dur: float, amp: float = 0.5, sr: int = SR) -> np.ndarray:
    t = np.arange(int(round(dur * sr)), dtype=np.float64) / sr
    return amp * np.sin(2.0 * np.pi * freq * t)


def saw(freq: float, dur: float, amp: float = 0.45, sr: int = SR) -> np.ndarray:
    t = np.arange(int(round(dur * sr)), dtype=np.float64) / sr
    out = np.zeros_like(t)
    for h in range(1, 13):
        out += np.sin(2.0 * np.pi * freq * h * t) / h
    peak = float(np.max(np.abs(out)))
    return amp * out / max(peak, 1e-9)


def silence(dur: float, sr: int = SR) -> np.ndarray:
    return np.zeros(int(round(dur * sr)), dtype=np.float64)


def analyze_path(path: Path) -> dict:
    _, data = run(["analyze", "--input", str(path), "--json", str(WORK / "an.json")])
    return data


def main() -> int:
    if not ENGINE.is_file():
        print(f"找不到引擎: {ENGINE}")
        return 2
    if WORK.exists():
        shutil.rmtree(WORK, ignore_errors=True)
    WORK.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # fixtures
    # ------------------------------------------------------------------
    tone_path = write_wav(WORK / "tone-220.wav", tone(220.0, 3.0, 0.5))
    stereo_path = write_wav(WORK / "tone-stereo.wav", tone(330.0, 2.0, 0.4), channels=2)
    rich_path = write_wav(WORK / "saw-160.wav", saw(160.0, 2.5, 0.4))

    # 3 bursts separated by silence (for slice)
    bursts = np.concatenate(
        [
            tone(220.0, 1.0, 0.4),
            silence(0.7),
            tone(330.0, 1.0, 0.4),
            silence(0.7),
            tone(440.0, 1.2, 0.4),
        ]
    )
    bursts_path = write_wav(WORK / "bursts.wav", bursts)

    # ------------------------------------------------------------------
    # analyze
    # ------------------------------------------------------------------
    _, an = run(
        ["analyze", "--input", str(tone_path), "--json", str(WORK / "analyze.json")]
    )
    check(an.get("ok") is True, "analyze: ok")
    check(close(an["duration"], 3.0, 0.02), "analyze: duration≈3.0", str(an["duration"]))
    check(an["sampleRate"] == SR, "analyze: sampleRate", str(an["sampleRate"]))
    check(an["channels"] == 1, "analyze: channels=1", str(an["channels"]))
    check(close(an["f0"], 220.0, 8.0), "analyze: f0≈220Hz", str(an["f0"]))
    check(an["f0Confidence"] > 0.5, "analyze: f0Confidence>0.5", str(an["f0Confidence"]))
    check(100.0 < an["centroid"] < 500.0, "analyze: centroid 在合理范围", str(an["centroid"]))
    check(0.0 <= an["brightness"] <= 1.0, "analyze: brightness∈[0,1]", str(an["brightness"]))
    check(an["quality"] >= 85, "analyze: quality≥85", str(an["quality"]))
    check(isinstance(an["issues"], list), "analyze: issues 是数组")
    check(close(an["rms"], 0.5 / math.sqrt(2), 0.03), "analyze: rms≈0.354", str(an["rms"]))
    check(an["clipping"] == 0.0, "analyze: 无削波", str(an["clipping"]))
    check(close(an["silenceRatio"], 0.0, 0.02), "analyze: silenceRatio≈0", str(an["silenceRatio"]))

    saved = json.loads((WORK / "analyze.json").read_text(encoding="utf-8"))
    check(saved == an, "analyze: --json 文件内容与 stdout 一致")

    _, an_st = run(["analyze", "--input", str(stereo_path)])
    check(an_st["channels"] == 2, "analyze: 立体声 channels=2", str(an_st["channels"]))
    check(close(an_st["f0"], 330.0, 10.0), "analyze: 立体声 f0≈330", str(an_st["f0"]))

    # clipping / short-file issue reporting
    clipped = np.clip(tone(200.0, 1.0, 1.8), -1.0, 1.0)
    clipped_path = write_wav(WORK / "clipped.wav", clipped)
    _, an_clip = run(["analyze", "--input", str(clipped_path)])
    check(an_clip["clipping"] > 0.001, "analyze: 检出削波", str(an_clip["clipping"]))
    check(any("削波" in s for s in an_clip["issues"]), "analyze: issues 含“削波”", str(an_clip["issues"]))
    short_path = write_wav(WORK / "short.wav", tone(200.0, 0.3, 0.4))
    _, an_short = run(["analyze", "--input", str(short_path)])
    check(an_short["quality"] < 80, "analyze: 过短音频扣分", str(an_short["quality"]))
    check(any("时长" in s for s in an_short["issues"]), "analyze: 过短 issues", str(an_short["issues"]))

    # ------------------------------------------------------------------
    # slice
    # ------------------------------------------------------------------
    slice_dir = WORK / "slices"
    _, sl = run(
        [
            "slice",
            "--input",
            str(bursts_path),
            "--outdir",
            str(slice_dir),
            "--json",
            str(WORK / "slice.json"),
            "--min",
            "0.8",
            "--max",
            "15",
        ]
    )
    slices = sl.get("slices", [])
    check(len(slices) >= 3, "slice: 至少切出 3 段", f"count={len(slices)}")
    check(len(slices) <= 4, "slice: 没有把静音间隙单独切出", f"count={len(slices)}")
    slice_ok = True
    for item in slices:
        path = Path(item["file"])
        if not path.is_file():
            slice_ok = False
            break
        arr, sr = read_wav(path)
        dur = arr.shape[0] / sr
        if not (0.79 <= dur <= 15.1):
            slice_ok = False
        if float(np.max(np.abs(arr))) < 0.02:
            slice_ok = False
        if not (60.0 <= item["f0"] <= 600.0):
            slice_ok = False
    check(slice_ok, "slice: 文件存在/时长合规/非纯静音/f0 合理")
    check(Path(slices[0]["file"]).name == "slice-001.wav", "slice: 命名 slice-001.wav")

    # tight max should split a long file
    long_path = write_wav(WORK / "long.wav", tone(180.0, 4.0, 0.3))
    _, sl2 = run(
        [
            "slice",
            "--input",
            str(long_path),
            "--outdir",
            str(WORK / "slices-long"),
            "--max",
            "1.5",
            "--min",
            "0.8",
        ]
    )
    check(len(sl2["slices"]) >= 2, "slice: --max 生效产生多段", f"count={len(sl2['slices'])}")
    check(
        all(item["duration"] <= 1.65 for item in sl2["slices"]),
        "slice: 各段不超过 max(+帧尾)",
        str([item["duration"] for item in sl2["slices"]]),
    )

    # ------------------------------------------------------------------
    # convert: pitch
    # ------------------------------------------------------------------
    out_pitch = WORK / "pitch-up5.wav"
    _, cv = run(
        [
            "convert",
            "--input",
            str(tone_path),
            "--output",
            str(out_pitch),
            "--json",
            str(WORK / "convert-pitch.json"),
            "--pitch-semitones",
            "5",
            "--strength",
            "1.0",
        ]
    )
    check(out_pitch.is_file(), "convert: 输出文件存在")
    expect_ratio = 2.0 ** (5.0 / 12.0)
    check(
        close(cv["f0"] / 220.0, expect_ratio, 0.06),
        "convert: +5 半音 f0 比率正确",
        f"ratio={cv['f0'] / 220.0:.3f} expect={expect_ratio:.3f}",
    )
    check(close(cv["duration"], 3.0, 0.12), "convert: 移调保持时长", str(cv["duration"]))
    check(cv["peak"] <= 0.96, "convert: 输出不爆音", str(cv["peak"]))
    arr_p, _ = read_wav(out_pitch)
    check(float(np.max(np.abs(arr_p))) <= 0.96, "convert: 波形峰值≤0.96")
    check(cv["quality"] >= 50, "convert: 输出 quality 合理", str(cv["quality"]))

    # strength 0 = bypass
    out_zero = WORK / "pitch-zero.wav"
    run(
        [
            "convert",
            "--input",
            str(tone_path),
            "--output",
            str(out_zero),
            "--pitch-semitones",
            "8",
            "--formant",
            "1.2",
            "--brightness",
            "0.8",
            "--strength",
            "0",
        ]
    )
    a_in, _ = read_wav(tone_path)
    a_zero, _ = read_wav(out_zero)
    check(a_in.shape == a_zero.shape, "convert: strength=0 长度不变")
    check(
        float(np.max(np.abs(a_in - a_zero))) <= 1.5 / 32768.0,
        "convert: strength=0 基本原样输出",
        str(float(np.max(np.abs(a_in - a_zero)))),
    )

    # brightness must move the spectral centroid
    bright_path = WORK / "bright.wav"
    dark_path = WORK / "dark.wav"
    _, cv_b = run(
        [
            "convert", "--input", str(rich_path), "--output", str(bright_path),
            "--brightness", "0.9", "--strength", "1.0",
        ]
    )
    _, cv_d = run(
        [
            "convert", "--input", str(rich_path), "--output", str(dark_path),
            "--brightness", "-0.9", "--strength", "1.0",
        ]
    )
    check(
        cv_b["centroid"] > cv_d["centroid"] * 1.08,
        "convert: brightness 明显改变谱质心",
        f"bright={cv_b['centroid']} dark={cv_d['centroid']}",
    )
    check(cv_b["peak"] <= 0.96 and cv_d["peak"] <= 0.96, "convert: 亮度处理不爆音")

    # formant shift keeps pitch but changes timbre
    formant_path = WORK / "formant-up.wav"
    _, an_rich = run(["analyze", "--input", str(rich_path)])
    _, cv_f = run(
        [
            "convert", "--input", str(rich_path), "--output", str(formant_path),
            "--formant", "1.2", "--strength", "1.0",
        ]
    )
    check(close(cv_f["f0"], 160.0, 8.0), "convert: formant 不改变音高", str(cv_f["f0"]))
    check(
        abs(cv_f["centroid"] - an_rich["centroid"]) > 0.03 * an_rich["centroid"],
        "convert: formant 处理有频谱差异",
        f"formant={cv_f['centroid']} base={an_rich['centroid']}",
    )

    # ------------------------------------------------------------------
    # convert: speed
    # ------------------------------------------------------------------
    speed_path = WORK / "speed-12.wav"
    _, cv_s = run(
        [
            "convert", "--input", str(tone_path), "--output", str(speed_path),
            "--speed", "1.2", "--strength", "1.0",
        ]
    )
    check(
        close(cv_s["duration"], 3.0 / 1.2, 0.08),
        "convert: speed=1.2 时长≈2.5s",
        str(cv_s["duration"]),
    )
    check(close(cv_s["f0"], 220.0, 10.0), "convert: 变速不变调", str(cv_s["f0"]))

    # vibrato / tremolo audible difference
    vib_path = WORK / "vibrato.wav"
    _, cv_v = run(
        [
            "convert", "--input", str(tone_path), "--output", str(vib_path),
            "--vibrato", "0.8", "--tremolo", "0.6", "--strength", "1.0",
        ]
    )
    arr_v, _ = read_wav(vib_path)
    check(arr_v.shape[0] == a_in.shape[0], "convert: vibrato/tremolo 长度不变")
    check(
        float(np.max(np.abs(a_in - arr_v))) > 0.02,
        "convert: vibrato/tremolo 产生可听差异",
        str(float(np.max(np.abs(a_in - arr_v)))),
    )

    # ------------------------------------------------------------------
    # emotion
    # ------------------------------------------------------------------
    sad_path = WORK / "emotion-sad.wav"
    happy_path = WORK / "emotion-happy.wav"
    _, em_s = run(
        [
            "emotion", "--input", str(tone_path), "--output", str(sad_path),
            "--json", str(WORK / "emotion-sad.json"),
            "--emotion", "sad", "--intensity", "0.7",
        ]
    )
    _, em_h = run(
        [
            "emotion", "--input", str(tone_path), "--output", str(happy_path),
            "--emotion", "happy", "--intensity", "0.7",
        ]
    )
    check(em_s["f0"] < 220.0 * 0.96, "emotion: sad 降低音高", str(em_s["f0"]))
    check(em_h["f0"] > 220.0 * 1.02, "emotion: happy 提高音高", str(em_h["f0"]))
    check(em_s["duration"] > 3.0 * 1.02, "emotion: sad 语速更慢", str(em_s["duration"]))
    check(em_h["duration"] < 3.0 * 0.99, "emotion: happy 语速更快", str(em_h["duration"]))
    check(em_s["peak"] <= 0.96 and em_h["peak"] <= 0.96, "emotion: 不爆音")
    for emo in ["calm", "tender", "serious", "comforting", "excited"]:
        p = WORK / f"emotion-{emo}.wav"
        _, r = run(
            ["emotion", "--input", str(tone_path), "--output", str(p), "--emotion", emo]
        )
        check(r["duration"] > 1.0 and p.is_file(), f"emotion: {emo} 可生成")
    proc_bad, bad = run(
        ["emotion", "--input", str(tone_path), "--output", str(WORK / "x.wav"), "--emotion", "angry"],
        expect_ok=False,
    )
    check(proc_bad.returncode != 0 and bad.get("ok") is False, "emotion: 非法情绪报错退出")

    # ------------------------------------------------------------------
    # mix
    # ------------------------------------------------------------------
    vocal_path = write_wav(WORK / "vocal.wav", tone(220.0, 3.0, 0.4))
    inst_mono = tone(110.0, 2.0, 0.4)
    inst_stereo = np.stack([inst_mono, tone(165.0, 2.0, 0.4)], axis=1)
    inst_path = write_wav(WORK / "inst.wav", inst_stereo, channels=2)
    mix_path = WORK / "mix.wav"
    _, mx = run(
        [
            "mix", "--vocal", str(vocal_path), "--instrumental", str(inst_path),
            "--output", str(mix_path), "--json", str(WORK / "mix.json"),
            "--vocal-gain", "1.0", "--inst-gain", "0.9",
        ]
    )
    check(mx["channels"] == 2, "mix: 输出立体声")
    check(close(mx["duration"], 3.0, 0.03), "mix: 长度对齐为较长轨", str(mx["duration"]))
    check(0.945 <= mx["peak"] <= 0.9501, "mix: 峰值归一化到 0.95", str(mx["peak"]))
    arr_m, sr_m = read_wav(mix_path)
    check(arr_m.shape[1] == 2 and arr_m.shape[0] == int(round(3.0 * sr_m)), "mix: WAV 结构正确")
    check(float(np.max(np.abs(arr_m))) <= 0.96, "mix: 不削波")

    # ------------------------------------------------------------------
    # similarity
    # ------------------------------------------------------------------
    target_path = WORK / "target.json"
    target_path.write_text(
        json.dumps(
            {
                "f0": 220.0,
                "centroid": an["centroid"],
                "brightness": an["brightness"],
                "quality": an["quality"],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    _, sim_same = run(
        ["similarity", "--target", str(target_path), "--preview", str(tone_path),
         "--json", str(WORK / "similarity.json")]
    )
    check(0.0 <= sim_same["similarity"] <= 100.0, "similarity: 分数∈[0,100]")
    check(sim_same["similarity"] >= 90.0, "similarity: 同源音频高分", str(sim_same["similarity"]))
    check(sim_same["f0Distance"] < 0.05, "similarity: 同源 f0Distance 很小", str(sim_same["f0Distance"]))
    _, sim_pitch = run(
        ["similarity", "--target", str(target_path), "--preview", str(out_pitch)]
    )
    check(
        sim_pitch["similarity"] < sim_same["similarity"] - 10.0,
        "similarity: 移调后分数明显下降",
        f"{sim_pitch['similarity']} vs {sim_same['similarity']}",
    )
    check(sim_pitch["f0Distance"] > 0.2, "similarity: 移调后 f0Distance 变大", str(sim_pitch["f0Distance"]))
    # target JSON written by other Windows tooling may carry a UTF-8 BOM
    bom_target = WORK / "target-bom.json"
    bom_target.write_text(
        "\ufeff" + json.dumps({"f0": 220.0, "centroid": an["centroid"], "brightness": an["brightness"]}),
        encoding="utf-8",
    )
    _, sim_bom = run(
        ["similarity", "--target", str(bom_target), "--preview", str(tone_path)]
    )
    check(sim_bom["similarity"] >= 90.0, "similarity: 兼容带 BOM 的目标 JSON", str(sim_bom["similarity"]))

    # ------------------------------------------------------------------
    # demo
    # ------------------------------------------------------------------
    demo_dir = WORK / "demo"
    _, dm = run(
        ["demo", "--outdir", str(demo_dir), "--json", str(WORK / "demo.json")],
        timeout=300,
    )
    original = Path(dm["original"]["file"])
    check(original.is_file(), "demo: demo-original.wav 存在")
    arr_o, sr_o = read_wav(original)
    check(arr_o.shape[1] == 2, "demo: 原唱是立体声")
    check(18.0 <= arr_o.shape[0] / sr_o <= 24.0, "demo: 原唱时长 18~24s", str(arr_o.shape[0] / sr_o))
    left, right = arr_o[:, 0], arr_o[:, 1]
    check(float(np.max(np.abs(left - right))) > 0.01, "demo: 左右声场不同")
    check(float(np.max(np.abs(0.5 * (left + right)))) > 0.2, "demo: 原唱有足够音量")
    check(60.0 <= dm["original"]["f0"] <= 600.0, "demo: 原唱 f0 合理", str(dm["original"]["f0"]))
    check(dm["original"]["quality"] >= 60, "demo: 原唱 quality≥60", str(dm["original"]["quality"]))
    an_demo = analyze_path(original)
    check(18.0 <= an_demo["duration"] <= 24.0, "demo: analyze 得到 18~24s", str(an_demo["duration"]))
    check(an_demo["channels"] == 2, "demo: analyze 识别双声道")
    check(60.0 <= an_demo["f0"] <= 600.0, "demo: analyze 得到合理 F0", str(an_demo["f0"]))
    check(an_demo["quality"] >= 60, "demo: analyze quality≥60", str(an_demo["quality"]))
    meta_path = Path(dm["metaFile"])
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    check(meta_path.is_file() and meta.get("songName"), "demo: demo-song-meta.json 有歌名")
    check(close(meta.get("duration", 0), 20.0, 0.5), "demo: meta 时长正确")
    check("center" in json.dumps(meta, ensure_ascii=False), "demo: meta 说明人声位置")

    profiles = dm.get("profiles", [])
    check(len(profiles) == 3, "demo: 3 组音色", str(len(profiles)))
    sample_ok = True
    for prof in profiles:
        files = prof.get("files", [])
        if not (2 <= len(files) <= 4):
            sample_ok = False
        for item in files:
            p = Path(item["file"])
            if not p.is_file():
                sample_ok = False
                continue
            arr_s, sr_s = read_wav(p)
            dur = arr_s.shape[0] / sr_s
            if not (2.0 <= dur <= 4.0):
                sample_ok = False
            if float(np.max(np.abs(arr_s))) < 0.05:
                sample_ok = False
            if not (60.0 <= item["f0"] <= 600.0):
                sample_ok = False
    check(sample_ok, "demo: 每组 3 个样本/时长 2~4s/非静音/f0 合理")
    fa = profiles[0]["files"][0]["f0"]
    fb = profiles[1]["files"][0]["f0"]
    fc = profiles[2]["files"][0]["f0"]
    check(fa < fb < fc, "demo: 音色组间音高按 profile 递增", f"{fa}/{fb}/{fc}")
    check(
        float(np.max(np.abs(fa - fc))) > 5.0,
        "demo: 样本间存在可测差异",
        f"{fa} vs {fc}",
    )
    samp1 = Path(profiles[0]["files"][0]["file"])
    an_samp = analyze_path(samp1)
    check(an_samp["quality"] >= 60, "demo: 样本 analyze quality≥60", str(an_samp["quality"]))
    check(close(an_samp["duration"], profiles[0]["files"][0]["duration"], 0.05), "demo: 样本时长与报告一致")

    # ------------------------------------------------------------------
    # io / resampling / longer chunks
    # ------------------------------------------------------------------
    # 44.1 kHz input: analysis must respect the file sample rate
    sr44 = 44100
    t44 = np.arange(int(2.0 * sr44), dtype=np.float64) / sr44
    tone44_path = write_wav(
        WORK / "tone-330-44k.wav", 0.45 * np.sin(2 * np.pi * 330.0 * t44), sr=sr44
    )
    _, an44 = run(["analyze", "--input", str(tone44_path)])
    check(an44["sampleRate"] == 44100, "io: 44.1k 采样率保留", str(an44["sampleRate"]))
    check(close(an44["f0"], 330.0, 8.0), "io: 44.1k f0≈330", str(an44["f0"]))
    out44 = WORK / "pitch-44k.wav"
    _, cv44 = run(
        ["convert", "--input", str(tone44_path), "--output", str(out44),
         "--pitch-semitones", "3", "--strength", "1.0"]
    )
    check(out44.is_file(), "io: 44.1k 可转换")
    check(
        close(cv44["f0"] / 330.0, 2 ** (3 / 12), 0.06),
        "io: 44.1k 移调比率正确",
        f"ratio={cv44['f0'] / 330.0:.3f}",
    )
    check(close(cv44["duration"], 2.0, 0.1), "io: 44.1k 保持时长", str(cv44["duration"]))

    # 24-bit PCM input
    b24 = (np.clip(np.round(tone(200.0, 1.5, 0.4) * 8388607.0), -8388608, 8388607)
           .astype("<i4").view(np.uint8).reshape(-1, 4)[:, :3])
    p24 = WORK / "tone-24bit.wav"
    with wave.open(str(p24), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(3)
        wf.setframerate(SR)
        wf.writeframes(b24.tobytes())
    _, an24 = run(["analyze", "--input", str(p24)])
    check(close(an24["f0"], 200.0, 8.0), "io: 24-bit WAV 可读取", str(an24["f0"]))
    check(close(an24["duration"], 1.5, 0.02), "io: 24-bit 时长", str(an24["duration"]))

    # longer file exercises the chunked phase vocoder blocks
    long_tone_path = write_wav(WORK / "tone-8s.wav", tone(200.0, 8.0, 0.35))
    long_out = WORK / "long-convert.wav"
    _, cv_long = run(
        ["convert", "--input", str(long_tone_path), "--output", str(long_out),
         "--pitch-semitones", "-2", "--speed", "1.05", "--formant", "1.1",
         "--brightness", "0.5"]
    )
    check(close(cv_long["duration"], 8.0 / 1.05, 0.25), "io: 长音频变速时长", str(cv_long["duration"]))
    check(
        close(cv_long["f0"] / 200.0, 2 ** (-2 / 12) / 1.0, 0.06),
        "io: 长音频移调正确",
        f"ratio={cv_long['f0'] / 200.0:.3f}",
    )
    check(cv_long["peak"] <= 0.96, "io: 长音频不爆音", str(cv_long["peak"]))

    # mix with different sample rates / mono instrumental
    t16 = np.arange(int(2.5 * 16000), dtype=np.float64) / 16000.0
    inst16 = write_wav(WORK / "inst-16k.wav", 0.4 * np.sin(2 * np.pi * 110.0 * t16), sr=16000)
    mix16_path = WORK / "mix-16k.wav"
    _, mx16 = run(
        ["mix", "--vocal", str(vocal_path), "--instrumental", str(inst16),
         "--output", str(mix16_path)]
    )
    check(mx16["sampleRate"] == SR, "mix: 以人声采样率为准", str(mx16["sampleRate"]))
    check(close(mx16["duration"], 3.0, 0.03), "mix: 异采样率长度对齐", str(mx16["duration"]))
    check(0.945 <= mx16["peak"] <= 0.9501, "mix: 异采样率峰值 0.95", str(mx16["peak"]))
    _, an_mix16 = run(["analyze", "--input", str(mix16_path)])
    check(an_mix16["channels"] == 2, "mix: 单声道伴奏升级为立体声")

    # ------------------------------------------------------------------
    # error handling
    # ------------------------------------------------------------------
    proc_missing, miss = run(
        ["analyze", "--input", str(WORK / "no-such-file.wav")], expect_ok=False
    )
    check(proc_missing.returncode != 0, "error: 缺失输入非 0 退出")
    check(miss.get("ok") is False and miss.get("error"), "error: stdout 有 readable error")
    proc_badjson, _ = run(
        ["analyze", "--input", str(tone_path), "--json", str(WORK / "err.json")],
        expect_ok=False,
    )
    check(proc_badjson.returncode == 0, "error: 正常调用退出码 0")

    # ------------------------------------------------------------------
    # stderr cleanliness
    # ------------------------------------------------------------------
    noisy = []
    for label, err in STDERRS:
        if re.search(r"RuntimeWarning|invalid value|divide by zero|overflow encountered|Mean of empty", err):
            noisy.append(f"{label}: {err.strip()[:200]}")
    check(not noisy, "stderr: 无 numpy 警告", "; ".join(noisy)[:400])

    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} / {CHECKS} checks")
        for item in FAILURES:
            print(" -", item)
        return 1
    print(f"ALL TESTS PASSED: {CHECKS} checks")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AssertionError as exc:
        print(f"ABORTED: {exc}")
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        print(f"ABORTED: {exc}")
        sys.exit(1)
