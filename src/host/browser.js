/** One browser voice connection: JSON control messages plus binary PCM relay. */

import { openUpstream, resolveApiKey } from './upstream.js'
import { clearKey, describeKey, normalizeKey, saveKey } from './keys.js'
import { appendHistory } from './history.js'
import { DEFAULT_INSTRUCTIONS } from './prompt.js'

/** Events that carry no browser-side meaning and must not be relayed. */
const INTERNAL_EVENTS = new Set([
  'session.delegation.created',
  'session.delegation.cancelled',
  'session.thinking.appended',
  'session.commentary.appended',
  'session.instructions.appended',
])

/**
 * Attach one browser socket to the plugin.
 * @param {object} options
 * @param {object} options.ctx plugin context
 * @param {object} options.settings resolved settings
 * @param {(message: string) => void} options.log debug logger
 * @param {Function} options.run DSH-backed TaskRunner
 * @param {import('ws').WebSocket} options.browser browser-side socket
 * @returns {{close: () => Promise<void>}} session handle
 */
export function openBrowserSession({ ctx, settings, log, run, browser }) {
  let upstream
  let starting
  /** Active carrier mode; `loopback` accepts media without any upstream socket. */
  let mode
  let frames = 0
  /** Correlation of the live MOSS session and the turns already stored. */
  let mossSessionId = ''
  let storedInputTurn = ''
  let storedOutputRun = ''

  const sendJson = (message) => {
    if (browser.readyState === browser.OPEN) browser.send(JSON.stringify(message))
  }
  const sendBinary = (data) => {
    if (browser.readyState === browser.OPEN) browser.send(data, { binary: true })
  }
  /**
   * Turn one uplink 16 kHz frame (tag byte + PCM16LE) into a 48 kHz PCM16LE
   * frame so the browser can play the echo at the right speed.
   * @param {Buffer} tagged tagged uplink frame
   * @returns {Buffer} 48 kHz PCM16LE
   */
  const echoFrame = (tagged) => {
    const pcm = tagged.subarray(1)
    const count = Math.floor(pcm.length / 2)
    const input = new Int16Array(count)
    for (let i = 0; i < count; i += 1) input[i] = pcm.readInt16LE(i * 2)
    const out = Buffer.alloc(count * 6)
    for (let i = 0; i < count; i += 1) {
      const a = input[i]
      const b = i + 1 < count ? input[i + 1] : a
      out.writeInt16LE(a, i * 6)
      out.writeInt16LE(Math.round((a * 2 + b) / 3), i * 6 + 2)
      out.writeInt16LE(Math.round((a + b * 2) / 3), i * 6 + 4)
    }
    return out
  }

  const status = (state, message) => {
    log(`status:${state}${message === undefined ? '' : ` ${message}`}`)
    sendJson({ type: 'status', data: { state, message, upstream: settings.upstream } })
  }

  async function start() {
    sendJson({ type: 'key', data: describeKey(settings) })
    if (upstream !== undefined || starting !== undefined) return
    // `upstream` is tri-state: undefined = auto (connect when a key is configured).
    const wantsUpstream = settings.upstream ?? (resolveApiKey(settings) !== undefined)
    if (!wantsUpstream) {
      if (!settings.loopbackAudio) {
        status('idle', '上游未启用（config.upstream=false），当前只验证本地通道')
        return
      }
      // Local audio smoke test: synthesize the two handshake events and echo PCM.
      mode = 'loopback'
      log('mode:loopback')
      status('live', '本地回环：未配置 MOSS 密钥，麦克风音频会直接回放')
      sendJson({ type: 'moss', data: { action: 'session_attached', data: { session_id: 'local-loopback' } } })
      sendJson({ type: 'moss', data: { action: 'session.updated', data: {} } })
      sendJson({ type: 'moss', data: { action: 'response.audio.started', data: { run_id: 'loopback', turn_id: 'loopback' } } })
      return
    }
    starting = (async () => {
      try {
        upstream = await openUpstream({
          settings,
          log,
          run,
          onStatus: status,
          onEvent: (frame, send) => {
            if (frame.action === 'session_attached') {
              if (typeof frame.data?.session_id === 'string') mossSessionId = frame.data.session_id
            }
            if (frame.action === 'input.transcript.done') {
              const turn = String(frame.data?.turn ?? '')
              const text = typeof frame.data?.text === 'string' ? frame.data.text : ''
              if (turn !== storedInputTurn && text.trim() !== '') {
                storedInputTurn = turn
                appendHistory(settings, { role: 'user', text, sessionId: mossSessionId })
              }
            }
            if (frame.action === 'output.transcript.done') {
              const run = String(frame.data?.run_id ?? '')
              const text = typeof frame.data?.text === 'string' ? frame.data.text : ''
              if (run !== storedOutputRun && text.trim() !== '') {
                storedOutputRun = run
                appendHistory(settings, { role: 'assistant', text, sessionId: mossSessionId })
              }
            }
            if (frame.action === 'session.delegation.created') {
              log(`delegation:created ${String(frame.data?.objective ?? '').slice(0, 120)}`)
            }
            if (frame.action === 'session.delegation.cancelled') log('delegation:cancelled')
            if (frame.action === 'input.transcript.done') log(`asr:done ${String(frame.data?.text ?? '')}`)
            if (frame.action === 'response.ended') log(`response:ended ${String(frame.data?.status ?? '')}`)
            if (frame.action === 'session_attached') {
              // The host owns session configuration: tagged PCM plus the persona.
              send({ action: 'media.mode', binary_protocol: 'tagged-v1' })
              send({
                action: 'session.update',
                session: { instructions: settings.instructions ?? DEFAULT_INSTRUCTIONS },
              })
            }
            if (INTERNAL_EVENTS.has(frame.action)) {
              if (frame.action === 'session.delegation.created') {
                sendJson({
                  type: 'task',
                  data: {
                    delegationId: frame.data?.delegation?.id,
                    status: 'queued',
                    title: frame.data?.objective,
                    purpose: frame.data?.purpose,
                  },
                })
              }
              return
            }
            sendJson({ type: 'moss', data: frame })
            if (frame.action === 'session_attached') status('live', '会话已建立')
          },
          onBinary: (data) => sendBinary(data),
        })
        mode = 'upstream'
        log('mode:upstream')
      } catch (error) {
        log(`upstream:failed ${String(error)}`)
        status('error', String(error?.message ?? error))
      } finally {
        starting = undefined
      }
    })()
    await starting
  }

  async function stop() {
    if (mode === 'loopback' && frames > 0) {
      sendJson({ type: 'moss', data: { action: 'response.audio.done', data: { run_id: 'loopback', turn_id: 'loopback' } } })
    }
    frames = 0
    const current = upstream
    upstream = undefined
    mode = undefined
    if (current !== undefined) await current.close()
    status('idle', '已停止')
  }

  browser.on('message', (raw, isBinary) => {
    if (isBinary) {
      if (upstream !== undefined) {
        upstream.socket.send(raw, { binary: true })
        return
      }
      if (mode === 'loopback') {
        frames += 1
        if (frames === 1 || frames % 50 === 0) log(`loopback:frame #${frames} ${raw.length}B`)
        // The client pairs every binary frame with one audio context, so the echo
        // must announce a chunk first; the payload is upsampled to 48 kHz.
        sendJson({
          type: 'moss',
          data: {
            action: 'response.audio.context',
            data: { chunk_id: `loopback-${String(frames)}`, run_id: 'loopback', turn_id: 'loopback', source: 'audio' },
          },
        })
        sendBinary(echoFrame(Buffer.isBuffer(raw) ? raw : Buffer.from(raw)))
      }
      return
    }
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch (error) {
      log(`browser:bad-json ${String(error)}`)
      return
    }
    if (message.action === 'ping') {
      sendJson({ type: 'pong', data: { time: Date.now() } })
      return
    }
    if (message.action === 'start') {
      void start()
      return
    }
    if (message.action === 'stop') {
      void stop()
      return
    }
    if (message.action === 'dshTask') {
      // Deterministic entry: hand one typed request straight to the DSH runner.
      const objective = typeof message.objective === 'string' ? message.objective.trim() : ''
      if (objective === '') return
      const delegationId = `manual-${String(Date.now())}`
      const title = objective.slice(0, 60)
      log(`manual:start ${title}`)
      sendJson({ type: 'task', data: { delegationId, status: 'running', title } })
      void run(
        { sessionId: 'moss-manual', delegationId, objective, purpose: 'task', context: [] },
        {
          signal: new AbortController().signal,
          limits: { maxProgressBytes: 600, maxResultChars: 2000 },
          reportProgress: (text) => {
            sendJson({ type: 'taskProgress', data: { delegationId, text } })
            return true
          },
        },
      ).then((text) => {
        log(`manual:done ${String(text).slice(0, 120)}`)
        sendJson({ type: 'task', data: { delegationId, status: 'completed', title } })
        sendJson({ type: 'taskResult', data: { delegationId, text } })
      }).catch((error) => {
        log(`manual:failed ${String(error)}`)
        sendJson({ type: 'task', data: { delegationId, status: 'failed', title } })
        sendJson({ type: 'taskResult', data: { delegationId, text: `任务失败：${String(error?.message ?? error)}` } })
      })
      return
    }
    if (message.action === 'keyStatus') {
      sendJson({ type: 'key', data: describeKey(settings) })
      return
    }
    if (message.action === 'setKey') {
      const value = normalizeKey(message.key)
      if (value === undefined) {
        sendJson({ type: 'key', data: { ...describeKey(settings), error: '密钥格式不对（不能有空格或换行）' } })
        return
      }
      try {
        saveKey(settings, value)
        log('key:saved source=panel')
        sendJson({ type: 'key', data: describeKey(settings) })
      } catch (error) {
        log(`key:save-failed ${String(error)}`)
        sendJson({ type: 'key', data: { ...describeKey(settings), error: '写入失败：' + String(error?.message ?? error) } })
      }
      return
    }
    if (message.action === 'clearKey') {
      try {
        clearKey(settings)
        log('key:cleared source=panel')
        sendJson({ type: 'key', data: describeKey(settings) })
      } catch (error) {
        log(`key:clear-failed ${String(error)}`)
        sendJson({ type: 'key', data: { ...describeKey(settings), error: '删除失败：' + String(error?.message ?? error) } })
      }
      return
    }
    if (message.action === 'moss') {
      if (upstream !== undefined) {
        upstream.send(message.data)
        return
      }
      if (mode === 'loopback') {
        log(`loopback:ignored ${String(message.data?.action)}`)
        return
      }
      status('error', '上游未连接，事件被丢弃')
      return
    }
    log(`browser:unknown-action ${String(message.action)}`)
  })

  return {
    async close() {
      await stop()
    },
  }
}
