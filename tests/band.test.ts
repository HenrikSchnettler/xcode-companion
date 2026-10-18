// The band above the prompt, driven through the engine on each surface that
// draws it. The host (processes, the folder, Xcode's MCP server) is answered by
// the test, so this covers the mod's own hooks, rules and drawing.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { outcomeOf, readAnswer } from '../hooks/model'

const T0 = 1_800_000_000_000
const SURFACES = ['terminal', 'desktop'] as const
const PROJECT = '/p/App.xcodeproj'
const BAND = {
  plugin: 'xcode-companion',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 12, contentRows: 2 },
    view: {},
  },
} as const

type Json = Record<string, unknown>
const DESTINATIONS: Json = {
  activeDestinationDisplayTitle: 'iPhone 18 Pro',
  destinations: [
    { displayTitle: 'iPhone 18 Pro', group: 'Simulators', isEligible: true, isGenericDevice: false, isSimulator: true, osVersion: '27.0' },
    { displayTitle: 'My iPhone', group: 'Devices', isEligible: true, isGenericDevice: false, isSimulator: false, osVersion: '27.0' },
    { displayTitle: 'Any iOS Device (arm64)', group: 'Build', isEligible: true, isGenericDevice: true, isSimulator: false },
  ],
}

type Host = {
  hasBridge: boolean
  isXcodeOpen: boolean
  /** This Xcode has `xcrun mcp-server`: it serves MCP with the app closed (Xcode 27). */
  isHeadlessCapable: boolean
  /** `mcp-server status`: whether agents may use Xcode's tools. */
  isPermissionOn: boolean
  /** `xcode-select -p`, and whether Spotlight finds an Xcode at all. */
  selected: string
  isXcodeInstalled: boolean
  /** What `$.mcp.connect('xcode')` answers. */
  connect: { isConnected: true; server: string } | { isConnected: false; reason: string; message: string }
  entries: { name: string; kind: 'dir' | 'file' }[]
  answers: Record<string, Json | ((args: Json) => Json | Promise<Json>)>
  errors: Record<string, string>
  /** Calls the engine refuses: `$.mcp.call` rejects with the reason. */
  refusals: Record<string, string>
  calls: { tool: string; args: Json; server?: string }[]
  fills: string[]
  below: RenderElement
  onSleep: () => void
  /** Commands the band handed to `open`. */
  opened: string[][]
  /** Workspaces the band closed with XcodeCloseWorkspace: gone from later listings. */
  closed: string[]
  /** What the build services' children look like: busy means Xcode is asked. */
  isBuildServiceBusy: boolean
  /** Paths the band removed with `rm -f`. */
  removed: string[]
  /** `devicectl … lockState`: the device asks for its passcode. */
  isDeviceLocked: boolean
  /** The shared registry of builds across sessions: file name to JSON text. */
  registry: Map<string, string>
}

const REGISTRY = '/home/.claude/xcode-companion/busy'

