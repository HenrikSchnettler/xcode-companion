// Xcode Companion — the band above the prompt for Xcode projects.
//
// Shows who is building right now (Claude through Xcode's MCP server or
// xcodebuild, the band itself, or Xcode outside this session) and, when
// nothing is, offers a device picker, Run, Test and Stop. Before that it walks
// the person through setting the build backend up: Xcode's MCP server, found,
// enabled, approved and holding the project. Its decisions live in model.ts;
// this file reads the host and draws.
//
// The band calls Xcode's MCP server with `$.mcp.call`: a mod's own call, which
// the plugin API makes its own grant, outside the model's permissions.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Activity, ActivityKind, Actor, Backend, Destination, Elsewhere, Outcome, RunPhase, Setup, Workspace } from '../types'
import type { Action, Answer } from './model'
import {
  ACTION_LABEL,
  DESKTOP_BUG_URL,
  ENABLE_COMMAND,
  SELECT_COMMAND,
  activeOf,
  bandView,
  baseName,
  errorText,
  handOver,
  isApprovalRefusal,
  isAutoModeRefusal,
  isPermissionRefusal,
  outcomeOf,
  parseDestinations,
  parseLaunch,
  pickWorkspace,
  parseVersion,
  parseWorkspaces,
  readAnswer,
  refusal,
  shellBuild,
  xcodeTool,
} from './model'

const INITIAL_SETUP: Setup = {
  step: 'checking',
  message: null,
  xcodeVersion: null,
  isHeadlessCapable: false,
  isXcodeOpen: false,
  projects: [],
  isApprovalAsked: false,
}

const setup = atom({ plugin: 'xcode-companion', key: 'setup' } as const, INITIAL_SETUP)
const workspace = atom({ plugin: 'xcode-companion', key: 'workspace' } as const, null)
const destinations = atom({ plugin: 'xcode-companion', key: 'destinations' } as const, [])
const active = atom({ plugin: 'xcode-companion', key: 'active' } as const, null)
const activities = atom({ plugin: 'xcode-companion', key: 'activities' } as const, [])
const isExternalBuild = atom({ plugin: 'xcode-companion', key: 'isExternalBuild' } as const, false)
const launched = atom({ plugin: 'xcode-companion', key: 'launched' } as const, null)
const last = atom({ plugin: 'xcode-companion', key: 'last' } as const, null)
const isHidden = atom({ plugin: 'xcode-companion', key: 'isHidden' } as const, false)
const frame = atom({ plugin: 'xcode-companion', key: 'frame' } as const, 0)
const elsewhere = atom({ plugin: 'xcode-companion', key: 'elsewhere' } as const, [])
const isPaused = atom({ plugin: 'xcode-companion', key: 'isPaused' } as const, false)
const phase = atom({ plugin: 'xcode-companion', key: 'phase' } as const, null)

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const APP_STORE = 'macappstore://apps.apple.com/app/id497799835'
// Steps the person resolves outside the band: re-checked on a timer.
const WAITING = new Set(['open-xcode', 'permission-off', 'approve', 'command-line-tools'])
// How long Claude's Xcode call waits for a build the band started.
const WAIT_LIMIT_S = 900
// Polling stops after this long with nobody using the session, and starts
// again on the next sign of them (a prompt, a press, the session reattached).
const IDLE_MS = 10 * 60_000
// Each session's builds are files in a registry every band reads: rewritten
// this often while they run, and given up as stale (a session that died
// mid-build) when older than STALE_MS.
const HEARTBEAT_MS = 15_000
const STALE_MS = 60_000

let isWorking = false
let isProbing = false
let isPolling = false
// Band activities the person cancelled: their late answers are dropped.
const cancelled = new Set<string>()
// Polling runs on one 1 s tick, each part at its own pace: the local look
// at the build services every tick (free), the app's state and the other
// sessions every 4th, Xcode's workspaces every 8th, the devices every 16th.
const TICK_MS = 1_000
const APP_EVERY = 4
const WORKSPACES_EVERY = 8
const DEVICES_EVERY = 16
let ticks = 0
let polls = 0
// What the last local look saw: Xcode is asked when a build starts, then
// every APP_EVERY ticks while it lasts.
let wasAnythingBuilding = false
let spinner: Timer | null = null
let seq = 0
// The registry's folder, this session's key in it, and how it reads to others.
let registry: string | null = null
let sessionKey = ''
let branch: string | null = null
let folder = ''
let lastActiveMs = 0
let pollTimer: Timer | null = null
let probeTimer: Timer | null = null
let heartbeat: Timer | null = null
// Follows a run under way, every PHASE_MS, until it ends.
let phaseTimer: Timer | null = null
const PHASE_MS = 2_000
// The MCP server's name as `$.mcp.call` takes it, once connected.
let server: string | null = null

const keyFor = (kind: string, path: string) => `${kind}:${path}`

// ── Host access ─────────────────────────────────────────────────────────────

const sh = async ($: EngineInterface, argv: string[], timeoutMs = 10_000) => {
  try {
    return await $.process.run(argv, { timeoutMs })
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: String(err), isStdoutTruncated: false, isStderrTruncated: false }
  }
}

const connect = async ($: EngineInterface): Promise<string | null> => {
  if (server !== null) return server
  const r = await $.mcp.connect('xcode')
  if (r.isConnected) server = r.server
  else await setStep($, 'mcp-failed', { message: r.message })

  return server
}

// One call on Xcode's MCP server, aimed at the band's workspace unless told otherwise.
// `target` names another of the project's workspaces (where an app runs).
const xcode = async (
  $: EngineInterface,
  tool: string,
  args: Record<string, unknown> = {},
  isScoped = true,
  target?: string,
): Promise<Answer> => {
  const name = await connect($)
  if (name === null) return { json: null, text: "Xcode's MCP server is not connected.", isError: true }
  const id = target ?? (isScoped ? (await read($, workspace))?.id : undefined)
  try {
    const result = await $.mcp.call(name, tool, id ? { workspaceIdentifier: id, ...args } : args)
    const answer = readAnswer(result)
    void discardArtifacts($, answer)
    return answer
  } catch (err) {
    const text = String(err)
    // The desktop app's auto mode refuses a mod's own call (a known bug): the
    // band says so instead of failing on every press.
    if (isAutoModeRefusal(text)) await setStep($, 'auto-mode', { message: text })
    return { json: null, text, isError: true }
  }
}

