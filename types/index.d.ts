/** The build tooling the band drives. Only Xcode's own MCP server for now. */
export type Backend = 'xcode-mcp'

/**
 * Where the setup stands, first unmet step first. Each step but `ready`
 * draws the band as onboarding: what is missing and the one thing to do.
 */
export type SetupStep =
  | 'checking'
  | 'no-project'
  | 'choose-backend'
  | 'pick-project'
  | 'no-xcode'
  | 'command-line-tools'
  | 'too-old'
  | 'open-xcode'
  | 'permission-off'
  | 'mcp-failed'
  | 'auto-mode'
  | 'approve'
  | 'open-project'
  | 'ready'

export type Setup = {
  step: SetupStep
  /** A sentence from the tool that refused, for `mcp-failed` and `approve`. */
  message: string | null
  /** `xcodebuild -version`'s, e.g. `27.0`; null without Xcode. */
  xcodeVersion: string | null
  /** This Xcode serves MCP with the app closed (`xcrun mcp-server`). */
  isHeadlessCapable: boolean
  isXcodeOpen: boolean
  /** The project files found in the session's folder, absolute. */
  projects: readonly string[]
  /** The approval dialog was asked for and not yet answered. */
  isApprovalAsked: boolean
  /** The backend picked before, shown when picking again (`/xcode-backend`). */
  backend?: Backend | null
}

/** The project the band works on, as Xcode's MCP server opened it. */
export type Workspace = {
  /** The one the band acts on: the Xcode app's window when it has the project open. */
  id: string
  path: string
  name: string
  scheme: string | null
  /**
   * Every workspace Xcode has open for this project: the headless server's
   * and the app's window can hold the same project at once, and a build or
   * run in either is one the band must see.
   */
  watched: readonly string[]
}

export type Destination = {
  /** Xcode's `displayTitle`: what the picker shows and what switching takes. */
  title: string
  isSimulator: boolean
  os: string | null
}

export type ActivityKind = 'build' | 'run' | 'test' | 'stop'

/** Who started it: the model (or a subagent), the band, or something outside this session. */
export type Actor = 'claude' | 'band' | 'external'

export type Activity = {
  id: string
  kind: ActivityKind
  by: Actor
  /** `xcodebuild` from Bash, not Xcode's MCP server. */
  isShell: boolean
  destination: string | null
  startedAtMs: number
  /** The Xcode workspace it runs in, when known. */
  workspaceId?: string
}

/** The last build, run or test that finished, for the band's detail line. */
export type Outcome = {
  kind: ActivityKind
  by: Actor
  isOk: boolean
  /** One line: `Build failed · 2 errors`, `Tests passed · 40`. */
  summary: string
  /** The errors or failed tests, at most a handful, for the hand-over to Claude. */
  issues: readonly string[]
  destination: string | null
  atMs: number
  durationMs: number | null
  /** For a launch: when the app was seen to end (stopped in Xcode, closed on the device). */
  endedAtMs?: number
}

/**
 * A build, run or test of another Claude Code session on this Mac, from the
 * registry every session's band writes (~/.claude/xcode-companion/busy).
 */
export type Elsewhere = {
  /** The project file it builds, absolute: the same checkout means the same path. */
  project: string
  destination: string | null
  kind: ActivityKind
  by: Actor
  /** That session's git branch and folder, to tell it apart. */
  branch: string | null
  folder: string
  startedAtMs: number
}

/**
 * Where a run stands while it is under way: building, then launching on the
 * device, which a locked device holds up until it is unlocked.
 */
export type RunPhase = { activityId: string; step: 'building' | 'launching' | 'locked' }

/** The app the band or Claude launched, until it is stopped. */
export type Launched = {
  destination: string | null
  atMs: number
  /** Who launched it; `external` is a run started in Xcode itself. */
  by?: Actor
  /** The workspace whose Stop ends it, and the app's process there. */
  workspaceId?: string
  pid?: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'xcode-companion': {
      setup: Setup
      workspace: Workspace | null
      destinations: readonly Destination[]
      active: string | null
      activities: readonly Activity[]
      isExternalBuild: boolean
      launched: Launched | null
      last: Outcome | null
      isHidden: boolean
      frame: number
      elsewhere: readonly Elsewhere[]
      /** Polling stopped after a while without anyone using the session. */
      isPaused: boolean
      phase: RunPhase | null
    }
  }
}
