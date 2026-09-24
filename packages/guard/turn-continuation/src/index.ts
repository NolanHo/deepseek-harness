/**
 * Turn-end continuation policy: when a turn closes with a configured reason,
 * this plugin opens one more turn in the same session, spending a bounded
 * budget of consecutive continuations that only human input refills.
 * Configuration lives in the package README; the rationale lives in the
 * turn-continuation Agent Note.
 * @module @deepseek-ai/dsh-turn-continuation
 */

import type { Context } from '@deepseek-ai/cordis'
import { FiberState } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Attribution of the machine-authored turn this policy opened: readers
     * derive the message without this producer, and the refill check reads only
     * the core `user` kind, so an unknown kind changes no validation, replay,
     * or authority outcome, and the recorded JSON metadata survives reading.
     * @persistenceAttribution
     */
    'turn-continuation': { kind: 'turn-continuation' } & ContextFormed
  }
}

import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'

export const name = 'turn-continuation'

/** The agent registry resolves a `session/event`'s session back to its exact live Agent. */
export const inject = ['agents']

/**
 * Turn-end reasons a continuation may act on. `aborted` is excluded because a
 * cancellation is a human decision that another turn would defeat; `completed`
 * because the turn owed nothing; `blocked` and `interrupted` because neither
 * describes work the model left unfinished.
 */
const CONTINUABLE_REASONS = ['max-tokens', 'error'] as const

/** One continuable turn-end reason kind. */
type ContinuableReason = (typeof CONTINUABLE_REASONS)[number]

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: an unknown or
 * non-continuable `continueOn` entry, or a `maxConsecutive` that is not a
 * non-negative whole number, throws at plugin load).
 */
export interface Config {
  /**
   * Turn-end reason kinds that open another turn (default `['max-tokens']`).
   * An entry outside {@link CONTINUABLE_REASONS} throws at load rather than
   * silently continuing nothing.
   */
  continueOn?: string[]
  /**
   * Turns this plugin may open between two human inputs (default `2`).
   * `0` disables continuation without unmounting the plugin. The count is
   * refilled only by human-authored input, so an unattended session cannot
   * spend more than this budget per human turn.
   */
  maxConsecutive?: number
}

export const Config: z<Config> = z.object({
  continueOn: z.array(z.string()).default(['max-tokens']),
  maxConsecutive: z.number().default(2),
})

/**
 * The `{kind:'turn-continuation'}` producer source stamped on every
 * continuation this plugin queues — the label is load-bearing twice: a
 * transcript must never present an automatic continuation as human input, and
 * the budget refill reads `source.kind`, so this message must not refill the
 * budget it just spent.
 */
const CONTINUATION_SOURCE: MessageSource = { kind: 'turn-continuation' }

/** Prompt for a step cut off at the output-token ceiling. */
const TRUNCATION_PROMPT = 'Your previous reply was cut off because it reached the output-token '
  + 'limit, before it finished. Everything you already produced is preserved in this '
  + 'conversation. Continue the same task from exactly where it stopped: do not repeat output '
  + 'you already produced, and do not restart work that is already done. Finish the task, then '
  + 'stop normally.'

/** Prompt for a turn whose model request failed. */
const ERROR_PROMPT = 'Your previous attempt ended when its model request failed, so the turn did '
  + 'not finish. The conversation so far is preserved. Resume the same task: retry whatever '
  + 'failed, and if the same failure happens again, stop and report the concrete error instead '
  + 'of retrying the same call.'

/** Resolved, validated config with defaults applied once at plugin load. */
interface ResolvedConfig {
  readonly continueOn: ReadonlySet<ContinuableReason>
  readonly maxConsecutive: number
}

/**
 * Apply the schema defaults and reject a misconfiguration loudly.
 * @param config - the schema-validated plugin config.
 * @returns the resolved config.
 * @throws {Error} when a `continueOn` entry is not a continuable reason kind, or `maxConsecutive` is not a non-negative safe integer.
 */
function resolveConfig(config: Config): ResolvedConfig {
  const continueOn = config.continueOn ?? ['max-tokens']
  for (const kind of continueOn) {
    if (!(CONTINUABLE_REASONS as readonly string[]).includes(kind)) {
      throw new Error(
        `turn-continuation: continueOn entry "${kind}" is not a continuable turn-end reason; `
        + `expected one of ${CONTINUABLE_REASONS.join(', ')}`,
      )
    }
  }
  const maxConsecutive = config.maxConsecutive ?? 2
  if (!Number.isSafeInteger(maxConsecutive) || maxConsecutive < 0) {
    throw new Error(
      `turn-continuation: maxConsecutive (${String(maxConsecutive)}) must be a non-negative whole number of turns`,
    )
  }
  return { continueOn: new Set(continueOn as ContinuableReason[]), maxConsecutive }
}