// Xcode writes a file for many answers (`fullLogPath`: the whole last build
// log, about a megabyte; `fullRunDestinationListPath`, …) and never removes
// it. The band's own calls are many, so it removes the ones they leave.
const discardArtifacts = async ($: EngineInterface, a: Answer) => {
  for (const [key, value] of Object.entries(a.json ?? {})) {
    if (!/^full\w*Path$/.test(key) || typeof value !== 'string') continue
    if (!value.includes('/ActionArtifacts/') || value.includes('..')) continue
    await sh($, ['rm', '-f', value])
  }
}

// A build anywhere on this Mac, seen without asking Xcode: its build service
// (the app's and the headless server's each run one) spawns a build's
// compilers and tools as its children and has none while idle. Asking Xcode
// (GetBuildLog) makes it write its last build log to disk on every ask, so it
// is asked only once this says something builds. Indexing may spawn children
// too: Xcode's answer then says nothing builds.
const isAnythingBuilding = async ($: EngineInterface): Promise<boolean> => {
  const ran = await sh($, ['sh', '-c', 'for p in $(pgrep -x SWBBuildService; pgrep -x XCBBuildService); do pgrep -P "$p"; done'])
  // Could not look: ask Xcode as before.
  if (ran.exitCode === 127) return true
  return ran.stdout.trim() !== ''
}

// Whether Xcode builds in one of these workspaces: the local look first.
const isXcodeBuilding = async ($: EngineInterface, ids: readonly string[], isLocallyBusy?: boolean): Promise<boolean> => {
  if (ids.length === 0 || !(isLocallyBusy ?? (await isAnythingBuilding($)))) return false
  for (const id of ids) {
    const log = await xcode($, 'GetBuildLog', { severity: 'error', pattern: '^$' }, true, id)
    if (!log.isError && log.json?.buildIsRunning === true) return true
  }

  return false
}

const setStep = ($: EngineInterface, step: Setup['step'], over: Partial<Setup> = {}) =>
  update($, setup, (s: Setup) => ({ ...s, ...over, step }))

// ── Busy state ──────────────────────────────────────────────────────────────

// The spinner steps only while something builds.
const syncSpinner = async ($: EngineInterface) => {
  const isBusy =
    (await read($, activities)).length > 0 || (await read($, isExternalBuild)) || (await read($, elsewhere)).length > 0
  if (!isBusy) {
    spinner?.cancel()
    spinner = null
  } else if (spinner === null) {
    spinner = $.clock.every(150, () => void update($, frame, (n: number) => (n + 1) % SPINNER.length))
  }
}

// ── Other sessions ──────────────────────────────────────────────────────────

const entryOf = (id: string) => `${registry}/${sessionKey}--${id}.json`

// Puts one of this session's activities in the registry, or refreshes it.
const publish = async ($: EngineInterface, a: Activity) => {
  const project = registry === null ? null : await projectPath($)
  if (registry === null || project === null) return
  const entry: Elsewhere & { heartbeatMs: number } = {
    project,
    destination: a.destination,
    kind: a.kind,
    by: a.by,
    branch,
    folder,
    startedAtMs: a.startedAtMs,
    heartbeatMs: await $.clock.now(),
  }
  await $.fs.write(entryOf(a.id), JSON.stringify(entry)).catch(() => undefined)
}

const withdraw = async ($: EngineInterface, id: string) => {
  if (registry !== null) await sh($, ['rm', '-f', entryOf(id)])
}

// Every entry this session left: at its start (a reload forgets what ran) and its end.
const withdrawAll = async ($: EngineInterface) => {
  if (registry === null) return
  const names = await $.fs.list(registry).catch(() => [])
  for (const { name } of names) if (name.startsWith(`${sessionKey}--`)) await sh($, ['rm', '-f', `${registry}/${name}`])
}

const beat = async ($: EngineInterface) => {
  for (const a of await read($, activities)) await publish($, a)
}

// The other sessions' live entries; a stale one (its session gone) is removed.
const readElsewhere = async ($: EngineInterface): Promise<readonly Elsewhere[]> => {
  if (registry === null) return []
  const names = await $.fs.list(registry).catch(() => [])
  const now = await $.clock.now()
  const found: Elsewhere[] = []
  for (const { name } of names) {
    if (!name.endsWith('.json') || name.startsWith(`${sessionKey}--`)) continue
    const path = `${registry}/${name}`
    try {
      const x = JSON.parse(await $.fs.read(path)) as Partial<Elsewhere> & { heartbeatMs?: unknown }
      if (typeof x.heartbeatMs !== 'number' || now - x.heartbeatMs > STALE_MS || typeof x.project !== 'string') {
        await sh($, ['rm', '-f', path])
        continue
      }
      found.push({
        project: x.project,
        destination: x.destination ?? null,
        kind: x.kind ?? 'build',
        by: x.by ?? 'claude',
        branch: x.branch ?? null,
        folder: x.folder ?? '',
        startedAtMs: x.startedAtMs ?? now,
      })
    } catch {
      // Half-written or gone meanwhile: read again on the next poll.
    }
  }
  found.sort((x, y) => x.startedAtMs - y.startedAtMs)
  if (JSON.stringify(found) !== JSON.stringify(await read($, elsewhere))) {
    await update($, elsewhere, () => found)
    await syncSpinner($)
  }

  return found
}

// ── Idle ────────────────────────────────────────────────────────────────────

const startTimers = ($: EngineInterface) => {
  probeTimer ??= $.clock.every(3_000, () => {
    void (async () => {
      if (WAITING.has((await read($, setup)).step)) await probe($)
    })()
  })
  pollTimer ??= $.clock.every(TICK_MS, () => void tick($))
}

