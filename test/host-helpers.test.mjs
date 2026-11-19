/** Host-side helpers: settings resolution, key files, transcript history, prompt clamping. */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolveSettings } from '../src/host/settings.js'
import { clearKey, describeKey, normalizeKey, saveKey } from '../src/host/keys.js'
import { appendHistory, clearHistory, historyPath, readHistory } from '../src/host/history.js'
import { clampBytes, clampChars } from '../src/host/progress.js'
import { finalAssistantText } from '../src/host/runner.js'

/** Create an isolated temp directory for one test. */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'moss-live-test-'))
}

test('settings fall back to documented defaults and accept overrides', () => {
  const defaults = resolveSettings({})
  assert.equal(defaults.model, 'moss-live-1.0')
  assert.equal(defaults.apiKeyEnv, 'MOSS_API_KEY')
  assert.equal(defaults.maxConcurrency, 1)
  assert.equal(defaults.upstream, undefined)

  const custom = resolveSettings({ upstream: false, model: 'm-2', maxConcurrency: 3, selfTest: 'x' })
  assert.equal(custom.upstream, false)
  assert.equal(custom.model, 'm-2')
  assert.equal(custom.maxConcurrency, 3)
  assert.equal(custom.selfTest, 'x')
})

test('keys are saved with 0600, described as a mask, and cleared', () => {
  const dir = tempDir()
  try {
    const settings = { apiKeyFile: join(dir, 'moss-live.key'), apiKeyEnv: 'MOSS_LIVE_TEST_MISSING' }
    const saved = saveKey(settings, 'sk-test-1234567890abcd')
    assert.equal(saved.configured, true)
    assert.equal(saved.source, 'config-file')
    assert.equal(saved.masked, '••••abcd')
    assert.equal(saved.masked.includes('1234567890'), false)
    assert.equal(statSync(settings.apiKeyFile).mode & 0o777, 0o600)
    // Clearing this file falls back to whatever else the machine offers; the owned
    // source must no longer be the config file.
    const cleared = clearKey(settings)
    assert.notEqual(cleared.source, 'config-file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('key normalisation refuses whitespace, blanks and short values', () => {
  assert.equal(normalizeKey('  sk-abc-def  '), 'sk-abc-def')
  assert.equal(normalizeKey('has space'), undefined)
  assert.equal(normalizeKey('short'), undefined)
  assert.equal(normalizeKey(42), undefined)
})

test('history appends, reads back in order, and clears', () => {
  const dir = tempDir()
  try {
    const settings = { historyFile: join(dir, 'history.jsonl') }
    assert.equal(readHistory(settings, 10).length, 0)
    appendHistory(settings, { role: 'user', text: '第一句', sessionId: 's1' })
    appendHistory(settings, { role: 'assistant', text: '第一答', sessionId: 's1' })
    appendHistory(settings, { role: 'user', text: '   ' })
    const entries = readHistory(settings, 10)
    assert.equal(entries.length, 2)
    assert.equal(entries[0].text, '第一句')
    assert.equal(entries[1].role, 'assistant')
    assert.equal(readHistory(settings, 1).length, 1)
    assert.equal(historyPath(settings), settings.historyFile)
    clearHistory(settings)
    assert.equal(readHistory(settings, 10).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('spoken summaries are clamped by bytes and characters', () => {
  assert.equal(clampBytes('你好世界', 6), '你好')
  assert.equal(clampBytes('abcdef', 100), 'abcdef')
  assert.equal(clampChars('abcdef', 4), 'abc…')
  assert.equal(clampChars('abc', 4), 'abc')
})

test('runner reads the last non-empty assistant text after its first seq', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧回答' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新回答' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '   ' }] } } },
  ]
  const session = {
    seq: events.length,
    eventAt: index => events[index],
  }
  assert.equal(finalAssistantText(session, 0), '新回答')
  // A later firstSeq must ignore earlier turns.
  assert.equal(finalAssistantText(session, 3), '')
})
