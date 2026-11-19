/** Upstream MOSS-Live realtime connection plus the delegation bridge. */

import WS from 'ws'
import { attachDelegation } from '@mossai/mosslive'
import { clampChars } from './progress.js'
import { defaultKeyPath, describeKey, saveKey, clearKey, normalizeKey, resolveApiKey, keySources } from './keys.js'

export { defaultKeyPath, describeKey, saveKey, clearKey, normalizeKey, resolveApiKey, keySources }

/**
 * Open one upstream realtime session.
 * @param {object} options
 * @param {object} options.settings resolved plugin settings
 * @param {(message: string) => void} options.log debug logger
 * @param {Function} options.run DSH-backed TaskRunner
 * @param {(frame: object) => void} options.onEvent JSON event from MOSS
 * @param {(data: Buffer) => void} options.onBinary audio frame from MOSS
 * @param {(state: string, message?: string) => void} options.onStatus status sink
 * @returns {Promise<{socket: import('ws').WebSocket, bridge: object, send: (frame: object) => void, close: () => Promise<void>}>} connection
 */
export async function openUpstream({ settings, log, run, onEvent, onBinary, onStatus }) {
  const apiKey = resolveApiKey(settings)
  if (apiKey === undefined) {
    throw new Error(`missing MOSS API key: set ${settings.apiKeyEnv}, ~/.dsh/moss-live.key, or config.apiKeyFile`)
  }
  const url = new URL(settings.url)
  url.searchParams.set('model', settings.model)
  if (settings.user !== undefined) url.searchParams.set('user', settings.user)

  const socket = new WS(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    handshakeTimeout: 15000,
    maxPayload: 16 * 1024 * 1024,
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
    socket.once('unexpected-response', (_request, response) => {
      reject(new Error(`upstream rejected the handshake: HTTP ${String(response.statusCode)}`))
    })
  })
  log('upstream:open')

  const send = (frame) => {
    if (socket.readyState !== WS.OPEN) return
    socket.send(JSON.stringify(frame))
  }

  const bridge = attachDelegation({
    socket,
    run,
    send,
    maxConcurrency: settings.maxConcurrency,
    executionTimeoutMs: settings.taskDeadlineMs + 60000,
    summarizeResult: async (result, _task, { maxChars }) => clampChars(result, maxChars),
    onError: (error) => {
      log(`bridge:error ${error.code}`)
      onStatus('error', `委派通道错误：${error.code}`)
    },
  })

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      onBinary(Buffer.isBuffer(data) ? data : Buffer.from(data))
      return
    }
    let frame
    try {
      frame = JSON.parse(data.toString())
    } catch (error) {
      log(`upstream:bad-json ${String(error)}`)
      return
    }
    try {
      bridge.handle(frame)
    } catch (error) {
      log(`bridge:handle-failed ${String(error)}`)
    }
    onEvent(frame, send)
  })
  socket.on('close', () => {
    log('upstream:closed')
    onStatus('idle', '上游连接已断开')
  })

  // The client-delegation session must be declared at attach time.
  send({ action: 'attach_session', memory_scope: 'session', delegation: { type: 'client' } })
  onStatus('connecting', '已连接上游，等待会话建立')

  return {
    socket,
    bridge,
    send,
    async close() {
      try {
        await bridge.close()
      } catch (error) {
        log(`bridge:close-failed ${String(error)}`)
      }
      try {
        socket.close()
      } catch {
        /* already closed */
      }
    },
  }
}