// Nobody has used the session for a while: no more calls to Xcode or reads of
// the registry until they are back. What the band last saw may be old, so it
// forgets other sessions' builds and says it is paused.
const pause = async ($: EngineInterface) => {
  pollTimer?.cancel()
  probeTimer?.cancel()
  pollTimer = null
  probeTimer = null
  await update($, isPaused, () => true)
  await update($, elsewhere, () => [])
  await update($, isExternalBuild, () => false)
  await syncSpinner($)
}

// A sign of the person: polling goes on, and starts again at once if paused.
const touch = async ($: EngineInterface) => {
  lastActiveMs = await $.clock.now()
  if (!(await read($, isPaused))) return
  await update($, isPaused, () => false)
  startTimers($)
  void tick($)
}

const tick = async ($: EngineInterface) => {
  const isOwnBusy = (await read($, activities)).length > 0
  if (!isOwnBusy && !isWorking && (await $.clock.now()) - lastActiveMs > IDLE_MS) return pause($)
  if ((await read($, setup)).step !== 'ready') return
  ticks += 1
  if (ticks % APP_EVERY === 0) await readElsewhere($)
  await poll($)
}

// ── A run under way ─────────────────────────────────────────────────────────

// A device's lock, read locally (`devicectl`, under a second); null for a
// simulator or anything that cannot say.
const isDeviceLocked = async ($: EngineInterface, device: string): Promise<boolean | null> => {
  const ran = await sh($, ['xcrun', 'devicectl', 'device', 'info', 'lockState', '--device', device, '--quiet', '--json-output', '/dev/stdout', '--timeout', '5'], 15_000)
  try {
    const result = (JSON.parse(ran.stdout) as { result?: { passcodeRequired?: unknown } }).result
    return typeof result?.passcodeRequired === 'boolean' ? result.passcodeRequired : null
  } catch {
    return null
  }
}

// Where the oldest run stands: building while Xcode's build service has
// children; past that, launching; held up when its device is locked. Xcode's
// MCP says nothing until RunProject returns, so the band looks around it.
const followRun = async ($: EngineInterface) => {
  const run = (await read($, activities)).find(a => a.kind === 'run')
  if (run === undefined) {
    phaseTimer?.cancel()
    phaseTimer = null
    if ((await read($, phase)) !== null) await update($, phase, () => null)
    return
  }
  let step: RunPhase['step'] = 'building'
  if (!(await isAnythingBuilding($))) {
    step = 'launching'
    const device = (await read($, destinations)).find(d => d.title === run.destination)
    // Only a device with no launch yet can be held up by its lock.
    if (device !== undefined && !device.isSimulator && run.destination !== null) {
      const launch = parseLaunch(await xcode($, 'GetConsoleOutput', { outputType: 'stdio', tailLimit: 1, pattern: '^$' }, true, run.workspaceId))
      if (launch?.isRunning !== true && (await isDeviceLocked($, run.destination)) === true) step = 'locked'
    }
  }
  const before = await read($, phase)
  if (before?.activityId === run.id && before.step === step) return
  await update($, phase, () => ({ activityId: run.id, step }))
  if (step === 'locked' && before?.step !== 'locked') $.ui.toast(`Unlock ${run.destination} to launch the app.`)
}

const begin = async ($: EngineInterface, kind: ActivityKind, by: Actor, isShell = false, workspaceId?: string): Promise<Activity> => {
  seq += 1
  const activity: Activity = {
    id: `${by}-${seq}`,
    kind,
    by,
    isShell,
    destination: await read($, active),
    startedAtMs: await $.clock.now(),
    workspaceId: workspaceId ?? (await read($, workspace))?.id,
  }
  await update($, activities, (xs: readonly Activity[]) => [...xs, activity])
  await update($, isExternalBuild, () => false)
  await syncSpinner($)
  await publish($, activity)
  heartbeat ??= $.clock.every(HEARTBEAT_MS, () => void beat($))
  if (kind === 'run') phaseTimer ??= $.clock.every(PHASE_MS, () => void followRun($))

  return activity
}

const finish = async ($: EngineInterface, activity: Activity, answer: Answer | null) => {
  await update($, activities, (xs: readonly Activity[]) => xs.filter(x => x.id !== activity.id))
  await syncSpinner($)
  await withdraw($, activity.id)
  lastActiveMs = await $.clock.now()
  if ((await read($, phase))?.activityId === activity.id) await update($, phase, () => null)
  if ((await read($, activities)).length === 0) {
    heartbeat?.cancel()
    heartbeat = null
  }
  if (answer === null) return
  const now = await $.clock.now()
  if (activity.kind === 'stop') {
    await update($, launched, () => null)
    await update($, last, (o: Outcome | null) => (o?.kind === 'run' ? null : o))
    return
  }
  const outcome = outcomeOf(activity.kind, activity.by, answer, activity.destination, now, now - activity.startedAtMs)
  await update($, last, () => outcome)
  if (activity.kind === 'run' && outcome.isOk) {
    const pid = typeof answer.json?.processIdentifier === 'number' ? answer.json.processIdentifier : null
    await update($, launched, () => ({ destination: activity.destination, atMs: now, by: activity.by, workspaceId: activity.workspaceId, pid }))
  }
  if (activity.by === 'band' && (outcome.durationMs ?? 0) > 20_000) {
    $.ui.toast(outcome.isOk ? `Xcode: ${outcome.summary}` : `Xcode: ${outcome.summary}`)
  }
}

const isBandBusy = async ($: EngineInterface) => (await read($, activities)).some(a => a.by === 'band')

// ── Setup ───────────────────────────────────────────────────────────────────

