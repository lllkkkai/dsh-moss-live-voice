/** Durable transcript history for the voice channel, kept outside Session logs. */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Hard cap on stored entries; the oldest lines are dropped first. */
const MAX_ENTRIES = 2000

/**
 * Resolve the history file, honouring an explicit override.
 * @param {object} settings resolved settings
 * @returns {string} absolute path
 */
export function historyPath(settings) {
  return settings?.historyFile ?? join(homedir(), '.dsh', 'moss-live', 'history.jsonl')
}

/**
 * Ensure the parent directory exists.
 * @param {string} path history file path
 * @returns {void}
 */
function ensureParent(path) {
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    /* an existing directory is fine */
  }
}

/**
 * Read every stored entry, skipping unreadable lines.
 * @param {object} settings resolved settings
 * @returns {Array<Record<string, unknown>>} entries in write order
 */
function readAll(settings) {
  const path = historyPath(settings)
  if (!existsSync(path)) return []
  try {
    const text = readFileSync(path, 'utf8')
    const entries = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed !== null && typeof parsed === 'object') entries.push(parsed)
      } catch {
        /* a torn line is skipped rather than failing the whole history */
      }
    }
    return entries
  } catch {
    return []
  }
}

/**
 * Append one finished turn and trim the file when it exceeds the cap.
 * @param {object} settings resolved settings
 * @param {{role: string, text: string, at?: string, sessionId?: string}} entry turn
 * @returns {void}
 */
export function appendHistory(settings, entry) {
  const text = typeof entry.text === 'string' ? entry.text.trim() : ''
  if (text === '') return
  if (entry.role !== 'user' && entry.role !== 'assistant') return
  const path = historyPath(settings)
  ensureParent(path)
  const record = {
    at: typeof entry.at === 'string' ? entry.at : new Date().toISOString(),
    role: entry.role,
    text: text.slice(0, 4000),
    sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
  }
  try {
    appendFileSync(path, JSON.stringify(record) + '\n')
    const all = readAll(settings)
    if (all.length > MAX_ENTRIES) {
      writeFileSync(path, all.slice(-MAX_ENTRIES).map(item => JSON.stringify(item)).join('\n') + '\n')
    }
  } catch {
    /* history is best effort; never break the voice session */
  }
}

/**
 * Read the newest entries, oldest first.
 * @param {object} settings resolved settings
 * @param {number} limit maximum entries to return
 * @returns {Array<Record<string, unknown>>} entries
 */
export function readHistory(settings, limit = 100) {
  const all = readAll(settings)
  const bounded = Number.isSafeInteger(limit) && limit > 0 ? limit : 100
  return all.slice(-bounded)
}

/**
 * Delete the stored history file.
 * @param {object} settings resolved settings
 * @returns {void}
 */
export function clearHistory(settings) {
  try {
    unlinkSync(historyPath(settings))
  } catch {
    /* already absent */
  }
}
