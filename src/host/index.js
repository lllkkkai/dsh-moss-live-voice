/** Host half of the MOSS-Live voice bundle: WebSocket carrier plus DSH delegation runner. */

import { WebSocketServer } from 'ws'
import { resolveSettings } from './settings.js'
import { createDebugLog } from './debug.js'
import { createRunner } from './runner.js'
import { openBrowserSession } from './browser.js'
import { clearKey, describeKey, normalizeKey, saveKey } from './keys.js'
import { appendHistory, clearHistory, readHistory } from './history.js'

export const name = 'moss-live-voice'
export const inject = ['webServer', 'connection']

/** Path serving the browser voice carrier. */
const WS_PATH = '/moss-live/v1'

/** Path serving key management; works before any voice connection exists. */
const KEY_PATH = '/moss-live/key'

/** Path serving the durable transcript history. */
const HISTORY_PATH = '/moss-live/history'

/** Largest accepted key JSON body. */
const KEY_BODY_LIMIT = 8 * 1024

/**
 * Read and parse a small JSON request body.
 * @param {import('node:http').IncomingMessage} req request
 * @returns {Promise<Record<string, unknown>>} parsed body
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > KEY_BODY_LIMIT) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/**
 * Answer one key-management request.
 * @param {import('node:http').ServerResponse} res response
 * @param {number} status HTTP status
 * @param {Record<string, unknown>} body payload
 * @returns {void}
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * Mount the voice carrier: one authenticated WebSocket per browser tab.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @param {Record<string, unknown>} config loader row config
 * @returns {void}
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  const log = createDebugLog(settings.debugLog, ctx)
  const sockets = new Set()
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })

  const broadcast = (message) => {
    for (const send of sockets) send(message)
  }
  const run = createRunner(ctx, settings, log, (update) => {
    broadcast({ type: 'task', data: update })
  })

  ctx.effect(() => {
    const offKey = ctx.webServer.register({
      kind: 'exact',
      path: KEY_PATH,
      handler: async (req, res) => {
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection, { connection: 'close' })
          res.end()
          return
        }
        try {
          if (req.method === 'GET') {
            sendJson(res, 200, describeKey(settings))
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          const body = await readJson(req)
          if (body.action === 'clear') {
            sendJson(res, 200, clearKey(settings))
            log('key:cleared via http')
            return
          }
          const value = normalizeKey(body.key)
          if (value === undefined) {
            sendJson(res, 400, { ...describeKey(settings), error: '密钥格式不对（不能有空格或换行）' })
            return
          }
          sendJson(res, 200, saveKey(settings, value))
          log('key:saved via http')
        } catch (error) {
          log(`key:http-failed ${String(error)}`)
          sendJson(res, 500, { ...describeKey(settings), error: String(error?.message ?? error) })
        }
      },
    })
    const offHistory = ctx.webServer.register({
      kind: 'exact',
      path: HISTORY_PATH,
      handler: (req, res) => {
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection, { connection: 'close' })
          res.end()
          return
        }
        try {
          if (req.method === 'DELETE') {
            clearHistory(settings)
            log('history:cleared')
            sendJson(res, 200, { entries: [] })
            return
          }
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          const limit = Number(new URL(req.url ?? '/', 'http://local').searchParams.get('limit') ?? '80')
          sendJson(res, 200, { entries: readHistory(settings, limit) })
        } catch (error) {
          log(`history:failed ${String(error)}`)
          sendJson(res, 500, { entries: [], error: String(error?.message ?? error) })
        }
      },
    })
    const offUpgrade = ctx.webServer.registerUpgrade({      path: WS_PATH,
      handler: (req, socket, head) => {
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          log(`auth:rejected ${String(rejection)}`)
          socket.end(`HTTP/1.1 ${String(rejection)} Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
          return
        }
        wss.handleUpgrade(req, socket, head, (browser) => {
          log('ws:accepted')
          const session = openBrowserSession({ ctx, settings, log, run, browser })
          const send = (message) => {
            if (browser.readyState === browser.OPEN) browser.send(JSON.stringify(message))
          }
          sockets.add(send)
          browser.on('close', () => {
            sockets.delete(send)
            log('ws:closed')
            void session.close()
          })
          send({ type: 'status', data: { state: 'idle', upstream: settings.upstream, model: settings.model } })
        })
      },
    })
    return () => {
      offKey()
      offHistory()
      offUpgrade()
      for (const send of sockets) send({ type: 'status', data: { state: 'idle', message: '插件已卸载' } })
      sockets.clear()
      wss.close()
    }
  })

  if (settings.selfTest !== undefined) {
    const timer = setTimeout(() => {
      void runSelfTest(settings.selfTest)
    }, 5000)
    ctx.effect(() => () => clearTimeout(timer))
  }

  /**
   * Exercise the DSH delegation path without MOSS: one synthetic task.
   * Enabled by `config.selfTest` and used to verify the runner end to end.
   * @param {string} objective synthetic user request
   */
  async function runSelfTest(objective) {
    const controller = new AbortController()
    const task = {
      sessionId: 'moss-selftest',
      delegationId: `selftest-${String(Date.now())}`,
      objective,
      purpose: 'task',
      context: [],
    }
    log('selftest:start')
    try {
      const text = await run(task, {
        signal: controller.signal,
        limits: { maxProgressBytes: 600, maxResultChars: 2000 },
        reportProgress: (line, options) => {
          log(`selftest:progress${options?.spoken === true ? '(spoken)' : ''} ${line}`)
          return true
        },
      })
      log(`selftest:result ${text}`)
    } catch (error) {
      log(`selftest:failed ${String(error)}`)
    }
  }
}