const findProjects = async ($: EngineInterface, cwd: string): Promise<string[]> => {
  let entries: { name: string; kind: string }[] = []
  try {
    entries = await $.fs.list(cwd)
  } catch {
    return []
  }
  // A bundle counts only with the file that makes it one: an empty
  // `.xcodeproj` left behind by a rename is no project to open.
  const holds = async (dir: string, file: string) => {
    try {
      return (await $.fs.list(`${cwd}/${dir}`)).some(x => x.name === file)
    } catch {
      return false
    }
  }
  const dirs = entries.filter(x => x.kind === 'dir').map(x => x.name)
  const spaces: string[] = []
  const projs: string[] = []
  for (const n of dirs) {
    if (n.endsWith('.xcworkspace') && (await holds(n, 'contents.xcworkspacedata'))) spaces.push(n)
    else if (n.endsWith('.xcodeproj') && (await holds(n, 'project.pbxproj'))) projs.push(n)
  }
  // A workspace beside its project (CocoaPods and the like) is the one to open.
  const projects = projs.filter(n => !spaces.includes(n.replace(/\.xcodeproj$/, '.xcworkspace')))

  return [...spaces, ...projects].sort().map(n => `${cwd}/${n}`)
}

// Xcode's run destinations as one answer listed them: the picker's options and
// the active one. A device unplugged is gone from the next answer, and Xcode
// moves the active destination off it by itself.
const applyDestinations = async ($: EngineInterface, a: Answer) => {
  if (a.isError) return
  const { list, active: now, scheme } = parseDestinations(a)
  await update($, destinations, () => list)
  await update($, active, () => now)
  if (scheme !== null) await update($, workspace, (w: Workspace | null) => (w === null || w.scheme === scheme ? w : { ...w, scheme }))
}

const loadDestinations = async ($: EngineInterface) => applyDestinations($, await xcode($, 'XcodeListRunDestinations'))

const adopt = async ($: EngineInterface, id: string, path: string, scheme: string | null = null, watched: readonly string[] = [id]) => {
  const ws: Workspace = { id, path, name: baseName(path), scheme, watched }
  await update($, workspace, () => ws)
  await $.store.set(keyFor('opened', path), true)
  await setStep($, 'ready', { message: null, isApprovalAsked: false })
  await loadDestinations($)
}

// Walks the setup from the first unmet step; each step reads the host afresh.
const probe = async ($: EngineInterface) => {
  if (isProbing) return
  isProbing = true
  try {
    const cwd = await $.session.cwd()
    const projects = await findProjects($, cwd)
    // Kept on every probe, whichever step it ends in: the band's project is read from it.
    await update($, setup, (s: Setup) => ({ ...s, projects }))
    if (projects.length === 0) return void (await setStep($, 'no-project', { projects }))

    const backend = (await $.store.get('backend')) as Backend | undefined
    if (backend === undefined) return void (await setStep($, 'choose-backend', { projects }))

    const chosen = (await $.store.get(keyFor('project', cwd))) as string | undefined
    const path = projects.length === 1 ? projects[0] : projects.find(p => p === chosen)
    if (path === undefined) return void (await setStep($, 'pick-project', { projects }))

    const version = parseVersion((await sh($, ['xcodebuild', '-version'])).stdout)
    const isXcodeOpen = (await sh($, ['pgrep', '-x', 'Xcode'])).exitCode === 0
    const facts = { projects, xcodeVersion: version, isXcodeOpen }

    if ((await sh($, ['xcrun', '--find', 'mcpbridge'])).exitCode !== 0) {
      const selected = (await sh($, ['xcode-select', '-p'])).stdout
      const installed = (await sh($, ['mdfind', 'kMDItemCFBundleIdentifier == "com.apple.dt.Xcode"'])).stdout.trim()
      const step = selected.includes('CommandLineTools') && installed !== '' ? 'command-line-tools' : installed === '' && version === null ? 'no-xcode' : 'too-old'
      return void (await setStep($, step, facts))
    }

    const isHeadlessCapable = (await sh($, ['xcrun', '--find', 'mcp-server'])).exitCode === 0
    if (!isHeadlessCapable && !isXcodeOpen) return void (await setStep($, 'open-xcode', { ...facts, isHeadlessCapable }))
    if (isHeadlessCapable && !isXcodeOpen) {
      // Headless: the server's own status says whether agents may use it.
      try {
        const status = JSON.parse((await sh($, ['xcrun', 'mcp-server', 'status', '--format', 'json'])).stdout) as {
          permission?: { enabled?: boolean }
        }
        if (status.permission?.enabled === false) {
          return void (await setStep($, 'permission-off', { ...facts, isHeadlessCapable }))
        }
      } catch {
        // An older status without JSON: the MCP calls below tell the rest.
      }
    }

    if ((await connect($)) === null) return
    const listed = await xcode($, 'XcodeListWorkspaces', {}, false)
    if (listed.isError && isAutoModeRefusal(listed.text)) return
    if (listed.isError) {
      const step = isApprovalRefusal(listed) ? 'approve' : isPermissionRefusal(listed) ? 'permission-off' : 'mcp-failed'
      return void (await setStep($, step, { ...facts, isHeadlessCapable, message: errorText(listed) }))
    }
    const opens = parseWorkspaces(listed).filter(w => w.path === path)
    const open = pickWorkspace(opens)
    if (open) return void (await adopt($, open.id, path, null, opens.map(w => w.id)))
    if ((await $.store.get(keyFor('opened', path))) === true) return void (await openProject($, path))
    await setStep($, 'open-project', { ...facts, isHeadlessCapable, message: null })
  } finally {
    isProbing = false
  }
}

const projectPath = async ($: EngineInterface): Promise<string | null> => {
  const ws = await read($, workspace)
  if (ws !== null) return ws.path
  const s = await read($, setup)
  if (s.projects.length === 1) return s.projects[0] ?? null
  const chosen = (await $.store.get(keyFor('project', await $.session.cwd()))) as string | undefined
  return s.projects.find(p => p === chosen) ?? null
}

// Opening a project is also what makes Xcode ask the person to approve Claude
// Code and the project's folder, so the approval step uses it too.
const openProject = async ($: EngineInterface, path: string) => {
  const a = await xcode($, 'XcodeOpenWorkspace', { path }, false)
  if (a.isError) {
    const step = isApprovalRefusal(a) ? 'approve' : isPermissionRefusal(a) ? 'permission-off' : 'mcp-failed'
    return void (await setStep($, step, { message: errorText(a), isApprovalAsked: false }))
  }
  const id = typeof a.json?.workspaceIdentifier === 'string' ? a.json.workspaceIdentifier : null
  if (id === null) return void (await setStep($, 'mcp-failed', { message: errorText(a) }))
  await adopt($, id, path, typeof a.json?.activeScheme === 'string' ? a.json.activeScheme : null)
}

