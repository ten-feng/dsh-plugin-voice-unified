#!/usr/bin/env node
/** Create and train three demo voice profiles through a running plugin API.
 *
 * Usage: node examples/seed-demo.mjs http://127.0.0.1:61999
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASE = (process.argv[2] || 'http://127.0.0.1:61999').replace(/\/$/, '')
const API = `${BASE}/plugins/dsh-voice-unified/api`
const DEMO = path.join(HERE, 'demo')
const suffix = Date.now().toString().slice(-5)

async function request(method, endpoint, body) {
  const response = await fetch(API + endpoint, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`)
  return data
}

async function waitTraining(profileId) {
  for (let index = 0; index < 180; index += 1) {
    const detail = await request('GET', `/profiles/${profileId}`)
    if (detail.profile.training && detail.profile.training.status !== 'training') {
      if (detail.profile.training.status !== 'done') throw new Error(detail.profile.training.error || '训练失败')
      return detail.profile
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('训练超时')
}

const health = await request('GET', '/health')
if (!health.engine?.ok) throw new Error(`引擎未就绪：${health.engine?.detail || 'unknown'}`)
console.log('engine ready:', health.engine.tts)

const created = []
for (const [index, key] of ['profile-a', 'profile-b', 'profile-c'].entries()) {
  const label = String.fromCharCode(65 + index)
  const profile = (await request('POST', '/profiles', {
    name: `示例音色${label}-${suffix}`,
    description: `由 examples/seed-demo.mjs 创建（${key}）`,
    tags: ['示例', `组${label}`],
  })).profile
  for (const [sampleIndex, file] of ['sample-1.wav', 'sample-2.wav', 'sample-3.wav'].entries()) {
    const buffer = await readFile(path.join(DEMO, 'samples', key, file))
    await request('POST', `/profiles/${profile.id}/samples`, {
      filename: file,
      dataBase64: buffer.toString('base64'),
    })
    console.log(`  ${profile.name}: 样本 ${sampleIndex + 1}/3`)
  }
  await request('POST', `/profiles/${profile.id}/train`, { note: 'seed-demo' })
  const trained = await waitTraining(profile.id)
  created.push(trained)
  console.log(`  ${profile.name}: 训练完成 ${trained.currentVersion?.label} 相似度 ${trained.currentVersion?.similarity}`)
}

await request('POST', `/profiles/${created[0].id}/default`)
console.log(`\n默认音色：${created[0].name}`)
for (const profile of created) {
  const preview = await request('POST', `/profiles/${profile.id}/preview`, { text: '你好，这是示例音色试听。', emotion: 'tender' })
  console.log(`${profile.name}｜${profile.currentVersion.label}｜${preview.audioUrl}`)
}
console.log(`\n在管理面板打开「音色管理」即可看到 ${created.length} 个示例音色。`)
