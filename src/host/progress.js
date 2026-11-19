/** Prompt construction and DSH progress-to-MOSS-progress mapping. */

/** Byte budget for one MOSS progress line (UTF-8); the protocol default is 600. */
const PROGRESS_BYTES = 600

/**
 * Trim a string to a UTF-8 byte budget without splitting a code point.
 * @param {string} text source text
 * @param {number} maxBytes byte budget
 * @returns {string} trimmed text
 */
export function clampBytes(text, maxBytes = PROGRESS_BYTES) {
  let out = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}

/**
 * Trim a string to a Unicode code point budget.
 * @param {string} text source text
 * @param {number} maxChars character budget
 * @returns {string} trimmed text
 */
export function clampChars(text, maxChars) {
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`
}

/**
 * Compose the task prompt handed to the DSH agent.
 * The spoken-summary contract lives here: the voice channel only plays a short
 * spoken answer, long artifacts must be written to files instead.
 * @param {import('./types.js').DelegationTask} task MOSS delegation task
 * @param {string} cwd task working directory
 * @returns {string} prompt text
 */
export function buildPrompt(task, cwd) {
  const context = task.context.length === 0
    ? '（无）'
    : task.context.map(line => `${line.role}: ${line.content}`).join('\n')
  const kind = task.purpose === 'reasoning' ? '需要多步推理、不需要改动文件' : '需要动手执行的任务'
  return [
    `你是 DSH 的语音助手后台执行器，现在收到用户的一句语音请求（${kind}）。`,
    '',
    `【用户请求】${task.objective}`,
    '',
    `【最近对话】`,
    context,
    '',
    `【工作目录】${cwd}`,
    '',
    '要求：',
    '1. 直接执行，不要反问用户（语音通道里用户正在听，无法阅读长选项）。信息不足时按最合理的假设继续，并在结论里说明假设。',
    '2. 你在后台执行，用户看不到屏幕。需要长时间操作时，用简短的一句话说明当前在做什么。',
    '3. 最终回答必须是**口语摘要**：2-4 句、不超过 800 字、不要 Markdown、不要表格、不要代码块、不要贴大段路径。',
    '4. 完整产物（报告、文件、日志）写入工作目录下的文件，口头结论里只说明结论和文件名。',
  ].join('\n')
}

/**
 * Map one tool call to a short spoken-friendly line.
 * @param {string} name tool name
 * @param {string} argsJson raw arguments JSON
 * @returns {string} one line
 */
export function toolLine(name, argsJson) {
  let brief = ''
  try {
    const parsed = JSON.parse(argsJson)
    const keys = ['path', 'file_path', 'command', 'query', 'url', 'pattern', 'objective', 'description']
    for (const key of keys) {
      const value = parsed?.[key]
      if (typeof value === 'string' && value.trim() !== '') {
        brief = value.trim()
        break
      }
    }
  } catch {
    brief = ''
  }
  const line = brief === '' ? name : `${name} ${brief}`
  return clampBytes(line, 160)
}

/**
 * Attach progress listeners for one agent turn.
 * MOSS distinguishes silent context (`thinking`) from spoken commentary
 * (`{spoken: true}`); high-frequency tool noise stays silent.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @param {object} agent agent whose session events are observed
 * @param {(text: string, options?: {spoken?: boolean}) => boolean} report MOSS progress sink
 * @param {(message: string) => void} log debug logger
 * @returns {() => void} detach
 */
export function attachProgress(ctx, agent, report, log) {
  const started = new Map()
  let lastSpoken = 0
  const offs = []
  const speak = (text, force) => {
    const now = Date.now()
    if (!force && now - lastSpoken < 20000) return
    lastSpoken = now
    try {
      report(clampBytes(text), { spoken: force })
    } catch (error) {
      log(`progress:rejected ${String(error)}`)
    }
  }
  try {
    offs.push(ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'tool/call') {
        started.set(String(event.data.callId), { name: event.data.name })
        try {
          report(clampBytes(`正在使用 ${toolLine(event.data.name, event.data.arguments)}`))
        } catch (error) {
          log(`progress:rejected ${String(error)}`)
        }
        return
      }
      if (event.type === 'tool/result') {
        const callId = String(event.data.message?.toolCallId ?? '')
        const name = started.get(callId)?.name ?? 'tool'
        started.delete(callId)
        const failed = event.data.error !== undefined || event.data.message?.isError === true
        if (failed) speak(`${name} 执行失败，正在换一种方式`, true)
        return
      }
      if (event.type === 'turn/end') {
        const kind = event.data.reason?.kind
        if (kind !== 'completed') speak(`这轮任务没有正常结束：${kind}`, true)
      }
    }))
  } catch (error) {
    log(`progress:attach-failed ${String(error)}`)
  }
  return () => {
    for (const off of offs) {
      try {
        off()
      } catch {
        /* listener already detached */
      }
    }
  }
}