// ── External builds ─────────────────────────────────────────────────────────

// While nothing of this session builds and Claude is idle, ask Xcode whether a
// build runs anyway: one started in Xcode itself or by another session.
// A workspace saved before `watched` existed watches itself alone.
const watchedOf = (ws: Workspace): readonly string[] => (ws.watched !== undefined && ws.watched.length > 0 ? ws.watched : [ws.id])

// Whether something of the band's, Claude's or Xcode's runs in a workspace:
// one that does is never closed under it.
const isInUse = async ($: EngineInterface, id: string): Promise<boolean> => {
  if ((await read($, activities)).some(a => a.workspaceId === id)) return true
  if ((await read($, launched))?.workspaceId === id) return true
  if (await isXcodeBuilding($, [id])) return true
  const launch = parseLaunch(await xcode($, 'GetConsoleOutput', { outputType: 'stdio', tailLimit: 1, pattern: '^$' }, true, id))
  return launch?.isRunning === true
}

// Xcode's workspaces for the project, again: the app may have opened or
// closed its window since. With the window open the project lives there
// alone: the headless server's copy is closed, so the same project is never
// loaded, indexed and built twice. With the window gone, the headless one is
// opened again (the person approved it before), and the band moves to it.
let isRefreshing = false
const refreshWorkspaces = async ($: EngineInterface) => {
  const ws = await read($, workspace)
  if (ws === null || isRefreshing) return
  isRefreshing = true
  try {
    const listed = await xcode($, 'XcodeListWorkspaces', {}, false)
    if (listed.isError) return
    let opens = parseWorkspaces(listed).filter(w => w.path === ws.path)
    if (opens.some(w => w.id.startsWith('windowtab-'))) {
      for (const headless of opens.filter(w => !w.id.startsWith('windowtab-'))) {
        if (await isInUse($, headless.id)) continue
        const closed = await xcode($, 'XcodeCloseWorkspace', { workspaceIdentifier: headless.id }, false)
        if (!closed.isError) opens = opens.filter(w => w.id !== headless.id)
      }
    }
    if (opens.length === 0) return void (await openProject($, ws.path))
    const open = pickWorkspace(opens)
    if (open === undefined) return
    const watched = opens.map(w => w.id)
    if (open.id === ws.id && watched.join() === (ws.watched ?? []).join()) return
    await update($, workspace, (w: Workspace | null) => (w === null ? w : { ...w, id: open.id, watched }))
    await loadDestinations($)
  } finally {
    isRefreshing = false
  }
}

// While nothing of this session builds and Claude is idle, ask each of the
// project's workspaces whether a build runs anyway (Xcode itself, another
// session) and whether an app runs there: one started in Xcode is shown and
// can be stopped from the band; one the band or Claude launched is forgotten
// once it ends.
const poll = async ($: EngineInterface) => {
  if (isPolling || isWorking || (await read($, isHidden))) return
  if ((await read($, setup)).step !== 'ready' || (await read($, activities)).length > 0) return
  isPolling = true
  try {
    polls += 1
    // Xcode opened or closed (by the band or not): seen within 8 s.
    if (polls % WORKSPACES_EVERY === 0) await refreshWorkspaces($)
    const ws = await read($, workspace)
    if (ws === null) return
    // A build starting shows within a tick: the local look is free, and Xcode
    // is asked only as a build starts and every few ticks while it runs.
    const isBusy = await isAnythingBuilding($)
    const isAppTick = polls % APP_EVERY === 0
    const isBuilding = !isBusy
      ? false
      : !wasAnythingBuilding || isAppTick
        ? await isXcodeBuilding($, watchedOf(ws), true)
        : await read($, isExternalBuild)
    wasAnythingBuilding = isBusy
    if ((await read($, activities)).length > 0) return
    if (isBuilding !== (await read($, isExternalBuild))) {
      await update($, isExternalBuild, () => isBuilding)
      await syncSpinner($)
    }
    if (!isAppTick) return

    let running: { workspaceId: string; pid: number | null } | null = null
    for (const id of watchedOf(ws)) {
      const launch = parseLaunch(await xcode($, 'GetConsoleOutput', { outputType: 'stdio', tailLimit: 1, pattern: '^$' }, true, id))
      if (launch?.isRunning && running === null) running = { workspaceId: id, pid: launch.pid }
    }
    const now = await $.clock.now()
    const known = await read($, launched)
    if (running === null) {
      // Ended (quit on the device, stopped in Xcode); a launch seconds old may
      // not have reached the console yet.
      if (known !== null && now - known.atMs > 10_000) {
        await update($, launched, () => null)
        // The band's (or Claude's) own launch ended: its result says so now.
        await update($, last, (o: Outcome | null) =>
          o !== null && o.kind === 'run' && o.isOk && o.atMs <= known.atMs + 1_000
            ? { ...o, summary: `App ended${known.destination ? ` on ${known.destination}` : ''}`, endedAtMs: now }
            : o,
        )
      }
    } else if (known === null || (known.pid !== running.pid && running.pid !== null)) {
      const found = running
      const destination = activeOf(await xcode($, 'XcodeListRunDestinations', {}, true, found.workspaceId))
      await update($, launched, () => ({ destination, atMs: now, by: 'external', workspaceId: found.workspaceId, pid: found.pid }))
    }
    if (polls % DEVICES_EVERY === 0 && !isBuilding) await loadDestinations($)
  } finally {
    isPolling = false
  }
}

// ── Band actions ────────────────────────────────────────────────────────────

const TOOL: Record<'run' | 'build' | 'test' | 'stop', string> = {
  run: 'RunProject',
  build: 'BuildProject',
  test: 'RunAllTests',
  stop: 'StopProject',
}

