// Xcode Companion — what the band shows and offers, as pure functions of its state.
//
// register.tsx reads the state and draws; everything that decides which
// controls exist in which situation lives here, so the rules are in one place
// and testable without an engine.

import type { Activity, ActivityKind, Actor, Destination, Elsewhere, Launched, Outcome, RunPhase, Setup, XcodeRun } from '../types'

// ── Reading Xcode's MCP answers ─────────────────────────────────────────────

export type Answer = { json: Record<string, unknown> | null; text: string; isError: boolean; isHeld?: true }

// An MCP result (or a tool.call result carrying one) as text plus its JSON.
export const readAnswer = (result: unknown, isError = false): Answer => {
  const texts: string[] = []
  let structured: Record<string, unknown> | null = null
  const visit = (v: unknown) => {
    if (typeof v === 'string') texts.push(v)
    else if (Array.isArray(v)) v.forEach(visit)
    else if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (o.type === 'text' && typeof o.text === 'string') texts.push(o.text)
      else if (Array.isArray(o.content)) {
        o.content.forEach(visit)
        if (o.isError === true) isError = true
        if (o.structuredContent && typeof o.structuredContent === 'object') {
          structured = o.structuredContent as Record<string, unknown>
        }
      } else structured ??= o
    }
  }
  visit(result)
  const text = texts.join('\n')
  let json = structured as Record<string, unknown> | null
  if (json === null) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        json = parsed as Record<string, unknown>
      }
    } catch {
      json = null
    }
  }
  // Xcode reports some refusals as `{"type":"error","data":"..."}`.
  if (json?.type === 'error') isError = true

  return { json, text, isError }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

