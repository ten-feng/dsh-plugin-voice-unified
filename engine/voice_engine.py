#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-voice-unified Python DSP engine.

Pure numpy + Python standard library (no scipy / soundfile / librosa).

Sub-commands: analyze, slice, convert, emotion, mix, similarity, demo.
Every command writes the machine readable result to ``--json`` and also
prints it to stdout.  Failures exit non-zero and print a readable error.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import warnings
import wave

import numpy as np

warnings.filterwarnings("ignore")
np.seterr(all="ignore")

ENGINE_VERSION = "1.0.0"
DEFAULT_SR = 24000
TWO_PI = 2.0 * np.pi


class EngineError(RuntimeError):
    """Readable engine failure."""


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

def _setup_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - stdio may be a pipe wrapper
            pass


def _clip(v, lo, hi):
    return float(min(hi, max(lo, v)))


def _rms(x: np.ndarray) -> float:
    if x.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(x))))


def _peak(x: np.ndarray) -> float:
    if x.size == 0:
        return 0.0
    return float(np.max(np.abs(x)))


def _sanitize(obj):
    """Make the value JSON safe (no NaN/Inf/numpy scalars)."""
    if isinstance(obj, dict):
        return {str(k): _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating, float)):
        v = float(obj)
        if not math.isfinite(v):
            return 0.0
        return v
    if isinstance(obj, np.ndarray):
        return _sanitize(obj.tolist())
    return obj


def _write_json_file(path: str, data: dict) -> None:
    if not path:
        return
    directory = os.path.dirname(os.path.abspath(path))
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2, allow_nan=False)


# ---------------------------------------------------------------------------
# WAV I/O
# ---------------------------------------------------------------------------