// The host the mod talks to; `over` changes the defaults of a ready Xcode 27.
const host = (on: On, over: Partial<Host> = {}, store: Record<string, unknown> = { backend: 'xcode-mcp' }) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, store)
  const seen: Host = {
    hasBridge: true,
    isXcodeOpen: true,
    isHeadlessCapable: true,
    isPermissionOn: true,
    selected: '/Applications/Xcode.app/Contents/Developer',
    isXcodeInstalled: true,
    connect: { isConnected: true, server: 'xcode' },
    entries: [{ name: 'App.xcodeproj', kind: 'dir' }],
    answers: {
      XcodeListWorkspaces: { message: `* workspaceIdentifier: workspace-1, workspacePath: ${PROJECT}` },
      XcodeListRunDestinations: DESTINATIONS,
      XcodeOpenWorkspace: { workspaceIdentifier: 'workspace-1', activeScheme: 'App' },
      GetBuildLog: { buildIsRunning: false },
    },
    errors: {},
    refusals: {},
    calls: [],
    fills: [],
    below: { type: 'Box', children: [] } as RenderElement,
    onSleep: () => undefined,
    opened: [],
    closed: [],
    isBuildServiceBusy: true,
    removed: [],
    isDeviceLocked: false,
    registry: new Map(),
    ...over,
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/p' }))
  on('session.id', () => ({ value: 'this-session' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__xcode-companion__${e.name}` } }) as never)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', () => seen.below)
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home' : undefined }))
  on('fs.read', (_$, e) => ({ value: seen.registry.get(e.path.replace(`${REGISTRY}/`, '')) ?? '' }))
  on('fs.write', (_$, e) => {
    if (e.path.startsWith(`${REGISTRY}/`)) seen.registry.set(e.path.replace(`${REGISTRY}/`, ''), e.text)
    return { value: undefined }
  })
  on('fs.list', (_$, e) => {
    const path = String((e as { path?: unknown }).path ?? '')
    if (path === REGISTRY) return { value: [...seen.registry.keys()].map(name => ({ name, kind: 'file' as const, size: 0 })) }
    // Inside a bundle: a real project holds its pbxproj, an empty leftover nothing.
    if (path.endsWith('.xcodeproj')) {
      return { value: path.endsWith('Empty.xcodeproj') ? [] : [{ name: 'project.pbxproj', kind: 'file', size: 0 }] }
    }
    if (path.endsWith('.xcworkspace')) return { value: [{ name: 'contents.xcworkspacedata', kind: 'file', size: 0 }] }
    return { value: seen.entries.map(x => ({ ...x, size: 0 })) }
  })
  on('prompt.fill', (_$, e) => {
    seen.fills.push(e.text)
    return { isFilled: true }
  })
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    if (e.argv[0] === '/bin/sleep') seen.onSleep()
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const fail = () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'open') {
      seen.opened.push([...e.argv])
      return ok()
    }
    if (argv.startsWith('xcrun devicectl device info lockState')) {
      return ok(JSON.stringify({ result: { passcodeRequired: seen.isDeviceLocked, unlockedSinceBoot: true }, info: { outcome: 'success' } }))
    }
    if (e.argv[0] === 'sh' && String(e.argv[2]).includes('SWBBuildService')) return ok(seen.isBuildServiceBusy ? '4242\n' : '')
    if (e.argv[0] === 'rm') {
      seen.removed.push(String(e.argv[2]))
      seen.registry.delete(String(e.argv[2]).replace(`${REGISTRY}/`, ''))
      return ok()
    }
    if (e.argv[0] === 'git') return ok('main\n')
    if (argv === 'xcodebuild -version') {
      if (!seen.isXcodeInstalled || seen.selected.includes('CommandLineTools')) return fail()
      return ok(!seen.hasBridge ? 'Xcode 16.2\n' : seen.isHeadlessCapable ? 'Xcode 27.0\nBuild version 27A266a\n' : 'Xcode 26.3\n')
    }
    if (argv === 'pgrep -x Xcode') return seen.isXcodeOpen ? ok('1') : fail()
    if (argv === 'xcrun --find mcpbridge') return seen.hasBridge && !seen.selected.includes('CommandLineTools') ? ok('/x/mcpbridge') : fail()
    if (argv === 'xcrun --find mcp-server') return seen.hasBridge && seen.isHeadlessCapable ? ok('/x/mcp-server') : fail()
    if (argv.startsWith('xcrun mcp-server status')) return ok(JSON.stringify({ running: true, permission: { enabled: seen.isPermissionOn } }))
    if (argv === 'xcode-select -p') return ok(seen.selected)
    if (argv.startsWith('mdfind')) return ok(seen.isXcodeInstalled ? '/Applications/Xcode.app\n' : '')
    return ok()
  })

  on('mcp.connect', () => ({ value: seen.connect }) as never)
  on('mcp.call', async (_$, e) => {
    seen.calls.push({ tool: e.tool, args: e.args, server: e.server })
    const refused = seen.refusals[e.tool]
    if (refused !== undefined) return { deny: refused } as never
    const error = seen.errors[e.tool]
    if (error !== undefined) return { value: { content: [{ type: 'text', text: error }], isError: true } }
    if (e.tool === 'XcodeCloseWorkspace') seen.closed.push(String(e.args.workspaceIdentifier))
    const answer = seen.answers[e.tool]
    let json = typeof answer === 'function' ? await answer(e.args) : (answer ?? {})
    // A closed workspace is gone from the listings after it.
    if (e.tool === 'XcodeListWorkspaces' && typeof json.message === 'string') {
      const lines = json.message.split('\n').filter(l => !seen.closed.some(id => l.includes(`${id},`)))
      json = { ...json, message: lines.join('\n') }
    }
    return { value: { content: [{ type: 'text', text: JSON.stringify(json) }], isError: false } }
  })

  return { clock, seen }
}

const start = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }) => {
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await clock.advance(1)
}

test('ready: names the app, offers the device picker, Run and Test, devices first', async ($, on) => {
  const { clock } = host(on)
  await start($, clock)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'App is ready to run' })).toBeDefined()
    expect(await ui.find({ key: 'xcode-run' })).toMatchObject({ props: { label: 'Run' } })
    expect(await ui.find({ key: 'xcode-test' })).toBeDefined()
    expect(await ui.find({ key: 'xcode-stop' })).toBeUndefined()
    const picker = await ui.find({ key: 'xcode-destination' })
    expect(picker).toMatchObject({ props: { value: 'iPhone 18 Pro' } })
    const options = (picker?.props as { options: { value: string }[] }).options.map(o => o.value)
    expect(options).toEqual(['My iPhone', 'iPhone 18 Pro'])
    expect(await ui.find({ type: 'Text', text: /^─+$/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('outside an Xcode project the band draws nothing of its own', async ($, on) => {
  const { clock } = host(on, { entries: [{ name: 'src', kind: 'dir' }] })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Xcode|ready/ })).toBeUndefined()
  await ui.unmount()
})

test('onboarding: picks the backend first, then sets up by itself', async ($, on) => {
  const { clock } = host(on, {}, {})
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /App found · pick what builds it/ })).toBeDefined()
  expect(await ui.find({ key: 'xcode-run' })).toBeUndefined()
  await ui.press({ key: 'xcode-use-xcode-mcp' })
  expect(await ui.find({ type: 'Text', text: 'App is ready to run' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-run' })).toBeDefined()
  await ui.unmount()
})

test('an Xcode without mcpbridge is too old, and says from which version', async ($, on) => {
  const { clock } = host(on, { hasBridge: false })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Xcode 16.2 has no MCP server' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /26\.3/ })).toBeDefined()
  expect(await ui.find({ key: 'xcode-recheck' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-run' })).toBeUndefined()
  await ui.unmount()
})

test('not approved yet: asks Xcode by opening the project, then is ready', async ($, on) => {
  const { clock, seen } = host(on, {
    errors: { XcodeListWorkspaces: "This agent isn't approved to use Xcode's tools yet. Call XcodeOpenWorkspace first." },
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Xcode has to approve the band' })).toBeDefined()
  await ui.press({ key: 'xcode-approve' })
  expect(seen.calls.some(c => c.tool === 'XcodeOpenWorkspace' && c.args.path === PROJECT)).toBe(true)
  expect(await ui.find({ key: 'xcode-run' })).toBeDefined()
  await ui.unmount()
})

test("during Claude's turn Run and Test are gone and Stop stays", async ($, on) => {
  const { clock } = host(on, { answers: { ...hostAnswers(), RunProject: { buildErrors: [], processIdentifier: 2234, runResult: 'The app was launched successfully.' } } })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'xcode-run' })
  expect(await ui.find({ type: 'Text', text: 'Running on iPhone 18 Pro' })).toBeDefined()
  await ui.unmount()

  const busy = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: true } })
  expect(await busy.find({ key: 'xcode-run' })).toBeUndefined()
  expect(await busy.find({ key: 'xcode-test' })).toBeUndefined()
  expect(await busy.find({ key: 'xcode-destination' })).toBeUndefined()
  expect(await busy.find({ key: 'xcode-stop' })).toBeDefined()
  // The app runs: Stop is all there is, turn or not.
  await busy.unmount()
})

test('a failed band build lists its errors and hands them to Claude on request', async ($, on) => {
  const { clock, seen } = host(on, {
    answers: {
      ...hostAnswers(),
      RunProject: { buildErrors: [{ message: 'Cannot find Foo in scope' }], runResult: 'The build failed.' },
    },
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'xcode-run' })
  expect(await ui.find({ type: 'Text', text: 'Run failed · 1 error' })).toBeDefined()
  await ui.press({ key: 'xcode-hand-over' })
  expect(seen.fills[0]).toMatch(/Cannot find Foo in scope/)
  await ui.unmount()
})

test("Claude's Xcode build shows while it runs, with no controls", async ($, on) => {
  const { clock } = host(on)
  let release: () => void = () => undefined
  const held = new Promise<void>(r => (release = r))
  on('tool.call', async () => {
    await held
    return { result: { content: [{ type: 'text', text: JSON.stringify({ buildResult: 'The build succeeded' }) }] } }
  })
  await start($, clock)
  const call = $.tool.call({ tool: 'mcp__xcode__BuildProject' } as never)
  await clock.advance(1)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Claude is building for iPhone 18 Pro' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-run' })).toBeUndefined()
  release()
  await call
  expect(await ui.find({ type: 'Text', text: 'Build succeeded' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-run' })).toBeDefined()
  await ui.unmount()
})

test("another plugin's band below gets a rule between", async ($, on) => {
  const { clock } = host(on, {
    below: { type: 'Text', children: ['other band'] } as RenderElement,
  })
  await start($, clock)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'App is ready to run' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'other band' })).toBeDefined()
    if (surface === 'terminal') expect(await ui.findAll({ type: 'Text', text: /^─+$/ })).toHaveLength(1)
    else expect(await ui.findAll({ type: 'Markdown', text: '---' })).toHaveLength(1)
    await ui.unmount()
  }
})

function hostAnswers(): Record<string, Json> {
  return {
    XcodeListWorkspaces: { message: `* workspaceIdentifier: workspace-1, workspacePath: ${PROJECT}` },
    XcodeListRunDestinations: DESTINATIONS,
    GetBuildLog: { buildIsRunning: false },
  }
}

test("Claude's Xcode build is held while the band's own run is going, then goes through", async ($, on) => {
  let release: () => void = () => undefined
  const held = new Promise<void>(r => (release = r))
  const ran: string[] = []
  const { clock, seen } = host(on, {
    answers: {
      ...hostAnswers(),
      RunProject: async () => {
        await held
        return { buildErrors: [], processIdentifier: 2234, runResult: 'The app was launched successfully.' }
      },
    },
  })
  let sleeps = 0
  seen.onSleep = () => void (sleeps += 1)
  on('tool.call', (_$, e) => {
    ran.push(String(e.tool))
    return { result: { content: [{ type: 'text', text: JSON.stringify({ buildResult: 'The build succeeded' }) }] } }
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const pressed = ui.press({ key: 'xcode-run' })
  for (let i = 0; i < 50 && (await ui.find({ type: 'Text', text: /^Running App/ })) === undefined; i++) await clock.advance(10)
  expect(await ui.find({ type: 'Text', text: 'Running App for iPhone 18 Pro' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-run' })).toBeUndefined()

  // The band's run never ends while Claude waits: past the limit the call is refused, never run beside it.
  const refused = await $.tool.call({ tool: 'mcp__xcode__BuildProject' } as never)
  expect(JSON.stringify(refused)).toMatch(/is still running/)
  expect(ran).toEqual([])
  expect(sleeps).toBeGreaterThan(100)

  release()
  await pressed
  for (let i = 0; i < 50 && (await ui.find({ type: 'Text', text: 'Running on iPhone 18 Pro' })) === undefined; i++) await clock.advance(10)
  // The band's run launched the app: Stop, not Run, until it ends.
  expect(await ui.find({ key: 'xcode-stop' })).toBeDefined()
  await $.tool.call({ tool: 'mcp__xcode__BuildProject' } as never)
  expect(ran).toEqual(['mcp__xcode__BuildProject'])
  await ui.unmount()
})

test('band_state reads the band for the model', async ($, on) => {
  const { clock } = host(on)
  await start($, clock)
  const answered = await $.tool.call({ tool: 'mcp__xcode-companion__band_state' } as never)
  const text = JSON.stringify(answered)
  expect(text).toMatch(/\\"step\\": \\"ready\\"/)
  expect(text).toMatch(/iPhone 18 Pro/)
})

test('an empty .xcodeproj left behind is no project', async ($, on) => {
  const { clock } = host(on, {
    entries: [
      { name: 'App.xcodeproj', kind: 'dir' },
      { name: 'Empty.xcodeproj', kind: 'dir' },
    ],
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'App is ready to run' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-project' })).toBeUndefined()
  await ui.unmount()
})

test("the desktop app's auto-mode refusal reads as that bug, and Check again recovers", async ($, on) => {
  const { clock, seen } = host(on, {
    refusals: {
      XcodeListWorkspaces:
        'The server-side auto mode classifier gave no verdict for mcp__xcode__XcodeListWorkspaces: the request that produced this action did not ask for one',
    },
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: "The desktop app's auto mode blocks the band" })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /#101884/ })).toBeDefined()
  expect(await ui.find({ key: 'xcode-open-issue' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-run' })).toBeUndefined()
  // Out of auto mode the same call goes through.
  seen.refusals = {}
  await ui.press({ key: 'xcode-recheck' })
  expect(await ui.find({ type: 'Text', text: 'App is ready to run' })).toBeDefined()
  await ui.unmount()
})

test('a refused Run in auto mode switches the band to the same explanation', async ($, on) => {
  const { clock, seen } = host(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  seen.refusals = { RunProject: 'The server-side auto mode classifier gave no verdict for mcp__xcode__RunProject' }
  await ui.press({ key: 'xcode-run' })
  expect(await ui.find({ type: 'Text', text: "The desktop app's auto mode blocks the band" })).toBeDefined()
  await ui.unmount()
})

test('a connected device comes first, the Mac last', async ($, on) => {
  const { clock } = host(on, {
    answers: {
      ...hostAnswers(),
      XcodeListRunDestinations: {
        activeDestinationDisplayTitle: 'iPhone 18 Pro',
        activeSchemeName: 'App',
        destinations: [
          { displayTitle: 'iPhone 18 Pro', group: 'Simulators', isEligible: true, isSimulator: true, platformIdentifier: 'com.apple.platform.iphonesimulator' },
          { displayTitle: 'My Mac (Designed for iPad)', group: 'Devices', isEligible: true, isSimulator: false, platformIdentifier: 'com.apple.platform.macosx' },
          { displayTitle: 'My iPhone', group: 'Devices', isEligible: true, isSimulator: false, platformIdentifier: 'com.apple.platform.iphoneos' },
        ],
      },
    },
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const picker = await ui.find({ key: 'xcode-destination' })
  const options = (picker?.props as { options: { value: string }[] }).options.map(o => o.value)
  expect(options).toEqual(['My iPhone', 'iPhone 18 Pro', 'My Mac (Designed for iPad)'])
  await ui.unmount()
})

// RunProject's answers as Xcode 27 gives them.
const runAnswer = (json: Record<string, unknown>) => readAnswer({ content: [{ type: 'text', text: JSON.stringify(json) }], isError: false })

test('a run is Running only once Xcode says the app launched', () => {
  const launched = outcomeOf(
    'run',
    'band',
    runAnswer({ buildErrors: [], elapsedTime: 110.3, processIdentifier: 2234, runResult: 'The app was launched successfully.' }),
    'My iPhone',
    0,
    110_300,
  )
  expect(launched).toMatchObject({ isOk: true, summary: 'Launched on My iPhone' })

  const failedBuild = outcomeOf(
    'run',
    'band',
    runAnswer({
      buildErrors: [{ message: 'The Metal Toolchain was not installed and could not compile the Metal source files.' }],
      elapsedTime: 3.4,
      runResult: 'The build failed.',
    }),
    'My iPhone',
    0,
    3_400,
  )
  expect(failedBuild).toMatchObject({ isOk: false, summary: 'Run failed · 1 error' })
  expect(failedBuild.issues[0]).toMatch(/Metal Toolchain/)

  // Neither a process nor the launch sentence: not counted as running.
  const silent = outcomeOf('run', 'band', runAnswer({ buildErrors: [], elapsedTime: 2 }), null, 0, 2_000)
  expect(silent).toMatchObject({ isOk: false, summary: 'The app did not launch' })

  // A failure told only in the sentence, errors as plain strings too.
  expect(outcomeOf('run', 'band', runAnswer({ runResult: 'Could not launch App' }), null, 0, 1).isOk).toBe(false)
  expect(outcomeOf('build', 'band', runAnswer({ errors: ['Foo.swift:3: missing return'] }), null, 0, 1)).toMatchObject({
    isOk: false,
    summary: 'Build failed · 1 error',
  })
})

test('an unplugged device leaves the picker within a few idle polls', async ($, on) => {
  const { clock, seen } = host(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const options = async () =>
    ((await ui.find({ key: 'xcode-destination' }))?.props as { options: { value: string }[] }).options.map(o => o.value)
  expect(await options()).toContain('My iPhone')

  // Unplugged: Xcode drops the device and moves the active destination off it.
  seen.answers.XcodeListRunDestinations = {
    activeDestinationDisplayTitle: 'iPhone 18 Pro',
    destinations: [{ displayTitle: 'iPhone 18 Pro', group: 'Simulators', isEligible: true, isSimulator: true }],
  }
  for (let i = 0; i < 4; i++) await clock.advance(4_000)
  expect(await options()).toEqual(['iPhone 18 Pro'])
  expect(await ui.find({ key: 'xcode-destination' })).toMatchObject({ props: { value: 'iPhone 18 Pro' } })
  await ui.unmount()
})

// It steps through 90 s of mocked time, each timer on the way: more than the default 5 s.
test('Cancel stops a band run that waits on its device, and its late answer is dropped', { timeoutMs: 30_000 }, async ($, on) => {
  let release: () => void = () => undefined
  const held = new Promise<void>(r => (release = r))
  const { clock, seen } = host(on, {
    answers: {
      ...hostAnswers(),
      RunProject: async () => {
        await held
        return { buildErrors: [], processIdentifier: 7, runResult: 'The app was launched successfully.' }
      },
      StopProject: {},
    },
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const pressed = ui.press({ key: 'xcode-run' })
  for (let i = 0; i < 50 && (await ui.find({ key: 'xcode-cancel' })) === undefined; i++) await clock.advance(10)
  expect(await ui.find({ key: 'xcode-cancel' })).toBeDefined()

  // After a while the band says what to look at.
  await clock.advance(91_000)
  expect(await ui.find({ type: 'Text', text: /is iPhone 18 Pro unlocked and connected/ })).toBeDefined()

  await ui.press({ key: 'xcode-cancel' })
  expect(seen.calls.some(c => c.tool === 'StopProject')).toBe(true)
  expect(await ui.find({ key: 'xcode-run' })).toBeDefined()
  release()
  await pressed
  expect(await ui.find({ type: 'Text', text: /^Running on/ })).toBeUndefined()
  await ui.unmount()
})

test('Run refuses a device that was unplugged since the picker last refreshed', async ($, on) => {
  const { clock, seen } = host(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'xcode-destination' })).toMatchObject({ props: { value: 'iPhone 18 Pro' } })
  // Gone before any poll noticed: Xcode moved to another destination.
  seen.answers.XcodeListRunDestinations = {
    activeDestinationDisplayTitle: 'iPhone 17',
    destinations: [{ displayTitle: 'iPhone 17', group: 'Simulators', isEligible: true, isSimulator: true }],
  }
  await ui.press({ key: 'xcode-run' })
  expect(seen.calls.some(c => c.tool === 'RunProject')).toBe(false)
  expect(await ui.find({ key: 'xcode-destination' })).toMatchObject({ props: { value: 'iPhone 17' } })
  await ui.unmount()
})

test("Claude's Stop goes through at once while the band's run hangs", async ($, on) => {
  const held = new Promise<void>(() => undefined)
  const ran: string[] = []
  const { clock, seen } = host(on, {
    answers: {
      ...hostAnswers(),
      RunProject: async () => {
        await held
        return {}
      },
    },
  })
  let sleeps = 0
  seen.onSleep = () => void (sleeps += 1)
  on('tool.call', (_$, e) => {
    ran.push(String(e.tool))
    return { result: { content: [{ type: 'text', text: '{}' }] } }
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  void ui.press({ key: 'xcode-run' })
  for (let i = 0; i < 50 && (await ui.find({ key: 'xcode-cancel' })) === undefined; i++) await clock.advance(10)
  await $.tool.call({ tool: 'mcp__xcode__StopProject' } as never)
  expect(ran).toEqual(['mcp__xcode__StopProject'])
  expect(sleeps).toBe(0)
})

// Another session's entry in the shared registry, alive by its heartbeat.
const entry = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    project: PROJECT,
    destination: 'iPhone 18 Pro',
    kind: 'build',
    by: 'band',
    branch: 'feature/other',
    folder: '/p',
    startedAtMs: T0,
    heartbeatMs: T0,
    ...over,
  })

test('polling pauses after ten idle minutes and starts again on Refresh', async ($, on) => {
  const { clock, seen } = host(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const polls = () => seen.calls.filter(c => c.tool === 'GetBuildLog').length
  await clock.advance(8_000)
  expect(polls()).toBeGreaterThan(0)

  await clock.advance(11 * 60_000)
  const atPause = polls()
  await clock.advance(60_000)
  expect(polls()).toBe(atPause)
  expect(await ui.find({ type: 'Text', text: /Paused while idle/ })).toBeDefined()
  expect(await ui.find({ key: 'xcode-refresh' })).toBeDefined()

  await ui.press({ key: 'xcode-refresh' })
  await clock.advance(8_000)
  expect(polls()).toBeGreaterThan(atPause)
  expect(await ui.find({ type: 'Text', text: /Paused while idle/ })).toBeUndefined()
  await ui.unmount()
})

test('another session building this checkout shows here, with nothing to press', async ($, on) => {
  const { clock, seen } = host(on)
  seen.registry.set('other-session--band-1.json', entry())
  await start($, clock)
  await clock.advance(4_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Another session is building for iPhone 18 Pro' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /another session on feature\/other/ })).toBeDefined()
  // Its own row says where Xcode works, nothing else.
  expect(await ui.find({ type: 'Text', text: 'Headless Xcode (no window)' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-run' })).toBeUndefined()
  expect(await ui.find({ key: 'xcode-cancel' })).toBeUndefined()

  // Done there: its entry goes, and Run is back on the next poll.
  seen.registry.clear()
  await clock.advance(4_000)
  expect(await ui.find({ key: 'xcode-run' })).toBeDefined()
  await ui.unmount()
})

test('a device another worktree runs on cannot be used, another one can be picked', async ($, on) => {
  const { clock, seen } = host(on)
  seen.registry.set('other-session--band-1.json', entry({ project: '/w/App.xcodeproj', kind: 'run', folder: '/w', branch: null }))
  await start($, clock)
  await clock.advance(4_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'iPhone 18 Pro is in use by another session in w · pick another device' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-run' })).toBeUndefined()
  expect(await ui.find({ key: 'xcode-destination' })).toBeDefined()
  await ui.unmount()
})

test("a run from the band is in the registry while it runs, and gone after", async ($, on) => {
  let release: () => void = () => undefined
  const held = new Promise<void>(r => (release = r))
  const { clock, seen } = host(on, {
    answers: {
      ...hostAnswers(),
      RunProject: async () => {
        await held
        return { buildErrors: [], processIdentifier: 7, runResult: 'The app was launched successfully.' }
      },
    },
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const pressed = ui.press({ key: 'xcode-run' })
  for (let i = 0; i < 50 && seen.registry.size === 0; i++) await clock.advance(10)
  const [name, text] = [...seen.registry.entries()][0] ?? []
  expect(name).toMatch(/--band-\d+\.json$/)
  expect(JSON.parse(text ?? '{}')).toMatchObject({ project: PROJECT, kind: 'run', destination: 'iPhone 18 Pro', branch: 'main' })
  release()
  await pressed
  for (let i = 0; i < 50 && seen.registry.size > 0; i++) await clock.advance(10)
  expect(seen.registry.size).toBe(0)
  await ui.unmount()
})

test('an entry whose session stopped beating is stale: ignored and removed', async ($, on) => {
  const { clock, seen } = host(on)
  seen.registry.set('gone-session--band-1.json', entry({ heartbeatMs: T0 - 5 * 60_000 }))
  await start($, clock)
  await clock.advance(4_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'xcode-run' })).toBeDefined()
  expect(seen.registry.has('gone-session--band-1.json')).toBe(false)
  await ui.unmount()
})

test('Run refuses when another session took this checkout since the last poll', async ($, on) => {
  const { clock, seen } = host(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  seen.registry.set('other-session--claude-1.json', entry({ by: 'claude', kind: 'test' }))
  await ui.press({ key: 'xcode-run' })
  expect(seen.calls.some(c => c.tool === 'RunProject')).toBe(false)
  await ui.unmount()
})

// The project open twice: the headless server's workspace and the Xcode app's window.
const TWO_OPEN = {
  message: `* workspaceIdentifier: workspace-1, workspacePath: ${PROJECT}\n* workspaceIdentifier: windowtab-9, workspacePath: ${PROJECT}`,
}
const launchOf = (state: string, pid = 2601) => ({
  launchSessionInfo: `Launch Session: App, ref: 76d681d980, PID: ${pid}, State: ${state}`,
  totalCount: 0,
  units: [],
})

test("with the project open in the Xcode app, the band closes the headless copy and acts in the window", async ($, on) => {
  const { clock, seen } = host(on, { answers: { ...hostAnswers(), XcodeListWorkspaces: TWO_OPEN } })
  await start($, clock)
  // Workspaces are compared every 8 s.
  await clock.advance(8_000)
  expect(seen.closed).toEqual(['workspace-1'])
  await clock.advance(8_000)
  // Closed once; from then on only the window is asked.
  expect(seen.closed).toEqual(['workspace-1'])
  const latest = seen.calls.filter(c => c.tool === 'GetBuildLog').slice(-2).map(c => c.args.workspaceIdentifier)
  expect(latest).toEqual(['windowtab-9', 'windowtab-9'])
})

test('a headless copy still running something is left open', async ($, on) => {
  const { clock, seen } = host(on, {
    answers: {
      ...hostAnswers(),
      XcodeListWorkspaces: TWO_OPEN,
      GetBuildLog: args => ({ buildIsRunning: args.workspaceIdentifier === 'workspace-1' }),
    },
  })
  await start($, clock)
  await clock.advance(8_000)
  expect(seen.closed).toEqual([])
})

test('with the Xcode window closed, the band opens the project headless again', async ($, on) => {
  let isWindowOpen = true
  const { clock, seen } = host(on, {
    answers: {
      ...hostAnswers(),
      XcodeListWorkspaces: () =>
        isWindowOpen ? { message: `* workspaceIdentifier: windowtab-9, workspacePath: ${PROJECT}` } : { message: '' },
      XcodeOpenWorkspace: { workspaceIdentifier: 'workspace-2', activeScheme: 'App' },
    },
  })
  await start($, clock)
  await clock.advance(4_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Xcode window' })).toBeDefined()
  isWindowOpen = false
  await clock.advance(8_000)
  expect(seen.calls.some(c => c.tool === 'XcodeOpenWorkspace' && c.args.path === PROJECT)).toBe(true)
  expect(await ui.find({ type: 'Text', text: 'Headless Xcode (no window)' })).toBeDefined()
  await ui.unmount()
})

test("Claude's build waits while Xcode builds in its window", async ($, on) => {
  let isBuilding = true
  const ran: string[] = []
  const { clock, seen } = host(on, {
    answers: {
      ...hostAnswers(),
      XcodeListWorkspaces: { message: `* workspaceIdentifier: windowtab-9, workspacePath: ${PROJECT}` },
      GetBuildLog: () => ({ buildIsRunning: isBuilding }),
    },
  })
  let sleeps = 0
  seen.onSleep = () => {
    if (++sleeps === 3) isBuilding = false
  }
  on('tool.call', (_$, e) => {
    ran.push(String(e.tool))
    return { result: { content: [{ type: 'text', text: '{}' }] } }
  })
  await start($, clock)
  await clock.advance(4_000)
  await $.tool.call({ tool: 'mcp__xcode__BuildProject' } as never)
  expect(sleeps).toBeGreaterThanOrEqual(3)
  expect(ran).toEqual(['mcp__xcode__BuildProject'])
})

test('a run started in Xcode shows as running, and Stop ends it in its own workspace', async ($, on) => {
  let state = 'running'
  const { clock, seen } = host(on, {
    answers: {
      ...hostAnswers(),
      XcodeListWorkspaces: TWO_OPEN,
      GetConsoleOutput: args => launchOf(args.workspaceIdentifier === 'windowtab-9' ? state : 'expired'),
      StopProject: { stopResult: 'The app was stopped.' },
    },
  })
  await start($, clock)
  await clock.advance(4_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Running on iPhone 18 Pro' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /started in Xcode/ })).toBeDefined()
  await ui.press({ key: 'xcode-stop' })
  expect(seen.calls.find(c => c.tool === 'StopProject')?.args.workspaceIdentifier).toBe('windowtab-9')
  await ui.unmount()
})

test('an app that ends on the device is no longer shown as running', async ($, on) => {
  let state = 'running'
  const { clock } = host(on, {
    answers: { ...hostAnswers(), XcodeListWorkspaces: TWO_OPEN, GetConsoleOutput: args => launchOf(args.workspaceIdentifier === 'windowtab-9' ? state : 'expired') },
  })
  await start($, clock)
  await clock.advance(4_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'xcode-stop' })).toBeDefined()
  state = 'expired'
  await clock.advance(12_000)
  expect(await ui.find({ key: 'xcode-stop' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'App is ready to run' })).toBeDefined()
  await ui.unmount()
})

test("a build in the Xcode app's window holds Run, though the band acts elsewhere", async ($, on) => {
  const { clock } = host(on, {
    answers: {
      ...hostAnswers(),
      XcodeListWorkspaces: TWO_OPEN,
      GetBuildLog: args => ({ buildIsRunning: args.workspaceIdentifier === 'windowtab-9' }),
    },
  })
  await start($, clock)
  await clock.advance(4_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Xcode is building' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-run' })).toBeUndefined()
  await ui.unmount()
})

test('a band run stopped in Xcode reads as ended, not as running', async ($, on) => {
  let state = 'running'
  const { clock } = host(on, {
    answers: {
      ...hostAnswers(),
      RunProject: { buildErrors: [], processIdentifier: 2660, runResult: 'The app was launched successfully.' },
      GetConsoleOutput: () => launchOf(state, 2660),
    },
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'xcode-run' })
  expect(await ui.find({ type: 'Text', text: 'Running on iPhone 18 Pro' })).toBeDefined()
  // While it runs, Stop is all there is.
  expect(await ui.find({ key: 'xcode-stop' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-run' })).toBeUndefined()
  expect(await ui.find({ key: 'xcode-test' })).toBeUndefined()
  expect(await ui.find({ key: 'xcode-destination' })).toBeUndefined()

  // Stopped in Xcode: the launch session expires.
  state = 'expired'
  await clock.advance(16_000)
  expect(await ui.find({ type: 'Text', text: /^Running on/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'App ended on iPhone 18 Pro' })).toBeDefined()
  // Who launched it, and when it ended: not who ended it, which the band cannot know.
  expect(await ui.find({ type: 'Text', text: /launched from the band .* · ended just now/ })).toBeDefined()
  expect(await ui.find({ key: 'xcode-stop' })).toBeUndefined()
  expect(await ui.find({ key: 'xcode-run' })).toBeDefined()
  await ui.unmount()
})

test("during Claude's turn, with nothing running, Run and Test wait for the turn", async ($, on) => {
  const { clock } = host(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: true } })
  expect(await ui.find({ key: 'xcode-run' })).toBeUndefined()
  expect(await ui.find({ key: 'xcode-test' })).toBeUndefined()
  expect(await ui.find({ key: 'xcode-stop' })).toBeUndefined()
  // In place of the buttons, dimmed.
  expect(await ui.find({ type: 'Text', text: 'Available when Claude is done' })).toBeDefined()
  await ui.unmount()
})

test('Build builds without running, and says how it went', async ($, on) => {
  const { clock, seen } = host(on, {
    answers: { ...hostAnswers(), BuildProject: { buildResult: 'The build succeeded', elapsedTime: 12.3, errors: [] } },
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'xcode-build' })).toMatchObject({ props: { label: 'Build' } })
  await ui.press({ key: 'xcode-build' })
  expect(seen.calls.some(c => c.tool === 'BuildProject')).toBe(true)
  expect(seen.calls.some(c => c.tool === 'RunProject')).toBe(false)
  expect(await ui.find({ type: 'Text', text: 'Build succeeded' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-stop' })).toBeUndefined()
  await ui.unmount()
})

test('the detail says whether Xcode works headless or in its window', async ($, on) => {
  const { clock } = host(on)
  await start($, clock)
  const headless = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // A row of its own, short.
  expect(await headless.find({ type: 'Text', text: 'Headless Xcode (no window)' })).toBeDefined()
  await headless.unmount()
})

test("the project's window in the Xcode app reads as such", async ($, on) => {
  const { clock } = host(on, { answers: { ...hostAnswers(), XcodeListWorkspaces: TWO_OPEN } })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Xcode window' })).toBeDefined()
  await ui.unmount()
})

test('Open in Xcode opens the project in the Xcode app', async ($, on) => {
  const { clock, seen } = host(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'xcode-open-in-xcode' })
  expect(seen.opened).toContainEqual(['open', '-a', 'Xcode', PROJECT])
  await ui.unmount()
})

test("while Xcode builds on its own the band waits, saying so where its buttons were", async ($, on) => {
  const { clock } = host(on, { answers: { ...hostAnswers(), GetBuildLog: { buildIsRunning: true } } })
  await start($, clock)
  await clock.advance(4_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Available when Xcode is done' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-run' })).toBeUndefined()
  await ui.unmount()
})

test('with no build service busy, polls never ask Xcode for its build log', async ($, on) => {
  const { clock, seen } = host(on)
  seen.isBuildServiceBusy = false
  await start($, clock)
  await clock.advance(20_000)
  expect(seen.calls.filter(c => c.tool === 'GetBuildLog')).toHaveLength(0)
  // Something builds: now Xcode is asked, and its answer counts.
  seen.isBuildServiceBusy = true
  seen.answers.GetBuildLog = { buildIsRunning: true }
  await clock.advance(4_000)
  expect(seen.calls.filter(c => c.tool === 'GetBuildLog').length).toBeGreaterThan(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Xcode is building' })).toBeDefined()
  await ui.unmount()
})

test("the files Xcode writes for the band's own calls are removed", async ($, on) => {
  const LOG = '/var/folders/x/T/ActionArtifacts/default/GetBuildLog/A.txt'
  const { clock, seen } = host(on, { answers: { ...hostAnswers(), GetBuildLog: { buildIsRunning: false, fullLogPath: LOG } } })
  await start($, clock)
  await clock.advance(4_000)
  expect(seen.removed).toContain(LOG)
})

test('a path outside Xcode\'s artifacts is never removed', async ($, on) => {
  const { clock, seen } = host(on, { answers: { ...hostAnswers(), GetBuildLog: { buildIsRunning: false, fullLogPath: '/Users/me/notes.txt' } } })
  await start($, clock)
  await clock.advance(4_000)
  expect(seen.removed).not.toContain('/Users/me/notes.txt')
})

test('a build started in Xcode shows within a second, Xcode asked once as it starts', async ($, on) => {
  const { clock, seen } = host(on, { answers: { ...hostAnswers(), GetBuildLog: { buildIsRunning: true } } })
  seen.isBuildServiceBusy = false
  await start($, clock)
  await clock.advance(4_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'xcode-run' })).toBeDefined()
  seen.isBuildServiceBusy = true
  await clock.advance(1_000)
  expect(await ui.find({ type: 'Text', text: 'Xcode is building' })).toBeDefined()
  const asked = seen.calls.filter(c => c.tool === 'GetBuildLog').length
  expect(asked).toBe(1)
  // While it lasts, Xcode is asked every 4 s, not every tick.
  await clock.advance(3_000)
  expect(seen.calls.filter(c => c.tool === 'GetBuildLog').length).toBeLessThanOrEqual(2)
  await ui.unmount()
})

// ── Setup edge cases ─────────────────────────────────────────────────────────

test('MCP switched off in Xcode, Xcode closed: says so, with the way to switch it on', async ($, on) => {
  const { clock } = host(on, { isXcodeOpen: false, isPermissionOn: false })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: "Xcode doesn't let agents use its tools yet" })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Settings › Intelligence.*sudo xcrun mcp-server enable/ })).toBeDefined()
  expect(await ui.find({ key: 'xcode-open-xcode' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-copy-enable' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-run' })).toBeUndefined()
  await ui.unmount()
})

test('MCP switched off in the open Xcode app: the refusal leads to the same step', async ($, on) => {
  const { clock } = host(on, {
    isXcodeOpen: true,
    errors: { XcodeListWorkspaces: 'External agents are not enabled in Xcode.' },
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: "Xcode doesn't let agents use its tools yet" })).toBeDefined()
  // The app is open already: no Open Xcode.
  expect(await ui.find({ key: 'xcode-open-xcode' })).toBeUndefined()
  await ui.unmount()
})

test("Xcode's MCP not added in Claude: the band runs on the server the plugin ships, and sees Claude's calls there", async ($, on) => {
  const { clock, seen } = host(on, { connect: { isConnected: true, server: 'plugin:xcode-companion:xcode' } })
  let release: () => void = () => undefined
  const held = new Promise<void>(r => (release = r))
  on('tool.call', async () => {
    await held
    return { result: { content: [{ type: 'text', text: JSON.stringify({ buildResult: 'The build succeeded' }) }] } }
  })
  await start($, clock)
  expect(seen.calls.find(c => c.tool === 'XcodeListWorkspaces')?.server).toBe('plugin:xcode-companion:xcode')
  const call = $.tool.call({ tool: 'mcp__plugin_xcode-companion_xcode__BuildProject' } as never)
  await clock.advance(1)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Claude is building/ })).toBeDefined()
  release()
  await call
  await ui.unmount()
})

test('the MCP server cannot be connected at all: says why, offers Connect again', async ($, on) => {
  const { clock, seen } = host(on, {
    connect: { isConnected: false, reason: 'failed', message: 'The server xcode exited before it answered.' },
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: "Can't reach Xcode's MCP server" })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'The server xcode exited before it answered.' })).toBeDefined()
  seen.connect = { isConnected: true, server: 'xcode' }
  await ui.press({ key: 'xcode-reconnect' })
  expect(await ui.find({ type: 'Text', text: 'App is ready to run' })).toBeDefined()
  await ui.unmount()
})

test('Xcode 26.3 (no headless server) with the app closed: asks to open Xcode, then sets up by itself', async ($, on) => {
  const { clock, seen } = host(on, { isHeadlessCapable: false, isXcodeOpen: false })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Xcode 26.3 serves its tools only while it is open' })).toBeDefined()
  await ui.press({ key: 'xcode-open-xcode' })
  expect(seen.opened).toContainEqual(['open', '-a', 'Xcode', PROJECT])
  // Xcode is up: the band notices on its own (it checks this step every 3 s).
  seen.isXcodeOpen = true
  await clock.advance(3_000)
  expect(await ui.find({ type: 'Text', text: 'App is ready to run' })).toBeDefined()
  await ui.unmount()
})

test('Xcode 16 (no MCP at all): too old, from which version, App Store and Check again', async ($, on) => {
  const { clock } = host(on, { hasBridge: false })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Xcode 16.2 has no MCP server' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-app-store' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-recheck' })).toBeDefined()
  await ui.unmount()
})

test('xcode-select on the Command Line Tools: the command to switch, ready to copy', async ($, on) => {
  const { clock } = host(on, { selected: '/Library/Developer/CommandLineTools' })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'xcode-select points at the Command Line Tools' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sudo xcode-select -s \/Applications\/Xcode\.app/ })).toBeDefined()
  expect(await ui.find({ key: 'xcode-copy-select' })).toBeDefined()
  await ui.unmount()
})

test('no Xcode installed: points to the App Store', async ($, on) => {
  const { clock } = host(on, { isXcodeInstalled: false, hasBridge: false })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Xcode not found' })).toBeDefined()
  expect(await ui.find({ key: 'xcode-app-store' })).toBeDefined()
  await ui.unmount()
})

test('a run on a locked iPhone: building, then waiting for the unlock, then running', async ($, on) => {
  let release: () => void = () => undefined
  const held = new Promise<void>(r => (release = r))
  const { clock, seen } = host(on, {
    answers: {
      ...hostAnswers(),
      XcodeListRunDestinations: { ...DESTINATIONS, activeDestinationDisplayTitle: 'My iPhone' },
      RunProject: async () => {
        await held
        return { buildErrors: [], processIdentifier: 7, runResult: 'The app was launched successfully.' }
      },
    },
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const pressed = ui.press({ key: 'xcode-run' })
  for (let i = 0; i < 50 && (await ui.find({ key: 'xcode-cancel' })) === undefined; i++) await clock.advance(10)

  // Compiling: the build services have children.
  seen.isBuildServiceBusy = true
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Text', text: 'Running App for My iPhone' })).toBeDefined()

  // Built; the phone is locked: the band says what holds it up, in the warning color.
  seen.isBuildServiceBusy = false
  seen.isDeviceLocked = true
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Text', text: 'Waiting for My iPhone to be unlocked' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Unlock My iPhone to launch App' })).toMatchObject({ props: { color: 'warning' } })

  // Unlocked: launching, then the app runs.
  seen.isDeviceLocked = false
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Text', text: 'Launching App on My iPhone' })).toBeDefined()
  release()
  await pressed
  for (let i = 0; i < 50 && (await ui.find({ type: 'Text', text: /^Running on/ })) === undefined; i++) await clock.advance(10)
  expect(await ui.find({ type: 'Text', text: 'Running on My iPhone' })).toBeDefined()
  await ui.unmount()
})

test("a simulator run is never 'locked'", async ($, on) => {
  let release: () => void = () => undefined
  const held = new Promise<void>(r => (release = r))
  const { clock, seen } = host(on, {
    answers: {
      ...hostAnswers(),
      RunProject: async () => {
        await held
        return { buildErrors: [], processIdentifier: 7, runResult: 'The app was launched successfully.' }
      },
    },
  })
  seen.isDeviceLocked = true
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const pressed = ui.press({ key: 'xcode-run' })
  for (let i = 0; i < 50 && (await ui.find({ key: 'xcode-cancel' })) === undefined; i++) await clock.advance(10)
  seen.isBuildServiceBusy = false
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Text', text: 'Launching App on iPhone 18 Pro' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /unlocked/ })).toBeUndefined()
  release()
  await pressed
  await ui.unmount()
})