// Why a band action may not start now, from a fresh look at this session,
// the registry and Xcode itself; null when it may.
const refusalNow = async ($: EngineInterface, kind: ActivityKind): Promise<string | null> => {
  const isOff = kind === 'stop'
  if (!isOff) {
    await refreshWorkspaces($)
    await readElsewhere($)
    // A build in any of the project's workspaces (the app's window too) holds it.
    const ws = await read($, workspace)
    const isBuilding = await isXcodeBuilding($, ws === null ? [] : watchedOf(ws))
    await update($, isExternalBuild, () => isBuilding)
  }

  return refusal(
    {
      setup: await read($, setup),
      activities: await read($, activities),
      isExternalBuild: await read($, isExternalBuild),
      isTurn: isWorking,
      elsewhere: await read($, elsewhere),
      projectPath: await projectPath($),
      active: await read($, active),
      launched: await read($, launched),
    },
    kind,
  )
}

const act = async ($: EngineInterface, kind: 'run' | 'build' | 'test' | 'stop') => {
  // Read afresh: the drawing may be a poll behind another session or a turn.
  const why = await refusalNow($, kind)
  if (why !== null) return void $.ui.toast(why)
  if (kind !== 'stop') {
    // The picker may be a poll behind: a device unplugged since is gone from a
    // fresh list, and Xcode has moved to another destination by itself. Never
    // run on a device the person did not pick.
    const picked = await read($, active)
    await loadDestinations($)
    const now = await read($, active)
    const isListed = (await read($, destinations)).some(d => d.title === picked)
    if (picked === null || !isListed || now !== picked) {
      return void $.ui.toast(`${picked ?? 'The device'} is no longer available: pick a device and press ${kind === 'test' ? 'Test' : kind === 'build' ? 'Build' : 'Run'} again.`)
    }
  }
  const activity = await begin($, kind, 'band')
  // Two sessions pressing at once both get here: having claimed, look again,
  // and the later claim gives way to the earlier one.
  if (kind !== 'stop') {
    const project = await projectPath($)
    const rival = (await readElsewhere($)).find(
      x =>
        x.startedAtMs <= activity.startedAtMs &&
        (x.project === project || (activity.destination !== null && x.destination === activity.destination && x.kind !== 'build')),
    )
    if (rival !== undefined) {
      await finish($, activity, null)
      return void $.ui.toast(`${rival.branch ? `A session on ${rival.branch}` : 'Another session'} started first.`)
    }
  }
  // Stop ends the app where it runs, which may be the Xcode app's window.
  const target = kind === 'stop' ? (await read($, launched))?.workspaceId : undefined
  const answer = await xcode($, TOOL[kind], {}, true, target)
  // Cancelled meanwhile: the band has moved on, and this answer is stale.
  if (cancelled.delete(activity.id)) return
  await finish($, activity, answer)
  if (kind === 'stop' && answer.isError) $.ui.toast(`Xcode: ${errorText(answer)}`)
  await loadDestinations($)
}

// Stops what the band started: Xcode's Stop (Cmd+.) ends a build, a test run
// or a launch waiting on its device; the band forgets the activity at once.
const cancel = async ($: EngineInterface) => {
  const current = (await read($, activities)).find(a => a.by === 'band')
  if (current === undefined) return
  cancelled.add(current.id)
  await finish($, current, null)
  const stopped = await xcode($, 'StopProject')
  $.ui.toast(stopped.isError ? `Cancelled in the band; Xcode said: ${errorText(stopped)}` : 'Cancelled.')
  await loadDestinations($)
}

const pick = async ($: EngineInterface, title: string) => {
  await touch($)
  const before = await read($, active)
  if (title === before) return
  if (isWorking || (await read($, activities)).length > 0) return void $.ui.toast('The device can change once nothing builds.')
  await update($, active, () => title)
  const a = await xcode($, 'XcodeSwitchRunDestination', { displayTitle: title })
  if (a.isError) {
    await update($, active, () => before)
    $.ui.toast(`Xcode: ${errorText(a)}`)
  } else {
    await update($, active, () => activeOf(a) ?? title)
  }
}

const press = async ($: EngineInterface, action: Action, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']) => {
  await touch($)
  switch (action) {
    case 'refresh':
      await loadDestinations($)
      return
    case 'open-in-xcode': {
      // The project in the Xcode app: its window becomes the workspace the
      // band acts in once Xcode has it open.
      const path = (await read($, workspace))?.path ?? (await projectPath($))
      await sh($, path ? ['open', '-a', 'Xcode', path] : ['open', '-a', 'Xcode'])
      $.clock.after(5_000, () => void refreshWorkspaces($))
      return
    }
    case 'use-xcode-mcp':
      await $.store.set('backend', 'xcode-mcp' satisfies Backend)
      return probe($)
    case 'recheck':
    case 'reconnect':
      server = null
      await setStep($, 'checking')
      return probe($)
    case 'app-store':
      return void (await sh($, ['open', APP_STORE]))
    case 'open-issue':
      return void (await sh($, ['open', DESKTOP_BUG_URL]))
    case 'copy-select':
    case 'copy-enable': {
      const text = action === 'copy-select' ? SELECT_COMMAND : ENABLE_COMMAND
      const copied = await $.ui.copy({ text, surface })
      return void $.ui.toast(copied.isCopied ? 'Copied: paste it in a terminal.' : text)
    }
    case 'open-xcode': {
      const path = await projectPath($)
      await sh($, path ? ['open', '-a', 'Xcode', path] : ['open', '-a', 'Xcode'])
      return
    }
    case 'approve':
    case 'open-project': {
      const path = await projectPath($)
      if (path === null) return
      if (action === 'approve') await update($, setup, (s: Setup) => ({ ...s, isApprovalAsked: true }))
      return openProject($, path)
    }
    case 'run':
    case 'build':
    case 'test':
    case 'stop':
      return act($, action)
    case 'cancel':
      return cancel($)
    case 'hand-over': {
      const o = await read($, last)
      const ws = await read($, workspace)
      if (o === null) return
      await $.prompt.fill({ text: handOver(o, ws?.name ?? 'the project') })
      return
    }
  }
}

// ── Claude's own builds ─────────────────────────────────────────────────────

