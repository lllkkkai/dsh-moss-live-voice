/** Minimal message constructor matching the DSH user-message contract. */

import { randomUUID } from 'node:crypto'

/**
 * Build the immutable-ish user message the Agent inbox accepts.
 * Mirrors `createUserMessage` from `@deepseek-ai/dsh-llm` without importing it,
 * because a linked third-party bundle cannot resolve DSH packages at runtime.
 * @param {string} text prompt text
 * @returns {{id: string, role: 'user', content: Array<{type: 'text', text: string}>, source: {kind: 'user'}}} message
 */
export function createUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}
