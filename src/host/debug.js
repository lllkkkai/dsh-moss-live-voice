/** Append-only debug log used to verify plugin wiring without browser access. */

import { appendFileSync } from 'node:fs'

/**
 * Build the plugin's debug logger. When no path is configured the logger
 * writes through the Cordis logger only, so no files appear on disk.
 * @param {string | undefined} path target file, or undefined to disable the file
 * @param {import('@deepseek-ai/cordis').Context} [ctx] plugin context
 * @returns {(message: string) => void} logger
 */
export function createDebugLog(path, ctx) {
  const stamp = () => new Date().toISOString()
  return (message) => {
    const line = `[${stamp()}] ${message}`
    try {
      ctx?.logger?.info?.(line)
    } catch {
      /* logging must never break a voice session */
    }
    if (path === undefined) return
    try {
      appendFileSync(path, `${line}\n`)
    } catch {
      /* a failing debug file must not break the plugin */
    }
  }
}