// What Claude's build must wait for: one the band started, or another
// session's on this same checkout (one build folder, one Xcode workspace).
const isHeld = async ($: EngineInterface): Promise<boolean> => {
  if (await isBandBusy($)) return true
  const project = await projectPath($)
  if (project !== null && (await readElsewhere($)).some(x => x.project === project)) return true
  // A build Xcode runs itself (its window, the headless server).
  const ws = await read($, workspace)
  return isXcodeBuilding($, ws === null ? [] : watchedOf(ws))
}

// Claude's build waits for those, so the two never collide.
const waitForBand = async ($: EngineInterface, signal: AbortSignal): Promise<boolean> => {
  for (let i = 0; i < WAIT_LIMIT_S; i++) {
    if (!(await isHeld($))) return true
    if (signal.aborted) return false
    await sh($, ['/bin/sleep', '1'], 5_000)
  }

  return !(await isHeld($))
}

const STATE_TOOL = 'mcp__xcode-companion__band_state'

// The band's state as one JSON text, for the model's band_state tool.
const snapshot = async ($: EngineInterface): Promise<string> =>
  JSON.stringify(
    {
      setup: await read($, setup),
      workspace: await read($, workspace),
      destination: await read($, active),
      destinations: (await read($, destinations)).map(d => d.title),
      activities: await read($, activities),
      isExternalBuild: await read($, isExternalBuild),
      launched: await read($, launched),
      last: await read($, last),
      isHidden: await read($, isHidden),
      isClaudeWorking: isWorking,
      elsewhere: await read($, elsewhere),
      isPaused: await read($, isPaused),
      phase: await read($, phase),
    },
    null,
    2,
  )