/** The continuation prompt for one reason kind. */
function continuationPrompt(reason: ContinuableReason): string {
  return reason === 'max-tokens' ? TRUNCATION_PROMPT : ERROR_PROMPT
}

/**
 * Install the turn-end continuation policy.
 * @param ctx - host context; `agents` is required to resolve a Session back to its live Agent.
 * @param config - the schema-validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)

  // Turns this plugin opened per exact Agent since that Agent last consumed
  // human input. Keyed by the Agent, so a same-session replacement starts with
  // a full budget, and an unreferenced Agent is collected with its budget.
  const spent = new WeakMap<Agent, number>()

  // The reason of the most recent turn this process watched close, consumed by
  // the idle edge below. A turn/end observed inside a `session/event` callback
  // is never acted on there: the append reentrancy guard would reject the
  // enqueue and the contained-observer wrapper would swallow the throw.
  const pending = new WeakMap<Agent, TurnEndReason>()

  let stopping = false

  /**
   * Spend one continuation when the recorded turn end warrants it.
   * @param agent - the exact live agent whose turn just closed.
   */
  function consider(agent: Agent): void {
    // Liveness fences for an emit that outlived its listener registration: a
    // disposing fiber removes these listeners before it leaves ACTIVE, and the
    // loop's status emit always carries the registry's exact live agent.
    /* v8 ignore next -- unreachable: teardown removes this listener before the fiber leaves ACTIVE */
    if (stopping || ctx.fiber.state !== FiberState.ACTIVE) return
    /* v8 ignore next -- unreachable: the loop's status emit carries the registry's live agent */
    if (ctx.agents.get(agent.id) !== agent) return
    const reason = pending.get(agent)
    /* v8 ignore next -- unreachable while observing: this runs only on the idle edge that follows a recorded turn/end */
    if (reason === undefined) return
    if (!resolved.continueOn.has(reason.kind as ContinuableReason)) {
      pending.delete(agent)
      return
    }
    const spentTurns = spent.get(agent) ?? 0
    if (spentTurns >= resolved.maxConsecutive) {
      pending.delete(agent)
      ctx.logger.warn(
        `turn-continuation: agent "${agent.id}" ended its turn ${reason.kind} after `
        + `${spentTurns} automatic continuation(s); wait for human input before continuing again`,
      )
      return
    }
    const prompt = continuationPrompt(reason.kind as ContinuableReason)
    // Claim the true idle phase so a competing activity cannot start between the
    // readiness reads above and the enqueue below. A busy phase throws
    // synchronously: nothing is consumed and the next idle edge retries. The
    // task body itself is synchronous, so its promise settles before this frame
    // returns; the rejection handler exists for an enqueue that throws.
    try {
      agent.runMaintenance(() => {
        pending.delete(agent)
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: CONTINUATION_SOURCE,
        }))
        spent.set(agent, spentTurns + 1)
        return Promise.resolve()
      /* v8 ignore start -- unreachable: the task body returns a settled promise and creates a fresh message id */
      }).catch((error: unknown) => {
        ctx.logger.warn(
          `turn-continuation: agent "${agent.id}" could not queue a continuation: `
          + (error instanceof Error ? error.message : String(error)),
        )
      })
      /* v8 ignore stop */
    /* v8 ignore next -- unreachable: the idle edge runs while this agent's phase is already idle */
    } catch (error: unknown) {
      /* v8 ignore next 4 -- unreachable: the claim cannot be busy at the edge that triggered it */
      ctx.logger.warn(
        `turn-continuation: agent "${agent.id}" does not own its idle phase: `
        + (error instanceof Error ? error.message : String(error)),
      )
    }
  }

  ctx.effect(function* () {
    ctx.on('session/event', (session, event: SessionEvent) => {
      const agent = ctx.agents.get(session.id)
      /* v8 ignore next -- unreachable: a session/event emit always carries this registry's own session */
      if (agent === undefined || agent.session !== session) return
      if (event.type === 'turn/end') pending.set(agent, event.data.reason)
    })

    // Claiming is the point human input actually enters a step. A continuation
    // this plugin queued carries CONTINUATION_SOURCE and must not refill the
    // budget it just spent.
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (message.source.kind === 'user') spent.delete(agent)
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') consider(agent)
    })

    // Continuation authority is process-local by construction: a resumed
    // session has observed no turn-end here, and this reset drops the budget
    // and any reason recorded before the agent's creation edge. Creation
    // awaits its serial listeners before releasing queued input, so the reset
    // lands before the lifecycle can record a turn end.
    ctx.on('agent/created', ({ agent }) => {
      pending.delete(agent)
      spent.delete(agent)
    })

    yield () => {
      stopping = true
    }
  }, 'turn-continuation lifecycle')
}