// What a refused call says, in one sentence.
export const errorText = (a: Answer): string => {
  const said = str(a.json?.data) ?? str(a.json?.message) ?? a.text
  const line = said.replace(/^Error Domain=\S+ Code=\d+ "/, '').split('\n')[0] ?? ''

  return line.length > 220 ? `${line.slice(0, 219)}…` : line
}

export const isApprovalRefusal = (a: Answer): boolean => /approv/i.test(a.text)

// The desktop app's auto mode sends a mod's own `$.mcp.call` to its
// classifier, which refuses it for want of a request of the model's; the
// terminal skips the classifier for it, as the plugin API says it should.
export const isAutoModeRefusal = (text: string): boolean => /auto mode classifier/i.test(text)

export const DESKTOP_BUG_URL = 'https://github.com/anthropics/claude-code/issues/101884'

export const isPermissionRefusal = (a: Answer): boolean =>
  /not (enabled|allowed)|turned off|disabled/i.test(a.text) && !isApprovalRefusal(a)

export type OpenWorkspace = { id: string; path: string }

// XcodeListWorkspaces answers lines of `* workspaceIdentifier: …, workspacePath: …`.
export const parseWorkspaces = (a: Answer): OpenWorkspace[] => {
  const found: OpenWorkspace[] = []
  const list = a.json?.workspaces
  if (Array.isArray(list)) {
    for (const w of list as Record<string, unknown>[]) {
      const id = str(w.workspaceIdentifier) ?? str(w.identifier)
      const path = str(w.workspacePath) ?? str(w.path)
      if (id && path) found.push({ id, path })
    }
  }
  const text = str(a.json?.message) ?? a.text
  for (const m of text.matchAll(/workspaceIdentifier:\s*([^,\s]+),\s*workspacePath:\s*([^\n]+)/g)) {
    const id = m[1]
    const path = m[2]?.trim()
    if (id && path && !found.some(w => w.id === id)) found.push({ id, path })
  }

  return found
}

// Of the workspaces Xcode has open for one project, the one to act on: the
// app's window (`windowtab-…`) when the app has it open, so what the band does
// is what the person sees in Xcode; else the headless server's.
export const pickWorkspace = (open: readonly OpenWorkspace[]): OpenWorkspace | undefined =>
  open.find(w => w.id.startsWith('windowtab-')) ?? open[0]

export type Launch = { pid: number | null; isRunning: boolean }

// GetConsoleOutput's `launchSessionInfo`: `Launch Session: X, ref: …, PID: 2601, State: running`.
export const parseLaunch = (a: Answer): Launch | null => {
  if (a.isError) return null
  const info = str(a.json?.launchSessionInfo) ?? ''
  const m = /PID:\s*(\d+)\s*,\s*State:\s*(\w+)/i.exec(info)
  if (m === null) return null
  return { pid: Number(m[1]), isRunning: m[2]?.toLowerCase() === 'running' }
}

export type Destinations = { list: Destination[]; active: string | null; scheme: string | null }

// XcodeListRunDestinations: the runnable ones, devices first, as Xcode groups them.
export const parseDestinations = (a: Answer): Destinations => {
  const raw = Array.isArray(a.json?.destinations) ? (a.json.destinations as Record<string, unknown>[]) : []
  const list: Destination[] = []
  const rank = new Map<string, number>()
  for (const d of raw) {
    const title = str(d.displayTitle)
    if (!title || d.isEligible === false || d.isGenericDevice === true) continue
    if (d.group !== 'Devices' && d.group !== 'Simulators') continue
    list.push({ title, isSimulator: d.isSimulator === true, os: str(d.osVersion) })
    rank.set(title, d.isSimulator === true ? 1 : /macosx/.test(String(d.platformIdentifier)) ? 2 : 0)
  }
  // A connected device first, then the simulators, the Mac last.
  list.sort((x, y) => (rank.get(x.title) ?? 1) - (rank.get(y.title) ?? 1))

  return { list, active: str(a.json?.activeDestinationDisplayTitle), scheme: str(a.json?.activeSchemeName) }
}

export const activeOf = (a: Answer): string | null => str(a.json?.activeDestinationDisplayTitle)

// ── Recognising builds ──────────────────────────────────────────────────────

const XCODE_TOOLS: Record<string, ActivityKind | 'switch'> = {
  BuildProject: 'build',
  RunProject: 'run',
  RunAllTests: 'test',
  RunSomeTests: 'test',
  StopProject: 'stop',
  XcodeSwitchRunDestination: 'switch',
  XcodeSwitchScheme: 'switch',
  XcodeSwitchTestPlan: 'switch',
}

export type XcodeTool = { server: string; name: string; kind: ActivityKind | 'switch' | null }

// `mcp__xcode__BuildProject`: the model's calls on Xcode's MCP server, under
// whatever name the person registered it (never this plugin's own tools).
export const xcodeTool = (tool: string): XcodeTool | null => {
  const m = /^mcp__(.+)__([A-Za-z]+)$/.exec(tool)
  if (!m?.[1] || !m[2]) return null
  const server = m[1]
  // Not XcodeBuildMCP's tools, and not the band's own (`mcp__xcode-companion__band_state`);
  // the server this plugin ships is (`mcp__plugin_xcode-companion_xcode__BuildProject`).
  if (!/xcode/i.test(server) || /xcodebuildmcp/i.test(server) || server === 'xcode-companion') return null

  return { server, name: m[2], kind: XCODE_TOOLS[m[2]] ?? null }
}

// A Bash command that runs xcodebuild to build or test (not to list or ask).
export const shellBuild = (command: string): ActivityKind | null => {
  if (!/(^|[\s;&|(])xcodebuild(\s|$)/.test(command)) return null
  if (/\s-(list|version|showsdks|showBuildSettings|showdestinations|showTestPlans|help)\b/.test(command)) return null

  return /\s(test|test-without-building)\b/.test(command) ? 'test' : 'build'
}

// ── Outcomes ────────────────────────────────────────────────────────────────

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

// The errors of a build: BuildProject answers `errors`, RunProject
// `buildErrors`; each a message, or an object carrying one and its place.
const issuesOf = (a: Answer): string[] => {
  const seen = new Set<string>()
  for (const key of ['errors', 'buildErrors']) {
    const list = a.json?.[key]
    if (!Array.isArray(list)) continue
    for (const e of list as unknown[]) {
      if (typeof e === 'string' && e !== '') {
        seen.add(e)
        continue
      }
      if (e === null || typeof e !== 'object') continue
      const o = e as Record<string, unknown>
      const msg = str(o.message) ?? str(o.description) ?? str(o.text)
      const file = str(o.filePath) ?? str(o.file) ?? str(o.path)
      const line = typeof o.lineNumber === 'number' ? o.lineNumber : typeof o.line === 'number' ? o.line : null
      if (msg) seen.add(file ? `${file.split('/').pop()}${line !== null ? `:${line}` : ''}: ${msg}` : msg)
    }
  }

  return [...seen]
}

// A verdict sentence that reports a failure (`The build failed`, `Could not launch …`).
const isFailure = (verdict: string): boolean => /fail|error|could not|couldn't|unable|not launched|cancel/i.test(verdict)

// Counts somewhere in a test result: the first numeric field whose name matches.
const countOf = (v: unknown, name: RegExp, depth = 0): number | null => {
  if (depth > 4 || v === null || typeof v !== 'object') return null
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (name.test(k) && typeof x === 'number') return x
  }
  for (const x of Object.values(v as Record<string, unknown>)) {
    const n = countOf(x, name, depth + 1)
    if (n !== null) return n
  }

  return null
}

const failedTests = (v: unknown, out: string[] = [], depth = 0): string[] => {
  if (depth > 5 || v === null || typeof v !== 'object' || out.length >= 8) return out
  if (Array.isArray(v)) {
    for (const x of v) failedTests(x, out, depth + 1)
    return out
  }
  const o = v as Record<string, unknown>
  const id = str(o.testIdentifier) ?? str(o.identifier) ?? str(o.name)
  const status = str(o.status) ?? str(o.result)
  if (id && status && /fail/i.test(status)) {
    const why = str(o.failureMessage) ?? str(o.message)
    out.push(why ? `${id}: ${why}` : id)
  }
  for (const x of Object.values(o)) failedTests(x, out, depth + 1)

  return out
}

export const outcomeOf = (
  kind: ActivityKind,
  by: Actor,
  a: Answer,
  destination: string | null,
  atMs: number,
  durationMs: number | null,
): Outcome => {
  const base = { kind, by, destination, atMs, durationMs }
  const verdict = str(a.json?.buildResult) ?? str(a.json?.runResult) ?? str(a.json?.testResult) ?? str(a.json?.result) ?? ''
  if (kind === 'test') {
    const failed = countOf(a.json, /^(failed|failures|failedCount|numberOfFailures|testsFailed)$/i) ?? 0
    const passed = countOf(a.json, /^(passed|passedCount|succeeded|testsPassed)$/i)
    const issues = failedTests(a.json)
    const isOk = !a.isError && failed === 0 && issues.length === 0 && !isFailure(verdict)
    const summary = isOk
      ? passed !== null
        ? `Tests passed · ${passed}`
        : 'Tests passed'
      : failed > 0
        ? `Tests failed · ${failed}${passed !== null ? ` of ${failed + passed}` : ''}`
        : a.isError
          ? 'Tests could not run'
          : 'Tests failed'

    return { ...base, isOk, summary, issues: issues.length > 0 ? issues : isOk ? [] : [errorText(a)] }
  }
  const issues = issuesOf(a)
  // A run counts only once Xcode says the app launched: a process, or the
  // launch sentence. Anything else (a failed build reads `buildErrors`) is not.
  const isLaunched = typeof a.json?.processIdentifier === 'number' || /launched/i.test(str(a.json?.runResult) ?? '')
  const isOk = !a.isError && issues.length === 0 && !isFailure(verdict) && (kind !== 'run' || isLaunched)
  const what = kind === 'run' ? 'Run' : kind === 'stop' ? 'Stop' : 'Build'
  const summary = isOk
    ? kind === 'run'
      ? // What happened, not what is: whether it still runs is `launched`'s to say.
        `Launched${destination ? ` on ${destination}` : ''}`
      : kind === 'stop'
        ? 'App stopped'
        : 'Build succeeded'
    : issues.length > 0
      ? `${what} failed · ${plural(issues.length, 'error')}`
      : kind === 'run' && !a.isError && !isFailure(verdict)
        ? 'The app did not launch'
        : `${what} failed`

  return { ...base, isOk, summary, issues: isOk ? [] : issues.length > 0 ? issues : [verdict !== '' ? verdict : errorText(a)] }
}

// The prompt the band fills for Claude after a failure it ran itself.
export const handOver = (o: Outcome, project: string): string => {
  const what = o.kind === 'test' ? 'tests' : o.kind === 'run' ? 'run' : 'build'
  const where = o.destination ? ` for ${o.destination}` : ''
  const lines = o.issues.slice(0, 12).map(i => `- ${i}`)

  return [
    `The Xcode ${what} of ${project}${where}, started from the Xcode band, failed:`,
    ...lines,
    '',
    o.kind === 'test' ? 'Please look into the failing tests and fix them.' : 'Please fix these errors.',
  ].join('\n')
}

// ── Formatting ──────────────────────────────────────────────────────────────

export const parseVersion = (out: string): string | null => /Xcode\s+(\d+(?:\.\d+)*)/.exec(out)?.[1] ?? null

export const fmtElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const fmtAgo = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

export const baseName = (path: string): string => (path.split('/').pop() ?? path).replace(/\.(xcodeproj|xcworkspace)$/, '')

// ── What the band shows ─────────────────────────────────────────────────────

export type Action =
  | 'use-xcode-mcp'
  | 'recheck'
  | 'app-store'
  | 'copy-select'
  | 'open-xcode'
  | 'copy-enable'
  | 'reconnect'
  | 'open-issue'
  | 'approve'
  | 'open-project'
  | 'run'
  | 'build'
  | 'test'
  | 'stop'
  | 'hand-over'
  | 'cancel'
  | 'refresh'
  | 'open-in-xcode'
  | 'connect'
  | 'resume'

export const ACTION_LABEL: Record<Action, string> = {
  'use-xcode-mcp': 'Use Xcode MCP',
  recheck: 'Check again',
  'app-store': 'Open App Store',
  'copy-select': 'Copy command',
  'open-xcode': 'Open Xcode',
  'copy-enable': 'Copy command',
  reconnect: 'Connect again',
  'open-issue': 'Open issue',
  approve: 'Ask Xcode',
  'open-project': 'Open project',
  run: 'Run',
  build: 'Build',
  test: 'Test',
  stop: 'Stop',
  'hand-over': 'Ask Claude to fix',
  cancel: 'Stop',
  refresh: 'Refresh',
  'open-in-xcode': 'Open in Xcode',
  connect: 'Connect to Xcode',
  resume: 'Resume',
}

export const SELECT_COMMAND = 'sudo xcode-select -s /Applications/Xcode.app'
export const ENABLE_COMMAND = 'sudo xcrun mcp-server enable'

export type Tone = 'calm' | 'busy' | 'ok' | 'warn' | 'error'

export type BandView = {
  headline: string
  detail: string | null
  note: string | null
  /** The note asks the person to act (unlock the device): drawn in the warning color. */
  isNoteUrgent?: boolean
  /** A small action drawn inline after the note, as part of its sentence. */
  noteAction?: Action
  tone: Tone
  /** Drawn right, before the actions: the spinner and elapsed time. */
  busy: string | null
  /** Drawn right in place of the actions, dimmed: what they wait for (Claude's turn, a build elsewhere). */
  waiting: string | null
  /** A row of its own under the detail: where Xcode does the band's work. */
  where: string | null
  /** The device picker is offered (drawn only where the surface has Select). */
  hasPicker: boolean
  /** The project picker of `pick-project`. */
  hasProjectPicker: boolean
  /** In order; the first is the main one. */
  actions: Action[]
}

// ── Runs started in the Xcode window ─────────────────────────────────────────
// Xcode's MCP server says nothing of a run started in its window until the app
// launches. The Xcode app logs each run to the unified log (subsystem
// `IDELaunchReport`), every line led by the run's id and the step's:
//   <run>:<run>: Start                          the run begins (after its build)
//   <scheme>:Run:<run>: Launch <app>            what it runs
//   <run>:<step>:Installing built products: Waiting for device unavailability
//     condition to be resolved: <device>: …     the device is being prepared
//   <run>:<step>:Installing built products: Installing on <device>:
//   <run>:<step>:Launching <app> Start
//   <run>:<step>:Launching <app>: <device> is locked, waiting for unlock: …
//   <run>:<step>:Launching <app> Finished       launched (or given up)
//   <run>:<run>: Finished                       the run is over

export type ReportStep = XcodeRun['step']
export type ReportRun = { startedAtMs: number; scheme: string | null; device: string | null; step: ReportStep }
export type LaunchReport = Readonly<Record<string, ReportRun>>

// One line of the launch report applied to the runs it tells of.
export const readLaunchReport = (runs: LaunchReport, message: string, atMs: number): LaunchReport => {
  const set = (id: string, change: Partial<ReportRun>): LaunchReport =>
    runs[id] === undefined ? runs : { ...runs, [id]: { ...runs[id], ...change } }
  const drop = (id: string): LaunchReport => {
    if (runs[id] === undefined) return runs
    const { [id]: _, ...rest } = runs
    return rest
  }
  let m: RegExpExecArray | null
  if ((m = /^([0-9a-f]+):\1: Start$/.exec(message))) return { ...runs, [m[1]]: { startedAtMs: atMs, scheme: null, device: null, step: 'preparing' } }
  if ((m = /^([0-9a-f]+):\1: Finished$/.exec(message))) return drop(m[1])
  if ((m = /^(.+):Run:([0-9a-f]+): Launch /.exec(message))) return set(m[2], { scheme: m[1] })
  if ((m = /^([0-9a-f]+):[0-9a-f]+:Installing built products: Waiting for device unavailability condition to be resolved: (.+?): /.exec(message)))
    return set(m[1], { step: 'preparing', device: m[2] })
  if ((m = /^([0-9a-f]+):[0-9a-f]+:Installing built products: Installing on (.+?):?$/.exec(message))) return set(m[1], { step: 'installing', device: m[2] })
  if ((m = /^([0-9a-f]+):[0-9a-f]+:Launching .+?: (.+) is locked, waiting for unlock/.exec(message))) return set(m[1], { step: 'locked', device: m[2] })
  if ((m = /^([0-9a-f]+):[0-9a-f]+:Launching .+ Start$/.exec(message))) return set(m[1], { step: 'launching' })
  if ((m = /^([0-9a-f]+):[0-9a-f]+:Launching .+ Finished$/.exec(message))) return drop(m[1])

  return runs
}

// The unified log's time: `2026-10-18 19:50:38.530690+0200`.
export const logTimeOf = (stamp: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([+-])(\d{2})(\d{2})$/.exec(stamp)
  if (!m) return null
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number)
  const ms = Math.round(Number(`0.${m[7] ?? '0'}`) * 1000)
  const offset = (Number(m[9]) * 60 + Number(m[10])) * 60_000 * (m[8] === '-' ? -1 : 1)
  return Date.UTC(y, mo - 1, d, h, mi, sec, ms) - offset
}

