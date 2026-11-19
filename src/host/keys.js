import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Default key file written by the panel and read on every connect. */
export function defaultKeyPath() {
  return join(homedir(), '.dsh', 'moss-live.key')
}

/**
 * Read one key file, treating a missing or blank file as absent.
 * @param {string | undefined} path candidate path
 * @returns {string | undefined} trimmed key
 */
function readKeyFile(path) {
  if (path === undefined) return undefined
  try {
    const value = readFileSync(path, 'utf8').trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * List every key source in precedence order. A key saved from the panel wins
 * over the process environment so the visible setting always takes effect.
 * @param {object} settings resolved settings
 * @returns {Array<{source: string, label: string, value?: string}>} sources
 */
export function keySources(settings) {
  return [
    { source: 'config-file', label: settings.apiKeyFile ?? '', value: readKeyFile(settings.apiKeyFile) },
    { source: 'key-file', label: defaultKeyPath(), value: readKeyFile(defaultKeyPath()) },
    { source: 'env', label: settings.apiKeyEnv, value: environKey(settings) },
  ]
}

/**
 * Read the configured environment variable.
 * @param {object} settings resolved settings
 * @returns {string | undefined} key
 */
function environKey(settings) {
  const value = process.env[settings.apiKeyEnv]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Resolve the effective MOSS API key without exposing it to the browser.
 * @param {object} settings resolved settings
 * @returns {string | undefined} api key
 */
export function resolveApiKey(settings) {
  for (const entry of keySources(settings)) {
    if (entry.value !== undefined) return entry.value
  }
  return undefined
}

/**
 * Describe the effective key for display: never returns the secret itself.
 * @param {object} settings resolved settings
 * @returns {{configured: boolean, masked: string, source: string, path: string}} public state
 */
export function describeKey(settings) {
  for (const entry of keySources(settings)) {
    if (entry.value === undefined) continue
    const tail = Array.from(entry.value).slice(-4).join('')
    return { configured: true, masked: `••••${tail}`, source: entry.source, path: entry.label }
  }
  return { configured: false, masked: '', source: 'none', path: defaultKeyPath() }
}

/**
 * Persist a key typed in the panel, replacing any previous contents.
 * @param {object} settings resolved settings
 * @param {string} value raw key
 * @returns {{configured: boolean, masked: string, source: string, path: string}} public state
 */
export function saveKey(settings, value) {
  const target = settings.apiKeyFile ?? defaultKeyPath()
  writeFileSync(target, value.trim(), { mode: 0o600 })
  return describeKey(settings)
}

/**
 * Remove the key this plugin owns, leaving other sources untouched.
 * @param {object} settings resolved settings
 * @returns {{configured: boolean, masked: string, source: string, path: string}} public state
 */
export function clearKey(settings) {
  const target = settings.apiKeyFile ?? defaultKeyPath()
  try {
    unlinkSync(target)
  } catch {
    /* already absent */
  }
  return describeKey(settings)
}

/**
 * Validate one typed key before it reaches the filesystem.
 * @param {unknown} value candidate
 * @returns {string | undefined} trimmed key, or undefined when invalid
 */
export function normalizeKey(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length < 8 || trimmed.length > 512) return undefined
  if (/[\r\n]/.test(trimmed) || /\s/.test(trimmed)) return undefined
  return trimmed
}
