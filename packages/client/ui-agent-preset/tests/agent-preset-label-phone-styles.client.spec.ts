/**
 * AgentPresetLabel phone chip: the `@media (max-width: 560px)` block that hides
 * the preset label on phones. The glyph is identical for every preset and the
 * `title` attribute carries the preset description rather than its name, so a
 * capped chip showed neither the name nor a distinguishing mark while still
 * spending the phone header row's width. Every assertion is scoped to that
 * media body; the top-level rule scan used by the sibling style specs is
 * brace-blind and reports a `@media` prelude as if it were a selector over the
 * whole file.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/AgentPresetLabel.module.css', import.meta.url)),
  'utf8',
)

/** Prelude of the phone regime (spec: the label is hidden; the row spends its width on title, lineage, badge). */
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

const phone = mediaBody(PHONE_PRELUDE)

/**
 * Declarations of one exact selector inside the phone block.
 * @param selector - exact selector text.
 * @returns the normalized declarations.
 */
function phoneDeclarations(selector: string): Map<string, string> {
  expect(phone, `${PHONE_PRELUDE} is missing from AgentPresetLabel.module.css`).toBeDefined()
  const found = declarationsIn(phone as string, selector)
  expect(found, `${selector} is not declared inside ${PHONE_PRELUDE}`).toBeDefined()
  return found as Map<string, string>
}

describe('AgentPresetLabel.module.css phone chip', () => {
  it('declares the phone regime for viewports up to 560px', () => {
    expect(phone, `${PHONE_PRELUDE} is missing from AgentPresetLabel.module.css`).toBeDefined()
  })

  it('hides the preset label on phones', () => {
    const label = phoneDeclarations('.label')
    // A capped chip showed neither: the 14px glyph is identical for every
    // preset, and `.label`'s `title` carries the preset description rather than
    // the name, so the clipped remainder named nothing. Settings names the
    // preset; the new-session seat lists it too, with a label that ellipsizes
    // to its icon when space runs out.
    expect(label.get('display'),
      `.label must be display: none inside ${PHONE_PRELUDE}: its glyph is identical for every preset and `
      + 'its `title` carries the preset description rather than the name, so a capped box shows neither '
      + 'the preset nor a distinguishing mark while still spending the phone header row width')
      .toBe('none')
  })
})