// A run Xcode has under way for this scheme, past its build and before the
// app launched; the newest when there are more. One older than `staleMs` is
// one whose end the band missed.
export const xcodeRunOf = (runs: LaunchReport, scheme: string | null, now: number, staleMs = 3 * 3_600_000): Omit<XcodeRun, 'workspaceId'> | null => {
  let found: ReportRun | null = null
  for (const run of Object.values(runs)) {
    if (run.scheme === null || (scheme !== null && run.scheme !== scheme) || now - run.startedAtMs > staleMs) continue
    if (found === null || run.startedAtMs > found.startedAtMs) found = run
  }

  return found === null ? null : { startedAtMs: found.startedAtMs, destination: found.device, step: found.step, isLocked: found.step === 'locked' }
}

export type BandInput = {
  setup: Setup
  project: string | null
  scheme: string | null
  active: string | null
  activities: readonly Activity[]
  isExternalBuild: boolean
  launched: Launched | null
  last: Outcome | null
  /** A model turn is running in this session. */
  isTurn: boolean
  /** Other sessions' builds, runs and tests on this Mac. */
  elsewhere: readonly Elsewhere[]
  /** The band's project file, absolute; null until one is picked. */
  projectPath: string | null
  /** Polling stopped while nobody used the session: what it shows may be old. */
  isPaused: boolean
  /** The band's own checks on Xcode would ask for permission: it holds them. */
  isHeld?: boolean
  /**
   * Where Xcode does the band's work: the Xcode app's window for the project,
   * or the headless server, which builds with no window open.
   */
  via: 'window' | 'headless' | null
  /** Where the current run stands, when one runs. */
  phase?: RunPhase | null
  /** A run started in the Xcode window, waiting on the device. */
  xcodeRun?: XcodeRun | null
  now: number
  spinner: string
}

