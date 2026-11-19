/** DSH-backed TaskRunner: one MOSS delegation becomes one DSH agent turn. */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from './messages.js'
import { attachProgress, buildPrompt, clampChars, clampBytes } from './progress.js'

/** Soft step budget: steer the agent toward a conclusion instead of running forever. */
const STEP_BUDGET = 30

/**
 * Resolve the dedicated voice workspace directory, creating it when absent.
 * @param {object} settings resolved plugin settings
 * @returns {string} absolute directory
 */
function voiceWorkspaceDir(settings) {
  const dir = settings.cwd ?? join(homedir(), 'dsh-projects', 'MOSS-Voice')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Read the last non-empty assistant text published after `firstSeq`.
 * @param {object} session DSH session
 * @param {number} firstSeq first seq owned by this task
 * @returns {string} final assistant text
 */
export function finalAssistantText(session, firstSeq) {
  let started = false
  let text = ''
  const length = session.seq
  for (let seq = firstSeq; seq < length; seq++) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = (event.data.message?.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined.trim() !== '') text = joined
    }
  }
  return text
}

/**
 * Wait until the agent turn and all its subagents have settled.
 * `whenIdle()` is agent-scoped, so the seq-stability double check is required.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @param {object} agent agent to settle
 * @returns {Promise<void>} settled
 */
async function settle(ctx, agent) {
  const subagents = ctx.get('subagents')
  for (;;) {
    await agent.whenIdle()
    const idleSeq = agent.session.seq
    const childrenActive = await subagents?.waitForChildren(agent)
    if (!childrenActive && agent.status === 'idle' && agent.session.seq === idleSeq) return
  }
}

/**
 * Build the runner handed to the MOSS delegation SDK.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @param {object} settings resolved settings
 * @param {(message: string) => void} log debug logger
 * @param {(update: {status: string, delegationId: string, title?: string}) => void} onTask task status sink
 * @returns {Function} TaskRunner
 */
export function createRunner(ctx, settings, log, onTask) {
  return async function run(task, { signal, reportProgress, limits }) {
    const agents = ctx.get('agents')
    if (agents === undefined) throw new Error('DSH agents service is unavailable')
    const dir = voiceWorkspaceDir(settings)
    const workspaceRegistry = ctx.get('workspaceRegistry')
    const workspace = workspaceRegistry === undefined ? undefined : await workspaceRegistry.create(dir)
    const presets = ctx.get('agentPresets')
    const preset = settings.preset ?? (presets === undefined ? undefined : (await presets.resolve(undefined)).id)
    const defaultModel = ctx.get('agentDefaultModel')?.currentSelection?.()
    const agentOptions = settings.modelSelection ?? (defaultModel === undefined
      ? {}
      : { provider: defaultModel.provider, model: defaultModel.model })
    const sessionId = `moss-${randomUUID()}`
    const title = clampBytes(task.objective, 60)
    onTask({ status: 'running', delegationId: task.delegationId, title })

    const handle = await ctx.get('agents').create({
      sessionId,
      meta: { cwd: workspace?.path ?? dir, ...(preset === undefined ? {} : { agentPreset: preset }) },
      agentOptions,
      setup: async (agentCtx) => {
        if (presets !== undefined && preset !== undefined) await presets.mount(agentCtx, preset)
      },
    })
    const agent = handle.agent
    const firstSeq = agent.session.seq
    try {
      if (workspace !== undefined) await workspace.attachSession(sessionId)
      ctx.get('sessionTitle')?.rename?.(agent.session, `语音：${title}`)
    } catch (error) {
      log(`session:post-create-failed ${String(error)}`)
    }

    const detach = attachProgress(ctx, agent, reportProgress, log)
    let steps = 0
    const stopCounting = ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'step/start') return
      steps += 1
      if (steps === STEP_BUDGET) {
        try {
          agent.steer(createUserMessage('已经调查很久了：请基于现有信息收敛，直接给出最终口语结论。'))
        } catch {
          /* steering is best effort */
        }
      }
    })
    const deadline = setTimeout(() => {
      log(`task:deadline ${task.delegationId}`)
      try {
        agent.cancel({ kind: 'user' })
      } catch {
        /* agent may already be idle */
      }
    }, settings.taskDeadlineMs)
    const onAbort = () => {
      log(`task:abort ${task.delegationId}`)
      try {
        agent.cancel({ kind: 'user' })
      } catch {
        /* agent may already be idle */
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      agent.followup(createUserMessage(buildPrompt(task, workspace?.path ?? dir)))
      await settle(ctx, agent)
      if (signal.aborted) throw new Error('delegation cancelled')
      const text = finalAssistantText(agent.session, firstSeq)
      const maxChars = limits?.maxResultChars ?? 2000
      const answer = text.trim() === '' ? '任务执行完了，但没有产出可播报的结论。' : text.trim()
      onTask({ status: 'completed', delegationId: task.delegationId, title })
      return clampChars(answer, Math.min(maxChars, 1200))
    } catch (error) {
      onTask({ status: 'failed', delegationId: task.delegationId, title })
      log(`task:failed ${task.delegationId} ${String(error)}`)
      throw error
    } finally {
      clearTimeout(deadline)
      signal.removeEventListener('abort', onAbort)
      stopCounting()
      detach()
      try {
        await handle.dispose()
      } catch (error) {
        log(`task:dispose-failed ${String(error)}`)
      }
    }
  }
}
