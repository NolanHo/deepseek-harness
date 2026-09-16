/**
 * Fork-surface registration verifier.
 *
 * The fork's divergence contract lives in `FORK_SURFACE.md`: every patch to an
 * upstream-owned file carries a `// Fork patch (FORK_SURFACE.md): ...` marker and
 * every fork-owned module carries a `Fork-owned ... (see FORK_SURFACE.md)` marker,
 * and an inventory row in that file says how to re-apply it. A sync that reverts a
 * marker, or a fork change that lands without a row, is otherwise invisible until
 * the next conflict.
 *
 * Run: `npx tsx scripts/verify-fork-surface.ts` (`--json` for machine output,
 * `--update-baseline` to refreeze the accepted findings after reviewing them).
 *
 * Checks, all read-only:
 *  1. Marker census — tracked files under `packages/`, `apps/`, `vendor/` carrying
 *     one of the marker forms, with per-file counts.
 *  2. Registration coverage — every marked file must be reachable from a
 *     `## Current inventory` row: full path, path suffix, bare filename, or a
 *     distinctive module/file stem named beside the file's package.
 *  3. Reverse check — a tier C row that names a file must name one that still
 *     exists and still carries a marker; a vanished marker means the row's patch
 *     was probably rewritten away by an upstream sync.
 *  4. English/Chinese parity — `FORK_SURFACE.md` and `FORK_SURFACE.zh.md` must
 *     carry the same heading structure and the same inventory row count.
 *
 * Findings outside `scripts/fork-surface-baseline.txt` fail the run. That baseline
 * freezes the gaps accepted today (each entry carries its reason) so the check can
 * gate a sync from day one; it is the only file this script writes, and only when
 * `--update-baseline` is passed.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const surfaceFile = 'FORK_SURFACE.md'
const surfaceZhFile = 'FORK_SURFACE.zh.md'
const baselineFile = 'scripts/fork-surface-baseline.txt'
/** Roots the marker census walks; `git ls-files` already excludes untracked output. */
const scanRoots = ['packages', 'apps', 'vendor'] as const
/** Source-like extensions a row can name. Keeps CSS class paths (`StateDot.cell`) out. */
const sourceExtension = 'tsx?|mts|cts|jsx?|mjs|cjs|css|json|ya?ml|md|sh|py|sql|html|txt|patch'
/** A token that ends in one of those extensions, i.e. names a file. */
const namesAFile = new RegExp(`\\.(?:${sourceExtension})$`)
const markerPattern = /Fork patch \(FORK_SURFACE\.md\)|Fork-owned|\(see FORK_SURFACE\.md\)|\(FORK_SURFACE\.md\)/g
/** Marker families; a file reports the set it carries, the total counts occurrences. */
const markerFamilies: readonly (readonly [string, RegExp])[] = [
  ['fork-patch', /Fork patch \(FORK_SURFACE\.md\)/g],
  ['fork-owned', /Fork-owned/g],
  ['fork-ref', /\(see FORK_SURFACE\.md\)|\(FORK_SURFACE\.md\)/g],
]
/**
 * Stems too generic to identify a file on their own: they only count when the row
 * names the whole file (path suffix or bare filename) beside the file's package.
 */
const genericStems = new Set([
  'index', 'types', 'main', 'app', 'utils', 'store', 'stores', 'config', 'constants',
  'apply', 'boot', 'module', 'styles', 'readme', 'package', 'tsconfig',
  'client', 'server', 'service', 'session', 'contract', 'runtime', 'locales',
  'validation', 'columns', 'hub', 'facade', 'provider', 'helpers', 'options',
])
/** Prose kebab tokens that are not package names, so they never anchor a row. */
const nonPackageAnchors = new Set([
  'read-only', 'per-child', 'per-instance', 'non-member', 'one-liner', 'turn-aligned',
  're-apply', 'in-file', 'task-owned', 'fork-owned', 'up-to-date', 'long-lived',
])

interface MarkerRecord {
  file: string
  count: number
  families: string[]
}

interface InventoryRow {
  line: number
  tier: string
  tierC: boolean
  surface: string
  text: string
  needles: Set<string>
  /** Workspace package directory names the row names. */
  packages: Set<string>
  /** Module/file stems and component identifiers the row names. */
  stems: Set<string>
}