// A band run still going after this long gets a hint about the device.
export const SLOW_RUN_MS = 90_000

const VERB: Record<ActivityKind, string> = { build: 'building', run: 'building and launching', test: 'testing', stop: 'stopping the app' }

const busyHeadline = (a: Activity, project: string, phase: RunPhase['step'] | null = null): string => {
  const where = a.destination && a.kind !== 'stop' ? ` for ${a.destination}` : ''
  // A run past its build: launching, or held up by a locked device.
  if (a.kind === 'run' && phase !== null && phase !== 'building') {
    const device = a.destination ?? 'the device'
    const who = a.by === 'band' ? '' : a.by === 'claude' ? 'Claude: ' : 'Xcode: '
    return phase === 'locked' ? `${who}Waiting for ${device} to be unlocked` : `${who}Launching ${project} on ${device}`
  }
  if (a.by === 'band') {
    const verb = a.kind === 'run' ? 'Running' : a.kind === 'test' ? 'Testing' : a.kind === 'stop' ? 'Stopping' : 'Building'
    return `${verb} ${project}${where}`
  }
  if (a.by === 'claude') return `Claude is ${VERB[a.kind]}${where}`

  return `Xcode is ${VERB[a.kind]}${where}`
}

// Another session in a line: its branch, and its folder when that differs (a worktree).
export const sessionLabel = (x: Elsewhere): string =>
  x.branch ? `another session on ${x.branch}` : `another session in ${x.folder.split('/').pop() ?? x.folder}`