def read_wav(path: str):
    """Read PCM WAV -> (float64 array shaped (n, channels), sample rate)."""
    if not path or not os.path.isfile(path):
        raise EngineError(f"输入文件不存在: {path}")
    try:
        with wave.open(path, "rb") as wf:
            channels = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            sr = wf.getframerate()
            nframes = wf.getnframes()
            comptype = wf.getcomptype()
            raw = wf.readframes(nframes)
    except wave.Error as exc:
        raise EngineError(f"无法读取 WAV（仅支持 PCM/float 格式）: {exc}")
    except Exception as exc:  # noqa: BLE001
        raise EngineError(f"读取 WAV 失败: {exc}")

    if comptype != "NONE":
        raise EngineError(f"不支持的 WAV 压缩格式: {comptype}")
    if channels <= 0 or sr <= 0:
        raise EngineError("WAV 头信息无效（声道或采样率异常）")

    if sampwidth == 1:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    elif sampwidth == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif sampwidth == 3:
        b = np.frombuffer(raw, dtype=np.uint8)
        b = b[: (b.size // 3) * 3].reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        v = np.where(v >= (1 << 23), v - (1 << 24), v)
        data = v.astype(np.float64) / 8388608.0
    elif sampwidth == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float64) / 2147483648.0
    else:
        raise EngineError(f"不支持的采样位宽: {sampwidth * 8} bit")

    usable = (data.size // channels) * channels
    if usable == 0:
        raise EngineError("WAV 不含音频采样")
    data = data[:usable].reshape(-1, channels)
    data = np.nan_to_num(data, nan=0.0, posinf=0.0, neginf=0.0)
    return data, int(sr)


def write_wav(path: str, data, sr: int) -> str:
    """Write 16-bit PCM WAV. ``data`` is (n,) or (n, channels)."""
    arr = np.asarray(data, dtype=np.float64)
    if arr.ndim == 1:
        arr = arr.reshape(-1, 1)
    if arr.ndim != 2 or arr.shape[1] not in (1, 2):
        raise EngineError("写 WAV 仅支持单声道或双声道")
    if arr.shape[0] == 0:
        raise EngineError("输出音频为空")
    if not sr or sr <= 0:
        raise EngineError("输出采样率无效")
    arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
    pcm = np.clip(np.round(arr * 32767.0), -32768, 32767).astype("<i2")
    path = os.path.abspath(path)
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(arr.shape[1])
        wf.setsampwidth(2)
        wf.setframerate(int(sr))
        wf.writeframes(pcm.tobytes())
    return path


# ---------------------------------------------------------------------------
# resampling
# ---------------------------------------------------------------------------

def resample_to_length(x: np.ndarray, out_len: int) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64).ravel()
    out_len = int(out_len)
    if out_len <= 0:
        return np.zeros(0, dtype=np.float64)
    if x.size == 0:
        return np.zeros(out_len, dtype=np.float64)
    if x.size == 1:
        return np.full(out_len, x[0], dtype=np.float64)
    if out_len == x.size:
        return x.copy()
    src = np.arange(x.size, dtype=np.float64)
    dst = np.linspace(0.0, x.size - 1, out_len)
    return np.interp(dst, src, x)


def resample(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    if sr_in == sr_out or x.size == 0:
        return np.asarray(x, dtype=np.float64).copy()
    out_len = max(1, int(round(x.size * float(sr_out) / float(sr_in))))
    return resample_to_length(x, out_len)


# ---------------------------------------------------------------------------
# frame analysis
# ---------------------------------------------------------------------------

def _smooth_rows(a: np.ndarray, window: int) -> np.ndarray:
    """Box smooth each row; ``window`` is forced odd."""
    w = int(max(1, window)) | 1
    if w <= 1 or a.shape[1] == 0:
        return a
    pad = w // 2
    ap = np.pad(a, ((0, 0), (pad, pad)), mode="edge")
    cs = np.concatenate(
        [np.zeros((a.shape[0], 1)), np.cumsum(ap, axis=1)], axis=1
    )
    return (cs[:, w:] - cs[:, :-w]) / float(w)


def _frame_arrays(x: np.ndarray, sr: int):
    """Return (rms, f0, confidence, centroid) frame tracks."""
    frame = int(max(512, round(sr * 0.064)))
    frame = frame - (frame % 2)
    hop = int(max(128, round(sr * 0.010)))
    if x.size < frame:
        x = np.pad(x, (0, frame - x.size))
    nframes = 1 + (x.size - frame) // hop
    if nframes < 1:
        nframes = 1
        x = np.pad(x, (0, max(0, frame - x.size)))
    win = np.hanning(frame).astype(np.float64)
    nfft = 1 << int(math.ceil(math.log2(max(4, 2 * frame))))
    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)
    lag_min = int(max(2, math.floor(sr / 500.0)))
    lag_max = int(min(frame - 2, math.ceil(sr / 60.0)))

    rms = np.zeros(nframes, dtype=np.float64)
    f0 = np.zeros(nframes, dtype=np.float64)
    conf = np.zeros(nframes, dtype=np.float64)
    centroid = np.zeros(nframes, dtype=np.float64)
    batch = 200
    base = np.arange(frame, dtype=np.int64)
    for start in range(0, nframes, batch):
        stop = min(nframes, start + batch)
        idx = np.arange(start, stop, dtype=np.int64) * hop
        seg = x[idx[:, None] + base]
        seg = seg - seg.mean(axis=1, keepdims=True)
        rms[start:stop] = np.sqrt(np.mean(seg * seg, axis=1))
        wseg = seg * win
        spec = np.fft.rfft(wseg, n=nfft, axis=1)
        mag = np.abs(spec)
        ac = np.fft.irfft(mag * mag, n=nfft, axis=1)[:, : frame + 1]
        ac0 = ac[:, 0]
        safe = np.maximum(ac0, 1e-12)
        # autocorrelation normalised by frame energy
        acn = ac / safe[:, None]
        if lag_max > lag_min + 2:
            window_ac = acn[:, lag_min : lag_max + 1]
            rel = np.argmax(window_ac, axis=1)
            peak = window_ac[np.arange(window_ac.shape[0]), rel]
            lag = rel + lag_min
            # parabolic interpolation around the peak
            prev = np.take_along_axis(acn, (lag - 1)[:, None], axis=1)[:, 0]
            nxt = np.take_along_axis(acn, (lag + 1)[:, None], axis=1)[:, 0]
            denom = (prev - 2.0 * peak + nxt)
            delta = np.where(np.abs(denom) > 1e-9, 0.5 * (prev - nxt) / denom, 0.0)
            delta = np.clip(delta, -0.5, 0.5)
            lag_f = lag + delta
            f = sr / np.maximum(lag_f, 1e-6)
            valid = (peak > 0.28) & (f >= 55.0) & (f <= 550.0)
            f0[start:stop] = np.where(valid, f, 0.0)
            conf[start:stop] = np.where(valid, np.clip(peak, 0.0, 1.0), 0.0)
        # spectral centroid (skip DC)
        mag_sum = mag.sum(axis=1)
        weighted = (mag[:, 1:] * freqs[1:][None, :]).sum(axis=1)
        centroid[start:stop] = np.where(
            mag_sum > 1e-12, weighted / np.maximum(mag_sum, 1e-12), 0.0
        )
    return rms, f0, conf, centroid


def _median_smooth_f0(f0: np.ndarray, conf: np.ndarray) -> np.ndarray:
    out = f0.copy()
    voiced = (f0 > 0) & (conf > 0.28)
    if not np.any(voiced):
        return out
    vals = f0[voiced]
    smoothed = np.array(vals, copy=True)
    if vals.size >= 5:
        for i in range(vals.size):
            lo = max(0, i - 2)
            hi = min(vals.size, i + 3)
            smoothed[i] = float(np.median(vals[lo:hi]))
    out[voiced] = smoothed
    return out


def _analyze_core(x: np.ndarray, sr: int) -> dict:
    x = np.asarray(x, dtype=np.float64).ravel()
    if x.size == 0:
        raise EngineError("音频为空")
    rms_track, f0_track, conf_track, centroid_track = _frame_arrays(x, sr)
    max_rms = float(np.max(rms_track)) if rms_track.size else 0.0
    if max_rms <= 1e-5:
        active = np.zeros_like(rms_track, dtype=bool)
    else:
        thresh = max(0.06 * max_rms, 0.0025)
        active = rms_track > thresh
    if not np.any(active):
        active = rms_track > max(1e-6, 0.02 * max_rms)

    silence_ratio = float(1.0 - np.mean(active)) if active.size else 1.0
    silence_ratio = _clip(silence_ratio, 0.0, 1.0)

    voiced = active & (f0_track > 0)
    if np.any(voiced):
        f0_smooth = _median_smooth_f0(f0_track, conf_track)
        f0_val = float(np.median(f0_smooth[voiced]))
        f0_conf = float(np.mean(conf_track[voiced]))
    else:
        f0_val = 0.0
        f0_conf = 0.0

    if np.any(active):
        centroid = float(np.median(centroid_track[active]))
    else:
        centroid = 0.0
    if not math.isfinite(centroid) or centroid < 0:
        centroid = 0.0
    brightness = _clip(centroid / 4000.0, 0.0, 1.0)

    # syllable / energy burst rate per second
    speech_rate = 0.0
    if active.size and np.any(active):
        edges = np.diff(np.concatenate([[0], active.astype(np.int8), [0]]))
        starts = np.where(edges == 1)[0]
        duration = x.size / float(sr)
        if duration > 0:
            speech_rate = float(starts.size) / duration
    return {
        "rms": _rms(x),
        "peak": _peak(x),
        "clipping": float(np.mean(np.abs(x) >= 0.999)) if x.size else 0.0,
        "silenceRatio": silence_ratio,
        "f0": f0_val,
        "f0Confidence": f0_conf,
        "centroid": centroid,
        "brightness": brightness,
        "speechRate": speech_rate,
    }


def _quality_from(core: dict, duration: float):
    issues = []
    score = 100.0
    if duration < 0.6:
        score -= 35.0
        issues.append("时长过短（不足0.6秒）")
    elif duration < 1.0:
        score -= 10.0
        issues.append("时长偏短")
    peak = core["peak"]
    if peak < 1e-4:
        score = 0.0
        issues.append("几乎无声")
    else:
        if core["rms"] < 0.015:
            score -= 25.0
            issues.append("音量偏低")
        elif core["rms"] < 0.04:
            score -= 10.0
            issues.append("音量偏小")
        if core["clipping"] > 0.001:
            score -= 25.0
            issues.append("削波")
        if core["silenceRatio"] > 0.75:
            score -= 20.0
            issues.append("静音过多")
        elif core["silenceRatio"] > 0.55:
            score -= 10.0
            issues.append("静音偏多")
        if core["f0"] <= 0:
            score -= 15.0
            issues.append("未检测到清晰人声")
        elif core["f0Confidence"] < 0.45:
            score -= 8.0
            issues.append("音高不稳定")
    return int(round(_clip(score, 0.0, 100.0))), issues


def analyze_array(x: np.ndarray, sr: int, channels: int = 1) -> dict:
    x = np.asarray(x, dtype=np.float64).ravel()
    if x.size == 0:
        raise EngineError("音频为空，无法分析")
    duration = x.size / float(sr)
    core = _analyze_core(x, sr)
    quality, issues = _quality_from(core, duration)
    return {
        "ok": True,
        "duration": round(duration, 3),
        "sampleRate": int(sr),
        "channels": int(channels),
        "rms": round(core["rms"], 5),
        "peak": round(core["peak"], 5),
        "clipping": round(core["clipping"], 6),
        "silenceRatio": round(core["silenceRatio"], 4),
        "f0": round(core["f0"], 2),
        "f0Confidence": round(core["f0Confidence"], 4),
        "centroid": round(core["centroid"], 1),
        "brightness": round(core["brightness"], 4),
        "speechRate": round(core["speechRate"], 2),
        "quality": quality,
        "issues": issues,
    }


# ---------------------------------------------------------------------------
# DSP: STFT / phase vocoder / spectral shaping
# ---------------------------------------------------------------------------

def _pv_stretch(x: np.ndarray, sr: int, rate: float, n_fft: int = 2048) -> np.ndarray:
    """Time stretch with an STFT phase vocoder (pitch preserved).

    Frames are processed in bounded blocks so long inputs (several minutes)
    do not allocate gigabytes of complex spectra at once.
    """
    x = np.asarray(x, dtype=np.float64).ravel()
    rate = float(rate)
    if x.size == 0:
        return x.copy()
    if abs(rate - 1.0) < 1e-4:
        return x.copy()
    if x.size < n_fft:
        x = np.pad(x, (0, n_fft - x.size))
    hop_a = n_fft // 4
    hop_s = int(max(n_fft // 32, round(hop_a * rate)))
    nframes = 1 + (x.size - n_fft) // hop_a
    if nframes < 2:
        return resample_to_length(x, max(1, int(round(x.size * rate))))
    win = np.hanning(n_fft + 1)[:-1].astype(np.float64)
    win_sq = win * win
    base = np.arange(n_fft, dtype=np.int64)
    all_idx = np.arange(nframes, dtype=np.int64) * hop_a
    bins = np.arange(n_fft // 2 + 1, dtype=np.float64)
    expected_a = TWO_PI * bins * hop_a / n_fft
    expected_s = TWO_PI * bins * hop_s / n_fft
    out_len = (nframes - 1) * hop_s + n_fft
    y = np.zeros(out_len, dtype=np.float64)
    wsum = np.zeros(out_len, dtype=np.float64)
    acc = None
    block = 256
    for start in range(0, nframes, block):
        stop = min(nframes, start + block)
        idx = all_idx[start:stop]
        frames = x[idx[:, None] + base] * win
        spec = np.fft.rfft(frames, axis=1)
        mag = np.abs(spec)
        phase = np.angle(spec)
        out_spec = np.empty_like(spec)
        for j in range(stop - start):
            t = start + j
            if t == 0:
                acc = phase[0].copy()
                out_spec[0] = mag[0] * np.exp(1j * acc)
            else:
                delta = phase[j] - phase[j - 1] - expected_a
                delta = delta - TWO_PI * np.round(delta / TWO_PI)
                acc = acc + expected_s + delta
                out_spec[j] = mag[j] * np.exp(1j * acc)
        yframes = np.fft.irfft(out_spec, n=n_fft, axis=1) * win
        for j in range(stop - start):
            t = start + j
            s = t * hop_s
            y[s : s + n_fft] += yframes[j]
            wsum[s : s + n_fft] += win_sq
    y = y / np.maximum(wsum, 1e-8)
    target_len = int(round(x.size * rate))
    if target_len <= 0:
        target_len = 1
    y = resample_to_length(y, target_len)
    return y


def _pitch_time_stretch(
    x: np.ndarray, sr: int, pitch_factor: float, speed: float
) -> np.ndarray:
    """Change pitch by ``pitch_factor`` and speed by ``speed`` without formant work."""
    x = np.asarray(x, dtype=np.float64).ravel()
    if x.size == 0:
        return x.copy()
    pitch_factor = float(max(0.05, pitch_factor))
    speed = float(max(0.1, speed))
    target_len = max(1, int(round(x.size / speed)))
    if abs(pitch_factor - 1.0) < 1e-4 and abs(speed - 1.0) < 1e-4:
        return x.copy()
    stretch = pitch_factor / speed
    stretched = _pv_stretch(x, sr, stretch)
    return resample_to_length(stretched, target_len)


def _spectral_shape(
    x: np.ndarray, sr: int, formant: float, brightness: float
) -> np.ndarray:
    """Approximate formant shift + spectral tilt via STFT magnitude shaping."""
    x = np.asarray(x, dtype=np.float64).ravel()
    formant = _clip(formant, 0.5, 2.0)
    brightness = _clip(brightness, -1.0, 1.0)
    if x.size == 0:
        return x.copy()
    if abs(formant - 1.0) < 1e-3 and abs(brightness) < 1e-3:
        return x.copy()
    n_fft = 1024 if sr >= 16000 else 512
    hop = n_fft // 4
    win = np.hanning(n_fft + 1)[:-1].astype(np.float64)
    win_sq = win * win
    padded = x if x.size >= n_fft else np.pad(x, (0, n_fft - x.size))
    nframes = 1 + (padded.size - n_fft) // hop
    base = np.arange(n_fft, dtype=np.int64)
    all_idx = np.arange(nframes, dtype=np.int64) * hop
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    bin_hz = max(1e-9, float(sr) / n_fft)
    smooth_bins = max(3, int(round(400.0 / bin_hz)))
    tilt = None
    if abs(brightness) > 1e-3:
        tilt = np.clip(
            1.0 + 1.15 * brightness * np.tanh((freqs - 1400.0) / 1600.0),
            0.15,
            3.5,
        )
    out_len = (nframes - 1) * hop + n_fft
    y = np.zeros(out_len, dtype=np.float64)
    wsum = np.zeros(out_len, dtype=np.float64)
    block = 256
    for start in range(0, nframes, block):
        stop = min(nframes, start + block)
        idx = all_idx[start:stop]
        frames = padded[idx[:, None] + base] * win
        spec = np.fft.rfft(frames, axis=1)
        mag = np.abs(spec)
        phase = spec / np.maximum(mag, 1e-12)
        env = _smooth_rows(mag, smooth_bins)
        gain = np.ones_like(mag)
        if abs(formant - 1.0) > 1e-3:
            target_freqs = freqs / formant
            warped = np.empty_like(env)
            for i in range(env.shape[0]):
                warped[i] = np.interp(target_freqs, freqs, env[i])
            gain = np.clip((warped + 1e-9) / (env + 1e-9), 0.2, 5.0) ** 0.9
        if tilt is not None:
            gain = gain * tilt[None, :]
        yframes = np.fft.irfft(mag * gain * phase, n=n_fft, axis=1) * win
        for j in range(stop - start):
            s = (start + j) * hop
            y[s : s + n_fft] += yframes[j]
            wsum[s : s + n_fft] += win_sq
    y = y / np.maximum(wsum, 1e-8)
    if y.size < x.size:
        y = np.pad(y, (0, x.size - y.size))
    return y[: x.size]


def _apply_vibrato(y: np.ndarray, sr: int, depth: float) -> np.ndarray:
    depth = _clip(depth, 0.0, 1.0)
    if depth <= 1e-4 or y.size < 8:
        return y
    n = y.size
    t = np.arange(n, dtype=np.float64) / float(sr)
    rate = 1.0 + 0.03 * depth * np.sin(TWO_PI * 5.3 * t)
    pos = np.cumsum(rate)
    span = pos[-1] - pos[0]
    if span <= 1e-9:
        return y
    pos = (pos - pos[0]) / span * (n - 1)
    return np.interp(pos, np.arange(n, dtype=np.float64), y)


def _apply_tremolo(y: np.ndarray, sr: int, depth: float) -> np.ndarray:
    depth = _clip(depth, 0.0, 1.0)
    if depth <= 1e-4 or y.size < 8:
        return y
    t = np.arange(y.size, dtype=np.float64) / float(sr)
    amp = 1.0 - 0.30 * depth * (0.5 + 0.5 * np.sin(TWO_PI * 5.0 * t + 0.7))
    return y * amp


def _soft_limit(y: np.ndarray, ceiling: float = 0.98) -> np.ndarray:
    y = np.nan_to_num(np.asarray(y, dtype=np.float64), nan=0.0, posinf=0.0, neginf=0.0)
    peak = _peak(y)
    if peak <= ceiling:
        return y
    knee = 0.85 * ceiling
    absy = np.abs(y)
    over = absy > knee
    if not np.any(over):
        return y
    limited = absy.copy()
    span = max(1e-6, ceiling - knee)
    limited[over] = knee + span * np.tanh((absy[over] - knee) / span)
    out = np.sign(y) * limited
    peak2 = _peak(out)
    if peak2 > ceiling:
        out = out * (ceiling / peak2)
    return out


def _finalize(y: np.ndarray, ceiling: float = 0.95) -> np.ndarray:
    y = _soft_limit(y, ceiling)
    peak = _peak(y)
    if peak > ceiling and peak > 1e-9:
        y = y * (ceiling / peak)
    return y


def convert_signal(
    x: np.ndarray,
    sr: int,
    pitch_semitones: float = 0.0,
    formant: float = 1.0,
    brightness: float = 0.0,
    strength: float = 1.0,
    speed: float = 1.0,
    vibrato: float = 0.0,
    tremolo: float = 0.0,
) -> np.ndarray:
    """Shared DSP entry used by ``convert`` and ``emotion``."""
    x = np.asarray(x, dtype=np.float64).ravel()
    if x.size == 0:
        raise EngineError("输入音频为空")
    strength = _clip(strength, 0.0, 1.0)
    if strength <= 1e-6:
        return x.copy()
    pitch_semitones = _clip(pitch_semitones, -24.0, 24.0)
    speed = _clip(speed, 0.5, 2.0)
    formant = _clip(formant, 0.5, 2.0)
    brightness = _clip(brightness, -1.0, 1.0)
    pitch_factor = 2.0 ** (pitch_semitones / 12.0)

    target_len = max(1, int(round(x.size / speed)))
    wet = _pitch_time_stretch(x, sr, pitch_factor, speed)
    wet = _spectral_shape(wet, sr, formant, brightness)

    # match loudness of the wet signal to the dry signal before blending
    dry_rms = _rms(x)
    wet_rms = _rms(wet)
    if wet_rms > 1e-8 and dry_rms > 1e-8:
        wet = wet * _clip(dry_rms / wet_rms, 0.25, 3.0)

    if abs(speed - 1.0) < 1e-4:
        dry = x.copy()
    else:
        dry = _pitch_time_stretch(x, sr, 1.0, speed)

    blend = _clip(strength, 0.0, 1.0)
    out = (1.0 - blend) * dry + blend * wet
    out = resample_to_length(out, target_len)
    out = _apply_vibrato(out, sr, vibrato)
    out = _apply_tremolo(out, sr, tremolo)
    return _finalize(out)


# ---------------------------------------------------------------------------
# commands: analyze / slice
# ---------------------------------------------------------------------------

def cmd_analyze(args) -> dict:
    data, sr = read_wav(args.input)
    channels = int(data.shape[1])
    mono = data.mean(axis=1)
    return analyze_array(mono, sr, channels)


def _frame_rms(mono: np.ndarray, frame: int, hop: int) -> np.ndarray:
    x = mono
    if x.size < frame:
        x = np.pad(x, (0, frame - x.size))
    n = 1 + (x.size - frame) // hop
    if n <= 0:
        return np.zeros(0, dtype=np.float64)
    base = np.arange(frame, dtype=np.int64)
    idx = np.arange(n, dtype=np.int64) * hop
    seg = x[idx[:, None] + base]
    return np.sqrt(np.mean(seg * seg, axis=1))


def _detect_segments(mono: np.ndarray, sr: int, min_dur: float, max_dur: float):
    mono = np.asarray(mono, dtype=np.float64).ravel()
    if mono.size == 0:
        return []
    frame = int(max(128, round(sr * 0.02)))
    hop = int(max(64, round(sr * 0.01)))
    rms = _frame_rms(mono, frame, hop)
    if rms.size == 0:
        return []
    max_rms = float(np.max(rms))
    if max_rms < 1e-4:
        return []
    noise = float(np.percentile(rms, 10))
    # If even the quietest tenth is close to the peak there is no silence at
    # all (e.g. a continuous tone); in that case don't treat noise as a floor.
    if noise > 0.5 * max_rms:
        noise = 0.0
    thresh = max(noise * 2.5, max_rms * 0.06, 1.5e-3)
    active = rms > thresh
    # close short pauses inside a phrase (<= 0.3 s)
    gap_frames = max(2, int(round(0.30 * sr / hop)))
    indices = np.where(active)[0]
    if indices.size == 0:
        return []
    runs = []
    start = int(indices[0])
    prev = int(indices[0])
    for i in indices[1:]:
        i = int(i)
        if i - prev > gap_frames:
            runs.append((start, prev))
            start = i
        prev = i
    runs.append((start, prev))

    pad = int(round(0.05 * sr))
    spans = []
    for a, b in runs:
        s = max(0, a * hop - pad)
        e = min(mono.size, b * hop + frame + pad)
        spans.append([s, e])
    # merge spans separated by less than 0.25 s
    merged = []
    for s, e in spans:
        if merged and s - merged[-1][1] < int(0.25 * sr):
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])

    min_n = max(1, int(round(min_dur * sr)))
    max_n = max(min_n + 1, int(round(max_dur * sr)))
    segments = []
    for s, e in merged:
        if e - s < int(0.15 * sr):
            continue
        chunk = mono[s:e]
        if _peak(chunk) < 0.004:
            continue
        seg_frames = rms[max(0, s // hop) : max(1, e // hop)]
        if seg_frames.size and float(np.mean(seg_frames)) < thresh * 0.75:
            continue
        if e - s < min_n:
            need = min_n - (e - s)
            s = max(0, s - need // 2)
            e = min(mono.size, s + min_n)
            s = max(0, e - min_n)
            if e - s < min_n:
                # source shorter than minimum: keep what exists but skip
                if mono.size >= min_n:
                    continue
        segments.append((s, e))

    if not segments and mono.size > 0 and _peak(mono) >= 0.004:
        if mono.size >= int(0.2 * sr):
            segments = [(0, mono.size)]

    final = []
    for s, e in segments:
        cur = s
        while e - cur > max_n:
            lo = cur + int(0.55 * max_n)
            hi = min(e, cur + max_n)
            frame_ids = np.arange(lo // hop, max(lo // hop + 1, hi // hop))
            frame_ids = frame_ids[frame_ids < rms.size]
            if frame_ids.size > 1:
                cut = (int(frame_ids[int(np.argmin(rms[frame_ids]))]) + 1) * hop
                cut = min(max(cut, lo), hi)
            else:
                cut = hi
            if cut - cur >= int(0.4 * min_n):
                final.append((cur, cut))
                cur = cut
            else:
                break
        if e - cur >= int(0.4 * min_n):
            final.append((cur, e))
    return final


def cmd_slice(args) -> dict:
    data, sr = read_wav(args.input)
    mono = data.mean(axis=1)
    min_dur = _clip(args.min, 0.1, 10.0)
    max_dur = _clip(args.max, max(0.2, min_dur + 0.1), 60.0)
    segments = _detect_segments(mono, sr, min_dur, max_dur)
    outdir = os.path.abspath(args.outdir)
    os.makedirs(outdir, exist_ok=True)
    slices = []
    for i, (s, e) in enumerate(segments, start=1):
        seg = mono[s:e]
        if seg.size == 0 or _peak(seg) < 0.003:
            continue
        name = f"slice-{i:03d}.wav"
        path = os.path.join(outdir, name)
        write_wav(path, seg, sr)
        info = analyze_array(seg, sr, 1)
        slices.append(
            {
                "file": path,
                "duration": round(seg.size / float(sr), 3),
                "quality": info["quality"],
                "f0": info["f0"],
            }
        )
    if not slices:
        raise EngineError("没有检测到可切分的有效语音片段")
    return {
        "ok": True,
        "input": os.path.abspath(args.input),
        "outdir": outdir,
        "sampleRate": int(sr),
        "count": len(slices),
        "slices": slices,
    }


# ---------------------------------------------------------------------------
# commands: convert / emotion / mix / similarity
# ---------------------------------------------------------------------------

def _convert_result(out: np.ndarray, sr: int) -> dict:
    info = analyze_array(out, sr, 1)
    return {
        "ok": True,
        "duration": round(out.size / float(sr), 3),
        "sampleRate": int(sr),
        "f0": info["f0"],
        "centroid": info["centroid"],
        "brightness": info["brightness"],
        "peak": round(_peak(out), 5),
        "quality": info["quality"],
    }


def cmd_convert(args) -> dict:
    data, sr = read_wav(args.input)
    if data.shape[0] < 1:
        raise EngineError("输入音频为空")
    mono = data.mean(axis=1)
    if mono.size / float(sr) < 0.05:
        raise EngineError("输入音频过短（不足0.05秒）")
    out = convert_signal(
        mono,
        sr,
        pitch_semitones=args.pitch_semitones,
        formant=args.formant,
        brightness=args.brightness,
        strength=args.strength,
        speed=args.speed,
        vibrato=args.vibrato,
        tremolo=args.tremolo,
    )
    path = write_wav(args.output, out, sr)
    result = _convert_result(out, sr)
    result["input"] = os.path.abspath(args.input)
    result["output"] = path
    return result


EMOTION_PRESETS = {
    "calm": {"pitch": -1.2, "speed": 0.93, "brightness": -0.12, "vibrato": 0.04, "tremolo": 0.02},
    "happy": {"pitch": 2.6, "speed": 1.08, "brightness": 0.28, "vibrato": 0.10, "tremolo": 0.04},
    "tender": {"pitch": 1.0, "speed": 0.95, "brightness": -0.04, "vibrato": 0.16, "tremolo": 0.05},
    "serious": {"pitch": -2.0, "speed": 0.98, "brightness": -0.10, "vibrato": 0.0, "tremolo": 0.0},
    "comforting": {"pitch": -0.8, "speed": 0.90, "brightness": 0.02, "vibrato": 0.10, "tremolo": 0.04},
    "excited": {"pitch": 4.0, "speed": 1.15, "brightness": 0.38, "vibrato": 0.20, "tremolo": 0.07},
    "sad": {"pitch": -3.4, "speed": 0.85, "brightness": -0.28, "vibrato": 0.18, "tremolo": 0.05},
}


def cmd_emotion(args) -> dict:
    emotion = (args.emotion or "calm").strip().lower()
    if emotion not in EMOTION_PRESETS:
        allowed = "/".join(EMOTION_PRESETS.keys())
        raise EngineError(f"不支持的情绪: {args.emotion}（可用: {allowed}）")
    intensity = _clip(args.intensity, 0.0, 1.0)
    preset = EMOTION_PRESETS[emotion]
    scale = 0.35 + 0.65 * intensity
    data, sr = read_wav(args.input)
    mono = data.mean(axis=1)
    out = convert_signal(
        mono,
        sr,
        pitch_semitones=preset["pitch"] * scale,
        formant=1.0 + (0.04 if preset["brightness"] > 0 else -0.03) * scale,
        brightness=preset["brightness"] * scale,
        strength=0.35 + 0.6 * intensity,
        speed=1.0 + (preset["speed"] - 1.0) * scale,
        vibrato=preset["vibrato"] * scale,
        tremolo=preset["tremolo"] * scale,
    )
    path = write_wav(args.output, out, sr)
    result = _convert_result(out, sr)
    result.update(
        {
            "input": os.path.abspath(args.input),
            "output": path,
            "emotion": emotion,
            "intensity": round(intensity, 3),
        }
    )
    return result


def cmd_mix(args) -> dict:
    vocal_data, vocal_sr = read_wav(args.vocal)
    inst_data, inst_sr = read_wav(args.instrumental)
    target_sr = int(vocal_sr)
    vocal = vocal_data.mean(axis=1)
    if inst_sr != target_sr:
        inst_channels = []
        for ch in range(inst_data.shape[1]):
            inst_channels.append(resample(inst_data[:, ch], inst_sr, target_sr))
        inst = np.stack(inst_channels, axis=1)
    else:
        inst = inst_data.copy()
    if inst.shape[1] == 1:
        inst = np.repeat(inst, 2, axis=1)
    elif inst.shape[1] > 2:
        inst = inst[:, :2]
    if vocal.size == 0 or inst.shape[0] == 0:
        raise EngineError("人声或伴奏为空，无法混音")
    n = max(vocal.size, inst.shape[0])
    vocal_pad = np.zeros(n, dtype=np.float64)
    vocal_pad[: vocal.size] = vocal
    inst_pad = np.zeros((n, 2), dtype=np.float64)
    inst_pad[: inst.shape[0], : inst.shape[1]] = inst
    mix = inst_pad * float(args.inst_gain)
    mix[:, 0] += vocal_pad * float(args.vocal_gain)
    mix[:, 1] += vocal_pad * float(args.vocal_gain)
    mix = np.nan_to_num(mix, nan=0.0, posinf=0.0, neginf=0.0)
    peak = _peak(mix)
    if peak > 1e-9:
        if peak > 0.95:
            mix = _soft_limit(mix, 0.98)
            peak = _peak(mix)
        mix = mix * (0.95 / peak)
    path = write_wav(args.output, mix, target_sr)
    return {
        "ok": True,
        "duration": round(n / float(target_sr), 3),
        "sampleRate": target_sr,
        "channels": 2,
        "peak": round(_peak(mix), 5),
        "output": path,
    }


def _stft_channels(left, right, n_fft=1024, hop=256):
    """Return complex STFTs (freq, frames) for a stereo pair."""
    win = np.hanning(n_fft).astype(np.float64)
    pad = n_fft // 2
    lp = np.pad(left, (pad, pad), mode="reflect")
    rp = np.pad(right, (pad, pad), mode="reflect")
    frames = 1 + max(0, (lp.size - n_fft)) // hop
    if frames <= 0:
        raise EngineError("音频太短，无法分离")
    index = np.arange(n_fft)[None, :] + hop * np.arange(frames)[:, None]
    lf = lp[index] * win[None, :]
    rf = rp[index] * win[None, :]
    return np.fft.rfft(lf, axis=1).T, np.fft.rfft(rf, axis=1).T, win, pad, lp.size


def _istft_channel(spec, win, pad, length, hop):
    n_fft = win.size
    frames = spec.shape[1]
    out = np.zeros(n_fft + hop * (frames - 1), dtype=np.float64)
    norm = np.zeros_like(out)
    w2 = win * win
    for i in range(frames):
        frame = np.fft.irfft(spec[:, i], n_fft) * win
        start = i * hop
        out[start:start + n_fft] += frame
        norm[start:start + n_fft] += w2
    out = out / np.maximum(norm, 1e-8)
    return out[pad:pad + length]


def cmd_separate(args) -> dict:
    """Stereo center-channel soft-mask separation.

    Unlike a plain L/R difference, this preserves the stereo bed, keeps bass
    and center-panned instruments, and attenuates only the coherent center
    component (usually the lead vocal).
    """
    data, sr = read_wav(args.input)
    if data.ndim != 2 or data.shape[1] < 2:
        raise EngineError("人声分离需要立体声输入；单声道请先转换为双声道")
    left = data[:, 0].astype(np.float64)
    right = data[:, 1].astype(np.float64)
    length = min(left.size, right.size)
    left, right = left[:length], right[:length]
    n_fft = 1024
    hop = 256
    ls, rs, win, pad, padded_len = _stft_channels(left, right, n_fft, hop)
    mid = (ls + rs) * 0.5
    side = (ls - rs) * 0.5
    mag_mid = np.abs(mid)
    mag_side = np.abs(side)
    coherence = (mag_mid ** 2) / (mag_mid ** 2 + (1.8 * mag_side) ** 2 + 1e-12)
    mask = np.clip((coherence - 0.42) / 0.48, 0.0, 1.0)
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    # Keep bass/drums intact; only isolate the vocal band where center
    # coherence is meaningful.
    band = (1.0 / (1.0 + np.exp(-(freqs - 95.0) / 18.0))) * (
        1.0 / (1.0 + np.exp((freqs - 12500.0) / 700.0))
    )
    mask *= band[:, None]
    vocal_spec = mid * mask
    inst_l_spec = ls - vocal_spec
    inst_r_spec = rs - vocal_spec
    vocal = _istft_channel(vocal_spec, win, pad, padded_len, hop)[:length]
    inst_l = _istft_channel(inst_l_spec, win, pad, padded_len, hop)[:length]
    inst_r = _istft_channel(inst_r_spec, win, pad, padded_len, hop)[:length]
    # Avoid clicks from tiny residual DC and keep a safe peak.
    for arr in (vocal, inst_l, inst_r):
        arr -= float(np.mean(arr))
    peak = max(_peak(vocal), _peak(np.stack([inst_l, inst_r], axis=1)))
    if peak > 0.98:
        gain = 0.98 / peak
        vocal *= gain
        inst_l *= gain
        inst_r *= gain
    write_wav(args.vocal_out, vocal, sr)
    write_wav(args.inst_out, np.stack([inst_l, inst_r], axis=1), sr)
    return {
        "ok": True,
        "duration": round(length / float(sr), 3),
        "sampleRate": sr,
        "channels": 2,
        "vocal": args.vocal_out,
        "instrumental": args.inst_out,
        "maskMean": round(float(np.mean(mask)), 4),
        "peak": round(_peak(np.stack([inst_l, inst_r], axis=1)), 5),
    }


def _read_features(path: str) -> dict:
    if not path or not os.path.isfile(path):
        raise EngineError(f"目标特征文件不存在: {path}")
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            data = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        raise EngineError(f"目标特征 JSON 解析失败: {exc}")
    if not isinstance(data, dict):
        raise EngineError("目标特征 JSON 必须是对象")
    if isinstance(data.get("features"), dict):
        data = data["features"]
    return data


def cmd_similarity(args) -> dict:
    target = _read_features(args.target)
    try:
        target_f0 = float(target.get("f0") or 0.0)
        target_centroid = float(target.get("centroid") or 0.0)
        target_brightness = float(target.get("brightness") or 0.0)
    except (TypeError, ValueError):
        raise EngineError("目标特征中的 f0/centroid/brightness 必须是数字")
    if target_f0 <= 0:
        raise EngineError("目标特征缺少有效 f0")

    data, sr = read_wav(args.preview)
    preview = analyze_array(data.mean(axis=1), sr, int(data.shape[1]))
    p_f0 = float(preview["f0"])
    p_centroid = float(preview["centroid"])
    p_brightness = float(preview["brightness"])

    if p_f0 > 0:
        f0_dist = abs(math.log2(p_f0 / target_f0))
    else:
        f0_dist = 1.0
    if p_centroid > 0 and target_centroid > 0:
        cent_dist = abs(math.log2(p_centroid / target_centroid))
    else:
        cent_dist = 1.0
    bright_dist = abs(p_brightness - target_brightness)
    f0_dist = _clip(f0_dist, 0.0, 1.0)
    cent_dist = _clip(cent_dist, 0.0, 1.0)
    bright_dist = _clip(bright_dist, 0.0, 1.0)

    penalty = 0.5 * f0_dist + 0.3 * cent_dist + 0.2 * bright_dist
    similarity = _clip(100.0 * (1.0 - penalty), 0.0, 100.0)
    return {
        "ok": True,
        "similarity": round(similarity, 1),
        "f0Distance": round(f0_dist, 4),
        "centroidDistance": round(cent_dist, 4),
        "brightnessDistance": round(bright_dist, 4),
        "preview": preview,
        "target": {
            "f0": target_f0,
            "centroid": target_centroid,
            "brightness": target_brightness,
            "quality": target.get("quality"),
        },
    }


# ---------------------------------------------------------------------------
# demo material synthesis
# ---------------------------------------------------------------------------

VOWEL_FORMANTS = {
    "a": [(730.0, 1.0, 95.0), (1090.0, 0.55, 120.0), (2440.0, 0.22, 180.0)],
    "la": [(420.0, 0.55, 75.0), (1250.0, 0.42, 130.0), (2700.0, 0.18, 170.0)],
}


def _formant_gain(freqs: np.ndarray, formants) -> np.ndarray:
    freqs = np.asarray(freqs, dtype=np.float64)
    gain = np.zeros_like(freqs)
    for center, amp, bandwidth in formants:
        gain += amp / (1.0 + ((freqs - center) / bandwidth) ** 2)
    return gain


def _synth_note(
    f0: float,
    dur: float,
    sr: int,
    formants,
    amp: float,
    rng: np.random.Generator,
    vibrato: float = 0.012,
    glide_from: float | None = None,
) -> np.ndarray:
    n = max(1, int(round(dur * sr)))
    t = np.arange(n, dtype=np.float64) / float(sr)
    freq = np.full(n, float(f0), dtype=np.float64)
    if glide_from and glide_from > 0:
        gl = min(n, max(1, int(0.04 * sr)))
        freq[:gl] = np.linspace(glide_from, f0, gl)
    if vibrato > 0:
        freq = freq * (1.0 + vibrato * np.sin(TWO_PI * 5.4 * t + rng.uniform(0, TWO_PI)))
    phase = TWO_PI * np.cumsum(freq) / float(sr)
    out = np.zeros(n, dtype=np.float64)
    max_h = int(min(48, max(1, math.floor(5600.0 / max(60.0, f0)))))
    for h in range(1, max_h + 1):
        a = float(_formant_gain(np.array([h * f0]), formants)[0])
        if a < 0.004:
            continue
        out += a * np.sin(h * phase + rng.uniform(0.0, TWO_PI))
    peak = _peak(out)
    if peak > 1e-9:
        out = out / peak
    attack = np.minimum(1.0, t / 0.035)
    release = np.minimum(1.0, np.maximum(0.0, dur - t) / 0.07)
    env = attack * release
    env = np.minimum(1.0, env * 1.15)
    breath = rng.standard_normal(n) * 0.010 * env
    return (out * env + breath) * amp


def _synth_phrase(
    notes, sr: int, seed: int, total_dur: float, start: float = 0.0
) -> np.ndarray:
    rng = np.random.default_rng(seed)
    total = max(1, int(round(total_dur * sr)))
    out = np.zeros(total, dtype=np.float64)
    pos = int(round(start * sr))
    prev = None
    for freq, dur, vowel in notes:
        note = _synth_note(
            float(freq),
            float(dur),
            sr,
            VOWEL_FORMANTS.get(vowel, VOWEL_FORMANTS["a"]),
            0.55,
            rng,
            vibrato=0.010,
            glide_from=prev,
        )
        s = pos
        e = min(total, s + note.size)
        if s < total:
            out[s:e] += note[: e - s]
        pos += note.size
        prev = float(freq)
    return out


DEMO_MELODY = [
    (392.00, 1.0, "a"),
    (440.00, 1.0, "la"),
    (523.25, 1.2, "a"),
    (493.88, 0.8, "la"),
    (440.00, 1.0, "a"),
    (392.00, 1.0, "la"),
    (349.23, 1.2, "a"),
    (392.00, 0.8, "la"),
    (440.00, 1.2, "a"),
    (523.25, 1.0, "la"),
    (587.33, 1.2, "a"),
    (523.25, 0.8, "la"),
    (493.88, 1.2, "a"),
    (440.00, 1.0, "la"),
    (392.00, 1.4, "a"),
    (392.00, 1.4, "la"),
]


def _synth_demo_instrumental(dur: float, sr: int, seed: int = 20261030):
    rng = np.random.default_rng(seed)
    n = int(round(dur * sr))
    t = np.arange(n, dtype=np.float64) / float(sr)
    left = np.zeros(n, dtype=np.float64)
    right = np.zeros(n, dtype=np.float64)
    chords = [
        [261.63, 329.63, 392.00],
        [220.00, 261.63, 329.63],
        [174.61, 220.00, 261.63],
        [196.00, 246.94, 293.66],
        [261.63, 329.63, 392.00],
        [220.00, 261.63, 329.63],
        [174.61, 220.00, 261.63],
        [196.00, 246.94, 293.66],
        [261.63, 329.63, 392.00],
        [174.61, 220.00, 261.63],
    ]
    chord_dur = float(dur) / len(chords)
    for ci, chord in enumerate(chords):
        c0 = ci * chord_dur
        length = min(n, int(round((c0 + chord_dur) * sr)))
        s0 = int(round(c0 * sr))
        if s0 >= n:
            break
        local_t = np.arange(length - s0, dtype=np.float64) / float(sr)
        # pad: sustained chord, panned slightly to the right
        pad = np.zeros(local_t.size, dtype=np.float64)
        for f in chord:
            pad += np.sin(TWO_PI * f * local_t + rng.uniform(0.0, TWO_PI))
            pad += 0.4 * np.sin(TWO_PI * f * 1.003 * local_t)
        pad_env = np.minimum(1.0, local_t / 0.35) * np.minimum(
            1.0, np.maximum(0.0, chord_dur - local_t) / 0.5
        )
        pad = pad * pad_env * 0.055
        right[s0:length] += pad
        left[s0:length] += pad * 0.30
        # arpeggio: short plucked triangle notes, panned left
        step = 0.25
        k = 0
        while k * step < chord_dur - 1e-6:
            note_f = chord[k % len(chord)] * 2.0
            ns = s0 + int(round(k * step * sr))
            ne = min(n, ns + int(round(step * 2.4 * sr)))
            if ns >= n or ne <= ns:
                break
            nt = np.arange(ne - ns, dtype=np.float64) / float(sr)
            tri = (2.0 / np.pi) * np.arcsin(np.sin(TWO_PI * note_f * nt))
            env = np.exp(-nt / 0.28) * np.minimum(1.0, nt / 0.006)
            tone = tri * env * 0.11
            left[ns:ne] += tone
            right[ns:ne] += tone * 0.25
            k += 1
        # bass, centered and quiet
        bass_f = chord[0] / 2.0
        bass = np.sin(TWO_PI * bass_f * local_t) * np.exp(-local_t / 0.9)
        bass *= np.minimum(1.0, local_t / 0.02) * 0.10
        left[s0:length] += bass
        right[s0:length] += bass
        # soft hi-hat / shaker on every other eighth, alternating pan
        for beat in range(int(chord_dur / 0.5)):
            hs = s0 + int(round(beat * 0.5 * sr))
            hn = min(n, hs + int(0.05 * sr))
            if hs >= n or hn <= hs:
                break
            noise = rng.standard_normal(hn - hs)
            noise = np.diff(np.concatenate([[0.0], noise])) * 0.5
            env = np.exp(-np.arange(hn - hs) / (0.012 * sr))
            hat = noise * env * 0.03
            if beat % 2 == 0:
                left[hs:hn] += hat
            else:
                right[hs:hn] += hat
    return left, right


def _demo_samples(outdir: str, sr: int) -> list:
    """Three timbre profiles x three samples, same synthesized sentence."""
    phrase_notes = [
        (220.0, 0.34, "a"),
        (246.94, 0.30, "la"),
        (261.63, 0.34, "a"),
        (246.94, 0.30, "la"),
        (220.0, 0.34, "a"),
        (196.0, 0.30, "la"),
        (220.0, 0.36, "a"),
        (246.94, 0.32, "la"),
    ]
    base = _synth_phrase(phrase_notes, sr, seed=7717, total_dur=3.0)
    profiles = [
        ("profile-a", -1.8, 0.93, -0.20),
        ("profile-b", 0.4, 1.00, 0.08),
        ("profile-c", 3.2, 1.10, 0.32),
    ]
    results = []
    for pname, pitch, formant, brightness in profiles:
        pdir = os.path.join(outdir, "samples", pname)
        os.makedirs(pdir, exist_ok=True)
        files = []
        for si, (dpitch, dspeed) in enumerate([(0.0, 1.0), (0.9, 1.02), (-0.9, 0.98)], start=1):
            out = convert_signal(
                base,
                sr,
                pitch_semitones=pitch + dpitch,
                formant=formant,
                brightness=brightness,
                strength=0.85,
                speed=dspeed,
                vibrato=0.05,
                tremolo=0.02,
            )
            path = os.path.join(pdir, f"sample-{si}.wav")
            write_wav(path, out, sr)
            info = analyze_array(out, sr, 1)
            files.append(
                {
                    "file": path,
                    "duration": round(out.size / float(sr), 3),
                    "f0": info["f0"],
                    "quality": info["quality"],
                }
            )
        results.append(
            {
                "id": pname,
                "directory": pdir,
                "pitchSemitones": pitch,
                "formant": formant,
                "brightness": brightness,
                "files": files,
            }
        )
    return results


def cmd_demo(args) -> dict:
    outdir = os.path.abspath(args.outdir)
    os.makedirs(outdir, exist_ok=True)
    sr = 24000
    song_name = "晚风里的旋律（示例）"
    intro = 1.2
    total_dur = 20.0
    melody = DEMO_MELODY
    melody_len = sum(d for _, d, _ in melody)
    if intro + melody_len > total_dur:
        total_dur = intro + melody_len + 1.0
    vocal = _synth_phrase(
        melody, sr, seed=424242, total_dur=total_dur, start=intro
    )
    inst_left, inst_right = _synth_demo_instrumental(total_dur, sr, seed=99173)
    vocal_gain = 0.52
    stereo = np.stack(
        [
            inst_left + vocal * vocal_gain,
            inst_right + vocal * vocal_gain,
        ],
        axis=1,
    )
    peak = _peak(stereo)
    if peak > 1e-9:
        stereo = stereo * (0.90 / peak)
    original_path = os.path.join(outdir, "demo-original.wav")
    write_wav(original_path, stereo, sr)
    orig_info = analyze_array(stereo.mean(axis=1), sr, 2)

    samples = _demo_samples(outdir, sr)
    vocal_end = intro + melody_len
    meta = {
        "songName": song_name,
        "duration": round(total_dur, 3),
        "sampleRate": sr,
        "vocal": {
            "position": "center",
            "start": round(intro, 3),
            "end": round(vocal_end, 3),
            "description": "人声位于左右声道正中，伴奏左右声场不同（左：琶音/沙锤，右：铺底和弦）",
        },
        "file": original_path,
        "description": "纯 numpy 共振峰合成生成，可复现；仅用于本地验收。",
    }
    meta_path = os.path.join(outdir, "demo-song-meta.json")
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)

    return {
        "ok": True,
        "outdir": outdir,
        "original": {
            "file": original_path,
            "duration": round(total_dur, 3),
            "sampleRate": sr,
            "channels": 2,
            "f0": orig_info["f0"],
            "quality": orig_info["quality"],
            "issues": orig_info["issues"],
            "vocal": meta["vocal"],
        },
        "song": {"name": song_name, "duration": round(total_dur, 3)},
        "profiles": samples,
        "metaFile": meta_path,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="voice_engine.py",
        description="dsh-voice-unified 纯 numpy 音频引擎",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("analyze", help="分析音频")
    p.add_argument("--input", required=True)
    p.add_argument("--json", dest="json_path", default="")
    p.set_defaults(func=cmd_analyze)

    p = sub.add_parser("slice", help="按静音切分")
    p.add_argument("--input", required=True)
    p.add_argument("--outdir", required=True)
    p.add_argument("--json", dest="json_path", default="")
    p.add_argument("--min", type=float, default=0.8)
    p.add_argument("--max", type=float, default=15.0)
    p.set_defaults(func=cmd_slice)

    p = sub.add_parser("convert", help="音色/音高转换")
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--json", dest="json_path", default="")
    p.add_argument("--pitch-semitones", type=float, default=0.0)
    p.add_argument("--formant", type=float, default=1.0)
    p.add_argument("--brightness", type=float, default=0.0)
    p.add_argument("--strength", type=float, default=1.0)
    p.add_argument("--speed", type=float, default=1.0)
    p.add_argument("--vibrato", type=float, default=0.0)
    p.add_argument("--tremolo", type=float, default=0.0)
    p.set_defaults(func=cmd_convert)

    p = sub.add_parser("emotion", help="情绪韵律处理")
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--json", dest="json_path", default="")
    p.add_argument("--emotion", required=True)
    p.add_argument("--intensity", type=float, default=0.7)
    p.set_defaults(func=cmd_emotion)

    p = sub.add_parser("mix", help="人声与伴奏混音")
    p.add_argument("--vocal", required=True)
    p.add_argument("--instrumental", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--json", dest="json_path", default="")
    p.add_argument("--vocal-gain", type=float, default=1.0)
    p.add_argument("--inst-gain", type=float, default=1.0)
    p.set_defaults(func=cmd_mix)

    p = sub.add_parser("separate", help="立体声中置人声软掩码分离")
    p.add_argument("--input", required=True)
    p.add_argument("--vocal-out", required=True)
    p.add_argument("--inst-out", required=True)
    p.add_argument("--json", dest="json_path", default="")
    p.set_defaults(func=cmd_separate)

    p = sub.add_parser("similarity", help="与目标音色特征比较")
    p.add_argument("--target", required=True)
    p.add_argument("--preview", required=True)
    p.add_argument("--json", dest="json_path", default="")
    p.set_defaults(func=cmd_similarity)

    p = sub.add_parser("demo", help="生成验收示例素材")
    p.add_argument("--outdir", required=True)
    p.add_argument("--json", dest="json_path", default="")
    p.set_defaults(func=cmd_demo)
    return parser


def main(argv=None) -> int:
    _setup_stdio()
    parser = build_parser()
    args = parser.parse_args(argv)
    json_path = getattr(args, "json_path", "")
    try:
        result = args.func(args)
        result = _sanitize(result)
        _write_json_file(json_path, result)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    except EngineError as exc:
        message = str(exc)
    except Exception as exc:  # noqa: BLE001 - never leak a traceback to callers
        message = f"引擎内部错误: {exc.__class__.__name__}: {exc}"
    failure = {"ok": False, "error": message}
    try:
        _write_json_file(json_path, failure)
    except Exception:  # noqa: BLE001
        pass
    print(json.dumps(failure, ensure_ascii=False, allow_nan=False))
    print(message, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
