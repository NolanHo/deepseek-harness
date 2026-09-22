/**
 * SubagentHeaderLineage phone chip: the `@media (max-width: 560px)` block that
 * replaces the localized descendant-count label with the bare count. In the
 * phone header row the full label ("32 subagents") truncates to "32 su…" and
 * spends the width the session title needs. Assertions are scoped to that media
 * body; the top-level rule scan used by the sibling style specs is brace-blind
 * and reports a `@media` prelude as if it were a selector over the whole file.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/SubagentHeaderLineage.module.css', import.meta.url)),
  'utf8',
)

/** Prelude of the phone regime (spec: the chip shows the descendant count alone). */
const PHONE_PRELUDE = '@media (max-width: 560px)'

/**
 * Body of one at-rule, located by its exact prelude and closed by brace balance.
 * @param prelude - exact at-rule prelude, e.g. `@media (max-width: 560px)`.
 * @returns the wrapped text, or undefined when the prelude is absent.
 */
function mediaBody(prelude: string): string | undefined {
  const start = css.indexOf(prelude)
  if (start === -1) return undefined
  const open = css.indexOf('{', start + prelude.length)
  if (open === -1) return undefined
  let depth = 0
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, index)
    }
  }
  return undefined
}

/**
 * Declarations of one exact selector inside a rule body, keyed by property.
 * @param body - the rule body text to scan, already scoped to the media block.
 * @param selector - exact selector text.
 * @returns the normalized declarations, or undefined when the selector is absent.
 */
function declarationsIn(body: string, selector: string): Map<string, string> | undefined {
  const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', rules = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const found = new Map<string, string>()
    for (const part of rules.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
    return found
  }
  return undefined
}

// Fork patch (FORK_SURFACE.md): the phone header renders the lineage chip's
// count alone.
describe('SubagentHeaderLineage.module.css phone chip', () => {
  it('declares the phone regime for viewports up to 560px', () => {
    expect(mediaBody(PHONE_PRELUDE),
      `${PHONE_PRELUDE} is missing from SubagentHeaderLineage.module.css`).toBeDefined()
  })

  it('drops the count label on phones and keeps the count alone', () => {
    const phone = mediaBody(PHONE_PRELUDE) as string
    expect(declarationsIn(phone, '.count')?.get('display'),
      '.count must not render in the phone row: the truncated label takes the session title’s width')
      .toBe('none')
    expect(declarationsIn(phone, '.countCompact')?.get('display'),
      '.countCompact must render in the phone row so the chip still shows the descendant count')
      .toBe('inline')
  })

  it('keeps the count-only span out of the desktop chip', () => {
    expect(declarationsIn(css, '.countCompact')?.get('display'),
      'the compact count is a phone presentation: the desktop chip keeps the full localized label')
      .toBe('none')
  })

  it('never hides the switcher title, which carries a subagent session’s own title', () => {
    const phone = mediaBody(PHONE_PRELUDE) as string
    expect(declarationsIn(phone, '.switcherTitle')?.get('display') ?? '',
      '.switcherTitle is the subagent session’s own title in the breadcrumbs; no phone rule may hide it')
      .not.toBe('none')
  })
})