// What other sessions hold that this band must not collide with: the same
// project file (the same checkout: one build folder, one Xcode workspace),
// or the device the band would run on.
export const conflictsOf = (i: Pick<BandInput, 'elsewhere' | 'projectPath' | 'active'>) => ({
  project: i.elsewhere.find(x => i.projectPath !== null && x.project === i.projectPath),
  device: i.elsewhere.find(x => i.active !== null && x.destination === i.active && x.kind !== 'build'),
})

const byLabel = (o: Outcome): string => {
  const who = o.by === 'band' ? 'from the band' : o.by === 'claude' ? 'by Claude' : 'in Xcode'
  // A launch says who launched it: who ended it the band cannot know.
  return o.kind === 'run' ? `launched ${who}` : who
}

const setupView = (s: Setup, project: string | null): BandView => {
  const v = s.xcodeVersion ? `Xcode ${s.xcodeVersion}` : 'Xcode'
  const view = (headline: string, detail: string | null, actions: Action[], tone: Tone = 'warn'): BandView => ({
    headline,
    detail,
    note: null,
    tone,
    busy: null,
    waiting: null,
    where: null,
    hasPicker: false,
    hasProjectPicker: false,
    actions,
  })
  switch (s.step) {
    case 'checking':
      return view('Checking Xcode…', null, [], 'calm')
    case 'no-project':
      return view('No Xcode project here', null, [], 'calm')
    case 'choose-backend':
      return view(
        `${project ?? 'Xcode project'} found · pick what builds it`,
        'The band builds, runs and tests through it · more backends later',
        ['use-xcode-mcp'],
        'calm',
      )
    case 'pick-project':
      return { ...view('Several Xcode projects here · pick one', null, [], 'calm'), hasProjectPicker: true }
    case 'no-xcode':
      return view('Xcode not found', 'Install Xcode 26.3 or newer: its MCP server is what the band drives', ['app-store', 'recheck'])
    case 'command-line-tools':
      return view(
        'xcode-select points at the Command Line Tools',
        `Switch it to Xcode in a terminal: ${SELECT_COMMAND}`,
        ['copy-select', 'recheck'],
      )
    case 'too-old':
      return view(`${v} has no MCP server`, 'Xcode 26.3 and newer ship it (xcrun mcpbridge) · update, then check again', ['app-store', 'recheck'])
    case 'open-xcode':
      return view(`${v} serves its tools only while it is open`, 'Newer Xcode versions serve them with the app closed too', ['open-xcode'])
    case 'permission-off':
      return view(
        "Xcode doesn't let agents use its tools yet",
        `Turn it on in Xcode › Settings › Intelligence, or headless in a terminal: ${ENABLE_COMMAND}`,
        s.isXcodeOpen ? ['copy-enable', 'recheck'] : ['open-xcode', 'copy-enable', 'recheck'],
      )
    case 'held':
      return view(
        'Connect to Xcode',
        'In this permission mode every check on Xcode asks first, so the band waits for you',
        ['connect'],
        'calm',
      )
    case 'mcp-failed':
      return view("Can't reach Xcode's MCP server", s.message, ['reconnect'], 'error')
    case 'auto-mode':
      return view(
        "The desktop app's auto mode blocks the band",
        "A known bug (claude-code #101884): auto mode should let a mod's own Xcode calls through, and does in the terminal, but the desktop app refuses them · switch this session out of auto mode, or use the band in a terminal session, then check again",
        ['recheck', 'open-issue'],
      )
    case 'approve':
      return view(
        'Xcode has to approve the band',
        s.isApprovalAsked
          ? 'Confirm the dialog in Xcode · the band notices by itself'
          : `Opening ${project ?? 'the project'} asks Xcode to let the band use this folder`,
        ['approve'],
      )
    case 'open-project':
      return view(
        `Open ${project ?? 'the project'} for the band`,
        `${v} has it closed · the band works on it once it is open`,
        ['open-project'],
        'calm',
      )
    case 'ready':
      return view('Ready', null, [], 'calm')
  }
}