// What the band shows when nothing beneath it draws: an empty Box (or nothing).
const isEmptyBox = (tree: unknown): boolean => {
  if (tree === null || tree === undefined) return true
  if (typeof tree !== 'object') return false
  const node = tree as { type?: string; children?: unknown }
  // With no plugin drawing beneath, next(e) is the engine's own empty band: an
  // engine node in a session, an empty Box under `claude plugin test`.
  if (node.type === 'engine') return true
  const children = Array.isArray(node.children) ? node.children : node.children === undefined ? [] : [node.children]

  return node.type === 'Box' && children.every(c => c === null || c === undefined || c === false || c === '')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'xcode-companion-band', description: 'Show or hide the Xcode Companion band above the prompt' })
    await $.command.register({ name: 'xcode-companion-setup', description: 'Walk through the Xcode Companion setup again' })
    // A tool the band can do without: its refusal never keeps the band from starting.
    await $.tool
      .register({
        name: 'band_state',
        description:
          "Reads the Xcode Companion's state: its setup step, the project's workspace, the run destination picked in the band, what is building and the last build, run or test result. Read-only.",
        inputSchema: { type: 'object', properties: {} },
      })
      .catch(() => undefined)
    // A reload keeps the state but not what was running in the old copy.
    await update($, activities, () => [])
    await update($, isExternalBuild, () => false)
    await update($, elsewhere, () => [])
    await update($, isPaused, () => false)
    await update($, phase, () => null)
    // A result saved before runs read "Launched on …" says what happened, not what runs.
    await update($, last, (o: Outcome | null) =>
      o !== null && o.kind === 'run' && o.summary.startsWith('Running') ? { ...o, summary: o.summary.replace(/^Running/, 'Launched') } : o,
    )
    // The registry other sessions read; without it the band still works, alone.
    try {
      const home = await $.env.get('HOME')
      sessionKey = await $.session.id()
      folder = await $.session.cwd()
      registry = home ? `${home}/.claude/xcode-companion/busy` : null
      const head = await sh($, ['git', '-C', folder, 'rev-parse', '--abbrev-ref', 'HEAD'])
      branch = head.exitCode === 0 && head.stdout.trim() !== '' ? head.stdout.trim() : null
      await withdrawAll($)
    } catch {
      registry = null
    }
    lastActiveMs = await $.clock.now()
    // Off the session's start: the first prompt never waits for Xcode.
    $.clock.after(0, () => void probe($))
    startTimers($)

    return next(e)
  })

  on('command.run', { command: 'xcode-companion-band' }, async $ => {
    await touch($)
    const hidden = !(await read($, isHidden))
    await update($, isHidden, () => hidden)

    return { text: hidden ? 'Xcode band hidden.' : 'Xcode band shown.' }
  })

  on('command.run', { command: 'xcode-companion-setup' }, async $ => {
    await $.store.delete('backend')
    const cwd = await $.session.cwd()
    await $.store.delete(keyFor('project', cwd))
    for (const p of (await read($, setup)).projects) await $.store.delete(keyFor('opened', p))
    await update($, workspace, () => null)
    await update($, isHidden, () => false)
    server = null
    await setStep($, 'checking')
    await probe($)

    return { text: 'Xcode Companion setup started over.' }
  })

  // The person is back (the session reopened in a window, a phone, a terminal).
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    await touch($)

    return attached
  })

  on('session.end', async ($, e, next) => {
    await withdrawAll($)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isWorking = true
    await touch($)
    await update($, isExternalBuild, () => false)
    await syncSpinner($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      isWorking = false
      // Polls rest during a turn: Xcode opened or closed meanwhile shows now.
      if ((await read($, setup)).step === 'ready') {
        await refreshWorkspaces($)
        await loadDestinations($)
      }
    }

    return done
  })

  // Claude's builds, runs and tests, through Xcode's MCP server or xcodebuild:
  // shown while they run, held while the band's own build runs.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool === STATE_TOOL) return { result: await snapshot($) }
    const mcp = xcodeTool(tool)
    const command = (e as { command?: unknown }).command
    const shell = tool === 'Bash' && typeof command === 'string' ? shellBuild(command) : null
    const kind = mcp?.kind ?? shell
    if (kind === null || kind === undefined) {
      const answered = await next(e)
      // Claude listed the destinations: the band takes the fresh list too.
      if (mcp?.name === 'XcodeListRunDestinations' && answered.result !== undefined) {
        await applyDestinations($, readAnswer(answered.result, answered.isError === true))
      }
      return answered
    }

    // Stop never waits: it is how a run stuck on its device is ended.
    if (kind !== 'stop' && (await isHeld($))) {
      if (!(await waitForBand($, next.signal))) {
        return { deny: 'A build in Xcode, from the Xcode band or from another session on this checkout is still running. Wait for it to finish, then try again.' }
      }
    }
    if (kind === 'switch') {
      const answered = await next(e)
      if (answered.result !== undefined) {
        const now = activeOf(readAnswer(answered.result))
        if (now !== null) await update($, active, () => now)
      }
      return answered
    }

    const target = (e as { workspaceIdentifier?: unknown }).workspaceIdentifier
    const activity = await begin($, kind, 'claude', shell !== null, typeof target === 'string' ? target : undefined)
    let answer: Answer | null = null
    try {
      const answered = await next(e)
      // xcodebuild's output is no MCP answer: only a failure is told apart.
      answer = answered.result === undefined ? null : shell !== null ? { json: null, text: '', isError: answered.isError === true } : readAnswer(answered.result, answered.isError === true)
      return answered
    } finally {
      await finish($, activity, answer)
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId !== undefined || (await read($, isHidden))) return next(e)
    const s = await read($, setup)
    // Outside an Xcode project the band stays out of the way entirely.
    if (s.step === 'no-project' || (s.step === 'checking' && s.projects.length === 0)) return next(e)

    const ws = await read($, workspace)
    const list = await read($, destinations)
    const current = await read($, active)
    const step = await read($, frame)
    const view = bandView({
      setup: s,
      project: ws?.name ?? (s.projects.length === 1 ? baseName(s.projects[0] ?? '') : null),
      scheme: ws?.scheme ?? null,
      active: current,
      activities: await read($, activities),
      isExternalBuild: await read($, isExternalBuild),
      launched: await read($, launched),
      last: await read($, last),
      isTurn: e.props.isWorking || isWorking,
      via: ws === null ? null : ws.id.startsWith('windowtab-') ? 'window' : 'headless',
      elsewhere: await read($, elsewhere),
      projectPath: ws?.path ?? (s.projects.length === 1 ? (s.projects[0] ?? null) : null),
      isPaused: await read($, isPaused),
      phase: await read($, phase),
      now: await $.clock.now(),
      spinner: SPINNER[step % SPINNER.length] ?? '',
    })

    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const Select = e.surface === 'mobile' ? null : $.ui.resolve(e).Select
    // The desktop draws "primary" white; the native rows above the prompt use its default gray button.
    const main = e.surface === 'desktop' ? 'secondary' : 'primary'
    const color =
      view.tone === 'busy' ? 'suggestion' : view.tone === 'ok' ? 'success' : view.tone === 'error' ? 'error' : view.tone === 'warn' ? 'warning' : undefined
    // A desktop draws in proportional type, where a band without vertical padding reads as cramped.
    const isRoomy = e.surface !== 'terminal'
    const options = list.some(d => d.title === current) || current === null ? list : [{ title: current, isSimulator: true, os: null } as Destination, ...list]

    // The band is one slot that every plugin's hook draws into in turn: ours
    // goes on top of whatever the plugins beneath (and the engine) draw.
    const below = await next(e)
    const ours = (
      <Box alignItems="center" gap={2} paddingY={isRoomy ? 0.5 : 0} width={isRoomy ? undefined : e.props.bodyColumns}>
        <Box flexGrow={1} flexShrink={1} minWidth={0} gap={1}>
          <Box flexShrink={0}>
            <Text color={color} dimColor={color === undefined}>
              ⚒
            </Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color={color} dimColor={color === undefined} wrap="wrap">
              {view.headline}
            </Text>
            {view.detail !== null && (
              <Text dimColor wrap="wrap">
                {view.detail}
              </Text>
            )}
            {view.where !== null && (
              <Text dimColor wrap="wrap">
                {view.where}
              </Text>
            )}
            {view.note !== null &&
              (view.isNoteUrgent ? (
                <Text color="warning" wrap="wrap">
                  {view.note}
                </Text>
              ) : (
                <Text dimColor wrap="wrap">
                  {view.note}
                </Text>
              ))}
          </Box>
        </Box>
        <Box flexShrink={0} alignItems="center" gap={1}>
          {view.busy !== null && (
            <Text color="suggestion" bold>
              {view.busy}
            </Text>
          )}
          {view.waiting !== null && <Text dimColor>{view.waiting}</Text>}
          {view.hasProjectPicker && Select !== null && (
            <Select
              key="xcode-project"
              label="Project"
              options={s.projects.map(p => ({ value: p, label: baseName(p) }))}
              onSelect={value =>
                void (async () => {
                  await touch($)
                  await $.store.set(keyFor('project', await $.session.cwd()), value)
                  await probe($)
                })()
              }
            />
          )}
          {view.hasPicker && Select !== null && options.length > 0 && (
            <Select
              key="xcode-destination"
              options={options.map(d => ({ value: d.title, label: d.isSimulator ? d.title : `${d.title} (device)` }))}
              value={current ?? undefined}
              onSelect={value => void pick($, value)}
            />
          )}
          {view.hasPicker && Select === null && current !== null && <Text dimColor>{current}</Text>}
          {view.actions.map((action, i) => (
            <Button
              key={`xcode-${action}`}
              label={ACTION_LABEL[action]}
              variant={i === 0 ? main : undefined}
              onPress={() => void press($, action, e.surface)}
            />
          ))}
        </Box>
      </Box>
    )

    if (isEmptyBox(below)) return ours

    // Another plugin's band follows ours: a thin rule keeps the two apart, at
    // the band's columns on a terminal, the surface's own rule elsewhere.
    return (
      <Box flexDirection="column">
        {ours}
        {isRoomy ? (
          <Markdown key="xcode-divider" text="---" dimColor />
        ) : (
          <Text key="xcode-divider" dimColor wrap="truncate">
            {'─'.repeat(e.props.bodyColumns)}
          </Text>
        )}
        {below}
      </Box>
    )
  })
}
