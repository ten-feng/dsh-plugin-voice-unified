/** Text emotion analysis and prosody parameter mapping.
 *
 * The analysis is deliberately deterministic and local: it never rewrites the
 * reply text, only maps signals to TTS prosody. A caller can always override
 * the emotion for a single utterance.
 */

export const EMOTIONS = {
  calm: { zh: '平静', en: 'calm', rate: 1.0, pitch: 0, brightness: 0, vibrato: 0, pauseMs: 180, energy: 0 },
  happy: { zh: '开心', en: 'happy', rate: 1.08, pitch: 1.2, brightness: 0.08, vibrato: 0.04, pauseMs: 150, energy: 0.35 },
  tender: { zh: '温柔', en: 'tender', rate: 0.92, pitch: -0.35, brightness: -0.04, vibrato: 0.03, pauseMs: 230, energy: 0.12 },
  serious: { zh: '严肃', en: 'serious', rate: 0.94, pitch: -0.8, brightness: -0.1, vibrato: 0, pauseMs: 230, energy: 0.42 },
  comforting: { zh: '安慰', en: 'comforting', rate: 0.88, pitch: -0.55, brightness: -0.02, vibrato: 0.02, pauseMs: 260, energy: 0.05 },
  excited: { zh: '兴奋', en: 'excited', rate: 1.16, pitch: 2.1, brightness: 0.14, vibrato: 0.08, pauseMs: 120, energy: 0.9 },
  sad: { zh: '低落', en: 'sad', rate: 0.84, pitch: -1.6, brightness: -0.14, vibrato: 0.02, pauseMs: 320, energy: 0.02 },
}

export const EMOTION_ALIASES = {
  '平静': 'calm', '中性': 'calm', 'normal': 'calm', 'neutral': 'calm',
  '开心': 'happy', '高兴': 'happy', '快乐': 'happy', 'joy': 'happy',
  '温柔': 'tender', '柔和': 'tender', 'soft': 'tender',
  '严肃': 'serious', '认真': 'serious', '警告': 'serious',
  '安慰': 'comforting', '安抚': 'comforting', 'caring': 'comforting',
  '兴奋': 'excited', '激动': 'excited', 'excite': 'excited',
  '低落': 'sad', '难过': 'sad', '悲伤': 'sad', 'sorrow': 'sad',
}

const RULES = [
  { emotion: 'comforting', weight: 1.15, words: ['别担心', '没关系', '不要紧', '我理解', '我懂', '抱抱', '慢慢来', '会好的', '陪你', '辛苦了', '休息一下', '没事的'] },
  { emotion: 'sad', weight: 1.3, words: ['遗憾', '难过', '伤心', '失落', '可惜', '抱歉', '对不起', '舍不得', '低落', '沮丧', '唉', '心疼'] },
  { emotion: 'excited', weight: 1.25, words: ['太棒了', '太好了', '激动', '终于', '成功啦', '冲', '燃', '绝了', '哇塞', '!!'] },
  { emotion: 'serious', weight: 1.1, words: ['重要', '必须', '注意', '风险', '警告', '结论', '严格', '禁止', '务必', '关键', '失败', '错误'] },
  { emotion: 'tender', weight: 1.05, words: ['晚安', '早安', '想你', '亲爱的', '轻轻', '温柔', '陪你', '宝贝', '好梦', '慢慢'] },
  { emotion: 'happy', weight: 1.0, words: ['开心', '高兴', '哈哈', '恭喜', '好呀', '真棒', '喜欢', '愉快', '顺利', '好消息', '可爱'] },
]

function scoreText(text) {
  const scores = Object.fromEntries(Object.keys(EMOTIONS).map((key) => [key, 0]))
  const source = String(text || '')
  for (const rule of RULES) {
    for (const word of rule.words) {
      if (!source.includes(word)) continue
      scores[rule.emotion] += rule.weight * (word.length >= 3 ? 1.2 : 1)
    }
  }
  const exclamations = (source.match(/[!！]/g) || []).length
  const questions = (source.match(/[?？]/g) || []).length
  const ellipsis = (source.match(/…|\.\.\./g) || []).length
  scores.excited += Math.max(0, exclamations - 1) * 0.8
  scores.happy += Math.min(2, exclamations) * 0.25
  scores.sad += ellipsis * 0.4
  scores.serious += questions > 2 ? 0.2 : 0
  if (/😊|😄|😁|🎉|❤️|🥰/.test(source)) scores.happy += 1.2
  if (/😢|😭|💔|😔/.test(source)) scores.sad += 1.5
  if (/🔥|🚀|✨/.test(source)) scores.excited += 0.8
  if (/^[\s\S]{0,4}(嗯|好的|收到|可以)[。.!！]?$/.test(source.trim())) scores.calm += 1
  if (source.length < 8 && exclamations === 0) scores.calm += 0.4
  return scores
}

export function normalizeEmotion(value) {
  if (!value) return null
  const raw = String(value).trim().toLowerCase()
  if (EMOTIONS[raw]) return raw
  return EMOTION_ALIASES[String(value).trim()] || EMOTION_ALIASES[raw] || null
}

/**
 * Analyze reply text. Returns { emotion, confidence, intensity, scores }.
 * `previous` is the cross-turn emotion state ({emotion, updatedAt}); when the
 * current text has no signal, it is used as a fallback if enabled.
 */
export function analyzeEmotion(text, { previous, crossTurn = true, defaultEmotion = 'calm', intensity = 0.7 } = {}) {
  const scores = scoreText(text)
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const [best, bestScore] = sorted[0] || ['calm', 0]
  const total = sorted.reduce((sum, [, score]) => sum + score, 0)
  let emotion = bestScore > 0 ? best : null

  if (!emotion) {
    if (crossTurn && previous?.emotion && EMOTIONS[previous.emotion]) {
      const age = Date.now() - Number(previous.updatedAt || 0)
      if (age < 20 * 60 * 1000) emotion = previous.emotion
    }
  }
  if (!emotion) emotion = normalizeEmotion(defaultEmotion) || 'calm'
  if (emotion === 'calm' && bestScore === 0 && crossTurn && previous?.emotion && EMOTIONS[previous.emotion]) {
    const age = Date.now() - Number(previous.updatedAt || 0)
    if (age < 5 * 60 * 1000) emotion = previous.emotion
  }

  const confidence = total > 0 ? Math.min(1, (bestScore / total) * 1.5) : 0.15
  const punctuationBoost = Math.min(0.25, ((String(text).match(/[!！]/g) || []).length) * 0.08)
  const resolvedIntensity = Math.max(0.15, Math.min(1, Number(intensity ?? 0.7) * (0.75 + confidence * 0.35) + punctuationBoost))
  return { emotion, confidence, intensity: resolvedIntensity, scores, changed: Boolean(bestScore > 0) }
}

export function emotionParams(emotion, intensity = 0.7) {
  const base = EMOTIONS[normalizeEmotion(emotion) || 'calm'] || EMOTIONS.calm
  const k = Math.max(0, Math.min(1, Number(intensity ?? 0.7)))
  return {
    key: base.en,
    label: base.zh,
    rate: 1 + (base.rate - 1) * k,
    pitch: base.pitch * k,
    brightness: base.brightness * k,
    vibrato: base.vibrato * k,
    pauseMs: Math.round(120 + (base.pauseMs - 120) * k),
    energy: base.energy * k,
  }
}

export function listEmotions() {
  return Object.entries(EMOTIONS).map(([key, value]) => ({ key, label: value.zh, en: value.en }))
}