export const bandView = (i: BandInput): BandView => {
  if (i.setup.step !== 'ready') return setupView(i.setup, i.project)

  const project = i.project ?? 'the app'
  const where = i.via === 'headless' ? 'Headless Xcode (no window)' : i.via === 'window' ? 'Xcode window' : null
  const facts = (...xs: (string | null)[]) => {
    const line = xs.filter(Boolean).join(' · ')
    return line === '' ? null : line
  }

  // Something builds: who, what, for how long. Nothing can be pressed that
  // would collide with it.
  const current = i.activities[0]
  const held = conflictsOf(i)
  // Another session builds this same checkout: shown like a build of our own,
  // with nothing to press (the band cancels only what it started).
  if (current === undefined && held.project !== undefined) {
    const x = held.project
    const target = x.destination && x.kind !== 'stop' ? ` for ${x.destination}` : ''
    return {
      headline: `${x.by === 'claude' ? 'Claude in another session' : 'Another session'} is ${VERB[x.kind]}${target}`,
      detail: facts(sessionLabel(x), i.scheme),
      note: null,
      tone: 'busy',
      busy: `${i.spinner} ${fmtElapsed(i.now - x.startedAtMs)}`,
      waiting: 'Available when the other session is done',
      where,
      hasPicker: false,
      hasProjectPicker: false,
      actions: [],
    }
  }
  if (current !== undefined || i.isExternalBuild) {
    const step = current !== undefined && i.phase?.activityId === current.id ? i.phase.step : null
    const headline = current ? busyHeadline(current, project, step) : 'Xcode is building'
    const elapsed = current ? ` ${fmtElapsed(i.now - current.startedAtMs)}` : ''
    const more = i.activities.length > 1 ? `+${i.activities.length - 1} more` : null
    const source = current === undefined ? 'started outside this session' : current.isShell ? 'xcodebuild' : null

    // The band's own run waits on the device once built: a locked or unplugged
    // one keeps it waiting, so after a while the band says what to look at.
    const isBand = current?.by === 'band'
    const isSlow = isBand && current.kind === 'run' && i.now - current.startedAtMs > SLOW_RUN_MS
    const isLocked = step === 'locked'
    const note = isLocked
      ? `Unlock ${current?.destination ?? 'the device'} to launch ${project}`
      : !isBand
        ? null
        : isSlow
          ? `Taking long: is ${current.destination ?? 'the device'} unlocked and connected?`
          : null

    return {
      headline,
      detail: facts(i.scheme, source, more),
      note,
      isNoteUrgent: isLocked || isSlow,
      tone: 'busy',
      busy: `${i.spinner}${elapsed}`,
      waiting: isBand ? null : current?.by === 'claude' ? 'Available when Claude is done' : 'Available when Xcode is done',
      where,
      hasPicker: false,
      hasProjectPicker: false,
      // Only what the band started can be cancelled from it.
      actions: isBand ? ['cancel'] : [],
    }
  }

  // A run started in the Xcode window, built, that has not launched the app:
  // Xcode waits on the device, a locked one until it is unlocked. Stop ends
  // it as Xcode's own Stop would.
  if (i.xcodeRun) {
    const device = i.xcodeRun.destination ?? 'the device'
    const doing =
      i.xcodeRun.step === 'locked'
        ? `Waiting for ${device} to be unlocked`
        : i.xcodeRun.step === 'preparing'
          ? `Preparing ${device}`
          : i.xcodeRun.step === 'installing'
            ? `Installing ${project} on ${device}`
            : `Launching ${project} on ${device}`
    return {
      headline: `Xcode: ${doing}`,
      detail: facts(i.scheme, 'started in Xcode'),
      note: i.xcodeRun.isLocked ? `Unlock ${device} to launch ${project}` : null,
      isNoteUrgent: i.xcodeRun.isLocked,
      tone: 'busy',
      busy: `${i.spinner} ${fmtElapsed(i.now - i.xcodeRun.startedAtMs)}`,
      waiting: null,
      where,
      hasPicker: false,
      hasProjectPicker: false,
      actions: ['stop'],
    }
  }

  // A launch newer than the last result leads: it is what runs now.
  const isRunningNow = i.launched !== null && (i.last === null || i.launched.atMs >= i.last.atMs)
  const headline = isRunningNow
    ? `Running on ${i.launched?.destination ?? 'the device'}`
    : i.last
      ? i.last.summary
      : `${project} is ready to run`
  const tone: Tone = isRunningNow ? 'ok' : i.last ? (i.last.isOk ? 'ok' : 'error') : 'calm'
  const ended = i.last?.endedAtMs !== undefined ? `ended ${fmtAgo(i.now - i.last.endedAtMs)}` : null
  const lastFacts = i.last && !isRunningNow ? facts(`${byLabel(i.last)} ${fmtAgo(i.now - i.last.atMs)}`, ended) : null
  const started =
    isRunningNow && i.launched?.by === 'external' ? 'started in Xcode' : isRunningNow && i.launched?.by === 'claude' ? 'started by Claude' : null
  const detail = facts(i.last || isRunningNow ? project : null, lastFacts, started, i.launched && !isRunningNow && i.last?.kind !== 'run' ? 'app running' : null)
  const canHandOver = i.last !== null && !i.last.isOk && i.last.by === 'band' && i.last.issues.length > 0
  const stop: Action[] = i.launched ? ['stop'] : []

  // The app runs: Stop is the one thing to do. Running or testing again
  // would replace it, and the device it runs on is not the band's to change.
  if (isRunningNow) {
    return {
      headline,
      detail,
      note: null,
      tone,
      busy: null,
      waiting: null,
      where,
      hasPicker: false,
      hasProjectPicker: false,
      actions: ['stop'],
    }
  }

  // Claude's turn: the project may be half-edited and Claude may build at any
  // moment, so starting a build from here waits. Stopping the app is safe.
  if (i.isTurn) {
    return {
      headline,
      detail,
      note: null,
      tone,
      busy: null,
      waiting: 'Available when Claude is done',
      where,
      hasPicker: false,
      hasProjectPicker: false,
      actions: stop,
    }
  }

  // The picked device runs another session's app or tests (a worktree of the
  // same app, say): another device can be picked, this one cannot be used.
  if (held.device !== undefined) {
    return {
      headline,
      detail,
      note: `${i.active} is in use by ${sessionLabel(held.device)} · pick another device`,
      tone,
      busy: null,
      waiting: null,
      where,
      hasPicker: true,
      hasProjectPicker: false,
      actions: [...(canHandOver ? (['hand-over'] as Action[]) : []), ...stop, 'open-in-xcode'],
    }
  }

  return {
    headline,
    detail,
    note: i.isHeld ? 'Live status off in this mode ·' : i.isPaused ? 'Paused while idle ·' : null,
    noteAction: i.isHeld ? 'refresh' : i.isPaused ? 'resume' : undefined,
    tone,
    busy: null,
    waiting: null,
    where,
    hasPicker: true,
    hasProjectPicker: false,
    actions: [...(canHandOver ? (['hand-over'] as Action[]) : []), 'run', 'build', 'test', ...stop, 'open-in-xcode'],
  }
}