interface Coverage {
  row: number
  tier: string
  kind: string
  needle: string | null
}

interface Finding {
  id: string
  kind: 'unregistered' | 'unmarked' | 'lost'
  file: string
  markers: number
  row: number
  detail: string
}

interface Section {
  rows: number
  headings: number
  levels: number[]
}

interface Report {
  ok: boolean
  surface: Section
  surfaceZh: Section
  parityProblems: string[]
  markerFiles: number
  markerOccurrences: number
  markers: { file: string; count: number; families: string[]; coveredBy: Coverage[] }[]
  findings: Finding[]
  baselineEntries: number
  staleBaseline: string[]
  failures: string[]
}

/** Read a repository-relative file, or null when it is not readable as UTF-8 text. */
function readRepoFile(file: string): string | null {
  try {
    return readFileSync(resolve(root, file), 'utf8')
  } catch {
    return null
  }
}

/** Every tracked path, repository-rooted, NUL-split. */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
  return out.split('\0').filter(file => file.length > 0)
}

/** Exclusions shared by the census: built output and source maps, never sources. */
function scannable(file: string): boolean {
  if (/(^|\/)(lib|dist|node_modules)\//.test(file)) return false
  if (file.endsWith('.map')) return false
  if (/(^|\/)FORK_[A-Z_]*\.md$/.test(file)) return false
  return true
}

function scanMarkers(files: readonly string[]): MarkerRecord[] {
  const records: MarkerRecord[] = []
  for (const file of files) {
    const text = readRepoFile(file)
    if (text === null) continue
    markerPattern.lastIndex = 0
    const matches = text.match(markerPattern)
    if (matches === null) continue
    const families = markerFamilies.filter(([, pattern]) => {
      pattern.lastIndex = 0
      return pattern.test(text)
    }).map(([name]) => name)
    records.push({ file, count: matches.length, families })
  }
  return records
}

/** `packages/<group>/<pkg>/...`, `apps/<pkg>/...`, `vendor/<pkg>/...` -> package directory name. */
function packageDir(file: string): string | null {
  const segments = file.split('/')
  if (segments[0] === 'packages' && segments.length > 3) return segments[2] ?? null
  if ((segments[0] === 'apps' || segments[0] === 'vendor') && segments.length > 1) return segments[1] ?? null
  return null
}

function parentDir(file: string): string {
  return file.split('/').slice(-2)[0] ?? ''
}

function fileStem(file: string): string {
  const base = file.split('/').pop() ?? file
  return base.replace(/\.[^.]*$/, '').replace(/\.module$/, '')
}

function pathSuffixes(file: string): string[] {
  const segments = file.split('/')
  const out: string[] = []
  for (let index = 1; index < segments.length; index += 1) out.push(segments.slice(index).join('/'))
  return out
}

/** A token that reads as a repository path rather than prose or a symbol. */
function looksLikePath(token: string): boolean {
  if (!token.includes('/')) return false
  if (namesAFile.test(token)) return true
  if (/(^|\/)src\//.test(token)) return true
  return /^(?:packages|apps|vendor|scripts|tests|snapshots)\//.test(token)
}

/** What one inventory row names: file references, packages, and module stems. */
interface Vocabulary {
  needles: Set<string>
  packages: Set<string>
  stems: Set<string>
}

/** Collect the needles (candidate file references) and anchors of a row. */
function rowVocabulary(cells: readonly string[], packages: ReadonlySet<string>): Vocabulary {
  const needles = new Set<string>()
  const packageAnchors = new Set<string>()
  const stems = new Set<string>()
  // Only a real workspace package directory can gate a package match. Without this
  // filter, prose and event names (`per-child scope`, `agent/created`) would anchor
  // same-named packages and silently register unrelated files.
  const addPackage = (token: string): void => {
    if (packages.has(token)) packageAnchors.add(token)
  }
  const addPath = (token: string): void => {
    for (const segment of token.split('/')) addPackage(segment)
  }
  const addStem = (token: string): void => {
    if (token.length >= 5 && !genericStems.has(token.toLowerCase())) stems.add(token)
  }
  /** `File.class` / `File.tsx` / `File` -> the module stem the reference names. */
  const addReferenceStem = (token: string): void => {
    const last = token.split('/').pop() ?? token
    const beforeDot = last.replace(/\..*$/, '')
    if (beforeDot !== last) addStem(beforeDot.replace(/\.module$/, ''))
  }
  for (const cell of cells) {
    for (const match of cell.matchAll(/`([^`]+)`/g)) {
      const span = (match[1] ?? '').trim()
      if (span.length === 0 || /[\s()]/.test(span)) continue
      needles.add(span)
      if (looksLikePath(span)) addPath(span)
      else if (span.includes('/')) {
        // A two-segment span whose tail is a real package names that package
        // (`api/session-controller`); an event or error name does not
        // (`session/disposed`, `session/rewrite-unsupported`). Either way a
        // `Pkg/File.class` tail names the module stem.
        const segments = span.split('/')
        addPackage(segments[segments.length - 1] ?? '')
        addReferenceStem(span)
      } else if (/^[a-z0-9][a-z0-9-]*$/.test(span)) addPackage(span)
      if (namesAFile.test(span)) addReferenceStem(span)
      else addStem(span)
    }
    for (const match of cell.matchAll(new RegExp(`(?<![\\w\`./-])([\\w.@-]+/(?:${sourceExtension}))`, 'g'))) {
      const token = match[1] ?? ''
      needles.add(token)
      addPath(token)
    }
    for (const match of cell.matchAll(new RegExp(`(?<![\\w\`./-])([\\w-]+\\.(?:${sourceExtension}))`, 'g'))) {
      const token = match[1] ?? ''
      needles.add(token)
      addReferenceStem(token)
    }
    for (const match of cell.matchAll(/@deepseek-ai\/(?:dsh-)?([a-z0-9-]+)/g)) {
      const name = match[1] ?? ''
      addPackage(name)
      addPackage(`dsh-${name}`)
    }
    for (const match of cell.matchAll(/(?<![\w-])([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?![\w-])/g)) {
      const token = match[1] ?? ''
      if (nonPackageAnchors.has(token)) continue
      addPackage(token)
      addStem(token)
    }
    // Component and module identifiers named in prose (`AppFrame`, `WorkspaceBrowser`)
    // identify a file's stem as clearly as a backticked one does.
    for (const match of cell.matchAll(/(?<![\w$])([A-Z][A-Za-z0-9]{5,})(?![\w$])/g)) addStem(match[1] ?? '')
  }
  return { needles, packages: packageAnchors, stems }
}

/** Inventory data rows of a surface file: the table after the `## Current inventory` heading. */
function inventoryRows(text: string, heading: RegExp, packages: ReadonlySet<string>): InventoryRow[] {
  const lines = text.split('\n')
  let start = -1
  let end = lines.length
  lines.forEach((line, index) => {
    if (start < 0 && heading.test(line)) start = index
    else if (start >= 0 && index > start && /^## /.test(line)) end = Math.min(end, index)
  })
  if (start < 0) return []
  const rows: InventoryRow[] = []
  let headerSeen = false
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index] ?? ''
    if (!line.trim().startsWith('|')) continue
    if (!headerSeen) {
      headerSeen = true
      continue
    }
    if (/^\|[\s:|-]+\|$/.test(line.trim())) continue
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    const surface = cells[0] ?? ''
    const tier = cells[1] ?? ''
    if (surface.length === 0) continue
    const vocabulary = rowVocabulary(cells, packages)
    rows.push({
      line: index + 1,
      tier,
      tierC: /^C\b/.test(tier),
      surface,
      text: cells.join(' '),
      needles: vocabulary.needles,
      packages: vocabulary.packages,
      stems: vocabulary.stems,
    })
  }
  return rows
}

/** Heading structure of a surface file, as level sequence (translated titles may differ). */
function headingLevels(text: string): number[] {
  const levels: number[] = []
  for (const line of text.split('\n')) {
    const match = /^(#+)\s/.exec(line)
    if (match) levels.push((match[1] ?? '').length)
  }
  return levels
}

/**
 * Whether one inventory row registers one marked file.
 *
 * `exact` needs the full path; `suffix` needs a path-qualified reference (three
 * segments always, two when the row also names the file's package); `name` needs
 * the bare filename beside the package; `stem` accepts a distinctive module stem
 * or component identifier named beside the package (or its parent directory).
 */
function coverage(row: InventoryRow, file: string): Coverage | null {
  const hit = (kind: string, needle: string | null = null): Coverage => ({ row: row.line, tier: row.tier, kind, needle })
  if (row.text.includes(file)) return hit('exact', file)
  const pkg = packageDir(file)
  const pkgNamed = pkg !== null && row.packages.has(pkg)
  const suffixes = new Set(pathSuffixes(file))
  const base = file.split('/').pop() ?? file
  for (const needle of row.needles) {
    if (needle === file) return hit('exact', file)
    const segments = needle.split('/').length
    if (segments >= 2 && suffixes.has(needle) && (segments >= 3 || pkgNamed)) return hit('suffix', needle)
    if (needle === base && pkgNamed) return hit('name', needle)
  }
  const stem = fileStem(file)
  if (stem.length >= 5 && !genericStems.has(stem)) {
    const parent = parentDir(file)
    if (row.stems.has(stem) && (pkgNamed || (parent !== 'src' && row.stems.has(parent)))) return hit('stem', stem)
  }
  return null
}

/** Parse the frozen-gap baseline: `id  # reason` lines, `#` comments, blank lines. */
function parseBaseline(text: string): { ids: Set<string>; reasons: Map<string, string> } {
  const ids = new Set<string>()
  const reasons = new Map<string, string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const comment = trimmed.indexOf('#')
    const id = (comment >= 0 ? trimmed.slice(0, comment) : trimmed).trim()
    if (id.length === 0) continue
    ids.add(id)
    const reason = comment >= 0 ? trimmed.slice(comment + 1).trim() : ''
    if (reason.length > 0) reasons.set(id, reason)
  }
  return { ids, reasons }
}

function section(text: string, heading: RegExp, packages: ReadonlySet<string>): Section {
  const levels = headingLevels(text)
  return { rows: inventoryRows(text, heading, packages).length, headings: levels.length, levels }
}

/** Run the verifier; `argv` mirrors the CLI (`--json`, `--update-baseline`). */
export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const json = argv.includes('--json')
  const updateBaseline = argv.includes('--update-baseline')
  const surfaceText = readRepoFile(surfaceFile)
  const surfaceZhText = readRepoFile(surfaceZhFile)
  // A missing baseline is an empty one: every finding then fails the run, which is
  // the honest state for a checkout that never froze its accepted gaps.
  const baselineText = readRepoFile(baselineFile) ?? ''
  if (surfaceText === null || surfaceZhText === null) {
    const missing = [surfaceText === null ? surfaceFile : null, surfaceZhText === null ? surfaceZhFile : null]
      .filter((file): file is string => file !== null)
    console.error(`verify-fork-surface: cannot read ${missing.join(', ')}`)
    process.exitCode = 1
    return
  }

  const tracked = trackedFiles()
  const packageNames = new Set<string>()
  for (const file of tracked) {
    const pkg = packageDir(file)
    if (pkg !== null) packageNames.add(pkg)
  }
  const inventory = inventoryRows(surfaceText, /^## Current inventory/, packageNames)
  const surfaceSection = section(surfaceText, /^## Current inventory/, packageNames)
  const surfaceZhSection = section(surfaceZhText, /^## Current inventory|^## 当前清单/, packageNames)

  const parityProblems: string[] = []
  if (surfaceSection.rows !== surfaceZhSection.rows) {
    parityProblems.push(`inventory rows: ${surfaceFile} has ${surfaceSection.rows}, ${surfaceZhFile} has ${surfaceZhSection.rows}`)
  }
  if (surfaceSection.headings !== surfaceZhSection.headings) {
    parityProblems.push(`headings: ${surfaceFile} has ${surfaceSection.headings}, ${surfaceZhFile} has ${surfaceZhSection.headings}`)
  }
  const levels = surfaceSection.levels.join(',')
  const levelsZh = surfaceZhSection.levels.join(',')
  if (levels !== levelsZh) {
    parityProblems.push(`heading levels: ${surfaceFile} has [${levels}], ${surfaceZhFile} has [${levelsZh}]`)
  }

  const censusFiles = tracked.filter(file => scannable(file) && scanRoots.some(scanRoot => file.startsWith(`${scanRoot}/`)))
  const markers = scanMarkers(censusFiles)
  const markerByFile = new Map(markers.map(record => [record.file, record]))
  const baseline = parseBaseline(baselineText)

  const findings: Finding[] = []
  const marked = markers.map((record) => {
    const coveredBy: Coverage[] = []
    for (const row of inventory) {
      const match = coverage(row, record.file)
      if (match !== null) coveredBy.push(match)
    }
    if (coveredBy.length === 0) {
      findings.push({
        id: `unregistered:${record.file}`,
        kind: 'unregistered',
        file: record.file,
        markers: record.count,
        row: 0,
        detail: 'carries a fork marker but no inventory row registers it',
      })
    }
    return { file: record.file, count: record.count, families: record.families, coveredBy }
  })

  // Reverse check: every file a tier C row names must exist and keep a marker.
  const filesBySuffix = new Map<string, string[]>()
  const filesByBasename = new Map<string, string[]>()
  for (const file of tracked) {
    const base = file.split('/').pop() ?? file
    const baseList = filesByBasename.get(base)
    if (baseList === undefined) filesByBasename.set(base, [file])
    else baseList.push(file)
    for (const suffix of [file, ...pathSuffixes(file)]) {
      const list = filesBySuffix.get(suffix)
      if (list === undefined) filesBySuffix.set(suffix, [file])
      else list.push(file)
    }
  }
  const markerCountOf = (file: string): number => markerByFile.get(file)?.count ?? 0
  const reverseSeen = new Set<string>()
  let namedReferences = 0
  for (const row of inventory) {
    if (!row.tierC) continue
    for (const needle of row.needles) {
      if (!namesAFile.test(needle)) continue
      const segments = needle.split('/')
      const base = segments[segments.length - 1] ?? needle
      let candidates: string[]
      if (segments.length >= 3) candidates = filesBySuffix.get(needle) ?? []
      else if (segments.length === 2) {
        candidates = (filesBySuffix.get(needle) ?? []).filter((file) => {
          const pkg = packageDir(file)
          return pkg !== null && row.packages.has(pkg)
        })
      } else {
        candidates = (filesByBasename.get(needle) ?? []).filter((file) => {
          const pkg = packageDir(file)
          return pkg !== null && row.packages.has(pkg)
        })
      }
      if (candidates.length === 0) {
        if (segments.length >= 2) {
          const id = `lost:${needle}`
          if (!reverseSeen.has(id)) {
            reverseSeen.add(id)
            const detail = existsSync(resolve(root, needle))
              ? 'row names a path that exists but is not tracked'
              : 'row names a path no tracked file matches'
            findings.push({ id, kind: 'lost', file: needle, markers: 0, row: row.line, detail })
          }
        }
        continue
      }
      namedReferences += candidates.length
      if (candidates.some(file => markerCountOf(file) > 0)) continue
      for (const file of candidates) {
        const id = `unmarked:${file}`
        if (reverseSeen.has(id)) continue
        reverseSeen.add(id)
        findings.push({
          id,
          kind: 'unmarked',
          file,
          markers: 0,
          row: row.line,
          detail: `row names it (\`${base}\`) but it carries no fork marker`,
        })
      }
    }
  }
  const failures = findings.filter(finding => !baseline.ids.has(finding.id)).map(finding => finding.id)
  const staleBaseline = [...baseline.ids].filter(id => !findings.some(finding => finding.id === id))
  const ok = failures.length === 0 && parityProblems.length === 0

  const report: Report = {
    ok,
    surface: surfaceSection,
    surfaceZh: surfaceZhSection,
    parityProblems,
    markerFiles: markers.length,
    markerOccurrences: markers.reduce((total, record) => total + record.count, 0),
    markers: marked,
    findings,
    baselineEntries: baseline.ids.size,
    staleBaseline,
    failures,
  }

  if (updateBaseline) {
    const reasons = baseline.reasons
    const entry = (id: string): string => {
      const reason = reasons.get(id) ?? 'TODO: state why this is allowed'
      return `${id}  # ${reason}`
    }
    const ids = [...new Set([...findings.map(finding => finding.id), ...baseline.ids])].sort()
    const groups: readonly (readonly [string, (id: string) => boolean])[] = [
      ['Marked files no inventory row registers', id => id.startsWith('unregistered:')],
      ['Tier C rows naming a file that carries no marker', id => id.startsWith('unmarked:')],
      ['Tier C rows naming a path no tracked file matches', id => id.startsWith('lost:')],
    ]
    const lines = [
      '# Fork surface baseline — frozen findings for scripts/verify-fork-surface.ts.',
      '#',
      '# Every line freezes one finding the checker reports today, so the runbook step can',
      '# gate syncs before the backlog is cleared. Format:',
      '#',
      '#   <finding-id>  # <why this finding is allowed to stay>',
      '#',
      '# Ids: unregistered:<path> (marked file no inventory row registers),',
      '#      unmarked:<path>     (tier C row names the file, the file has no marker),',
      '#      lost:<path>         (tier C row names a path no tracked file matches).',
      '#',
      '# `real gap` entries are registration or marker debt: the file carries fork work',
      '# that FORK_SURFACE.md does not point at, or points at without a marker in the',
      '# file. `matcher` entries are rows that register the surface by role, package or',
      '# context instead of by a path the checker recognises — accepted, not debt.',
      '# Remove an entry once the gap is really closed: a stale entry only warns, it never',
      '# fails the run. Regenerate with `--update-baseline` after reviewing the printed',
      '# findings, and keep the reasons.',
      '',
    ]
    for (const [title, matches] of groups) {
      const group = ids.filter(matches)
      if (group.length === 0) continue
      lines.push(`# --- ${title} (${group.length}) ---`, ...group.map(entry), '')
    }
    writeFileSync(resolve(root, baselineFile), lines.join('\n'), 'utf8')
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2))
    if (!ok) process.exitCode = 1
    return
  }

  const baselined = new Set(findings.filter(finding => baseline.ids.has(finding.id)).map(finding => finding.id))
  console.log('Fork surface verifier — FORK_SURFACE.md registration coverage')
  console.log('')
  for (const problem of parityProblems) console.log(`parity FAIL  ${problem}`)
  if (parityProblems.length === 0) {
    const sections = `${surfaceFile} ${surfaceSection.rows} rows / ${surfaceSection.headings} headings`
    const sectionsZh = `${surfaceZhFile} ${surfaceZhSection.rows} rows / ${surfaceZhSection.headings} headings`
    console.log(`parity       OK — ${sections}, ${sectionsZh}`)
  }
  const roots = scanRoots.join('/, ')
  console.log(`markers      ${markers.length} tracked files carry ${report.markerOccurrences} markers`)
  console.log(`             scan: ${roots}/, excluding lib/ dist/ *.map`)
  console.log('')
  console.log('marked files')
  for (const record of marked) {
    const rows = record.coveredBy.map(match => match.row).join(',')
    const state = record.coveredBy.length > 0 ? `row ${rows}` : 'GAP'
    const families = record.families.join('+')
    console.log(`  ${String(record.count).padStart(3)}  ${state.padEnd(12)} ${record.file}  [${families}]`)
  }
  console.log('')
  const gaps = findings.filter(finding => finding.kind === 'unregistered')
  const gapsFrozen = gaps.every(gap => baselined.has(gap.id)) ? ' (all baselined)' : ''
  console.log(`registration ${marked.length - gaps.length}/${marked.length} marked files registered; ${gaps.length} gap(s)${gapsFrozen}`)
  const reverse = findings.filter(finding => finding.kind !== 'unregistered')
  const reverseFrozen = reverse.every(finding => baselined.has(finding.id)) ? ' (all baselined)' : ''
  console.log(`reverse      ${namedReferences} file reference(s) in tier C rows; ${reverse.length} finding(s)${reverseFrozen}`)
  for (const finding of reverse) {
    console.log(`  ${finding.kind.padEnd(9)} row ${String(finding.row).padEnd(4)} ${finding.file}  (${finding.detail})`)
  }
  console.log('')
  console.log(`baseline     ${baselineFile}: ${baseline.ids.size} entr(ies), ${staleBaseline.length} stale`)
  for (const id of staleBaseline) console.log(`  stale  ${id}`)
  console.log('')
  if (ok) {
    console.log(`OK — no findings outside the baseline${findings.length > 0 ? ` (${findings.length} baselined)` : ''}`)
  } else {
    console.log(`FAIL — ${failures.length} finding(s) outside the baseline`)
    for (const finding of findings.filter(entry => failures.includes(entry.id))) {
      console.log(`  ${finding.kind.padEnd(13)} ${finding.file}  (${finding.detail}${finding.row > 0 ? `, row ${finding.row}` : ''})`)
    }
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
