/** Validated runtime settings for the MOSS-Live voice plugin row. */

/** Default upstream realtime endpoint. */
const DEFAULT_URL = 'wss://api.mosi.cn/v1/realtime'

/** Default model id for the realtime session. */
const DEFAULT_MODEL = 'moss-live-1.0'

/**
 * Resolve the loader row config into explicit settings.
 * @param {Record<string, unknown>} config loader row config
 * @returns resolved settings
 */
export function resolveSettings(config) {
  const row = config ?? {}
  return {
    upstream: row.upstream === true ? true : row.upstream === false ? false : undefined,
    loopbackAudio: row.loopbackAudio === true,
    url: typeof row.url === 'string' && row.url !== '' ? row.url : DEFAULT_URL,
    model: typeof row.model === 'string' && row.model !== '' ? row.model : DEFAULT_MODEL,
    apiKeyEnv: typeof row.apiKeyEnv === 'string' && row.apiKeyEnv !== '' ? row.apiKeyEnv : 'MOSS_API_KEY',
    user: typeof row.user === 'string' && row.user !== '' ? row.user : undefined,
    cwd: typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : undefined,
    preset: typeof row.preset === 'string' && row.preset !== '' ? row.preset : undefined,
    modelSelection: row.modelSelection ?? undefined,
    maxConcurrency: positive(row.maxConcurrency, 1),
    taskDeadlineMs: positive(row.taskDeadlineMs, 540000),
    debugLog: typeof row.debugLog === 'string' ? row.debugLog : undefined,
    historyFile: typeof row.historyFile === 'string' && row.historyFile !== '' ? row.historyFile : undefined,
    selfTest: typeof row.selfTest === 'string' && row.selfTest.trim() !== '' ? row.selfTest : undefined,
    instructions: typeof row.instructions === 'string' && row.instructions.trim() !== '' ? row.instructions : undefined,
    apiKeyFile: typeof row.apiKeyFile === 'string' && row.apiKeyFile !== '' ? row.apiKeyFile : undefined,
  }
}

/**
 * Accept a positive integer or fall back.
 * @param {unknown} value candidate
 * @param {number} fallback default
 * @returns positive integer
 */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}