// Why a band action may not start now; null when it may.
export const refusal = (
  i: Pick<BandInput, 'setup' | 'activities' | 'isExternalBuild' | 'isTurn' | 'elsewhere' | 'projectPath' | 'active'> & {
    launched?: Launched | null
    xcodeRun?: XcodeRun | null
  },
  kind: ActivityKind,
): string | null => {
  if (i.setup.step !== 'ready') return "Xcode isn't set up for the band yet."
  if (kind === 'stop') return null
  if (i.isTurn) return 'Claude is working: run it once the turn is done.'
  const current = i.activities[0]
  if (current) return current.by === 'claude' ? 'Claude is building right now.' : 'The band is already building.'
  if (i.isExternalBuild) return 'Xcode is already building.'
  if (i.launched) return `The app is running${i.launched.destination ? ` on ${i.launched.destination}` : ''}: stop it first.`
  if (i.xcodeRun) return `Xcode is launching the app${i.xcodeRun.destination ? ` on ${i.xcodeRun.destination}` : ''}: stop it first.`
  const held = conflictsOf(i)
  if (held.project) return `${sessionLabel(held.project).replace(/^a/, 'A')} is ${VERB[held.project.kind]} this project.`
  if (held.device) return `${i.active} is in use by ${sessionLabel(held.device)}.`

  return null
}
