# CLAUDE.md — Xcode Companion

Project context for working in this repo. The repo root **is** the plugin
(`.claude-plugin/plugin.json`), installed as `xcode-companion`, and its own
marketplace (`.claude-plugin/marketplace.json`). It is a Claude Code **mod**: a
function-hooks module (`hooks/register.tsx`, named in `hooks/hooks.json`). Today
it is one band above the prompt; more parts (a pane, commands, skills) are meant
to come, each beside the band in files of its own rather than inside it. No
runtime dependencies; the module runs in Claude Code's own environment (no DOM,
no Node), reaching everything through `$`.

## Layout

```
.claude-plugin/plugin.json      # manifest; ships Xcode's MCP server as `xcode` (xcrun mcpbridge)
.claude-plugin/marketplace.json # the repository as a one-plugin marketplace
hooks/hooks.json                # { "modules": ["./register.tsx"] }
hooks/register.tsx              # host side: polling, actions, setup probe, registry, the drawing
hooks/model.ts                  # pure: parsing Xcode's answers, outcomes, bandView(), refusal()
types/index.d.ts                # the $.state contract (PluginState['xcode-companion'])
tests/band.test.ts              # `claude plugin test .`: the band through the engine, host mocked
```

`model.ts` decides **what the band shows and allows** in every situation;
`register.tsx` reads the host, keeps state and draws. Keep that split: a rule
about which button exists when belongs in `bandView()` / `refusal()`, where a
test can reach it without an engine.

## Checks

```
claude plugin validate .   # what the module hooks and calls, and what the engine refuses
claude plugin test .       # tests/band.test.ts
```

There is no `tsc` in the loop unless one is installed: `claude plugin validate`
does not type-check, and a reference to a name that no longer exists fails only
at run time, silently inside a `void` handler. Run the tests after every
refactor; they catch it.

## Xcode's MCP server: what the code relies on

Established against Xcode 27.0 (`xcrun mcpbridge`, server `xcode-tools`):

- **No push.** The server advertises only `tools.listChanged`: no resources, no
  subscriptions, no log or progress notifications. Every state is polled.
- **Workspaces.** `XcodeListWorkspaces` answers text lines
  `* workspaceIdentifier: <id>, workspacePath: <path>`. The same project can be
  open twice: `workspace-…` in the headless server (opened by
  `XcodeOpenWorkspace`) and `windowtab-…` for a window of the Xcode app. Builds,
  runs and launch sessions are per workspace. `XcodeCloseWorkspace` closes only
  what `XcodeOpenWorkspace` opened (headless), never a window.
- **Approval.** Xcode approves an *agent* by the code signature of the process
  that spawned `mcpbridge` (Claude Code's), together with the project's folder.
  The first `XcodeOpenWorkspace` raises the dialog; until then calls answer
  "This agent isn't approved …". A bridge spawned by another binary (a helper
  script's interpreter) is another agent, and approving it would approve every
  user of that binary.
- **Headless.** `xcrun mcp-server` exists from Xcode 27 (headless service, works
  with the app closed); `xcrun mcp-server status --format json` gives
  `permission.enabled`, permitted agents and folders, and open headless
  workspaces. Xcode 26.3 has `mcpbridge` only, served by the open app.
- **BuildProject** answers `buildResult`, `errors[{ message, … }]`,
  `elapsedTime`, `fullLogPath`. **RunProject** answers `runResult`
  (`The app was launched successfully.`), `buildErrors`, `processIdentifier`,
  `launchSessionReference`, `fullLogPath`; it returns only once the app has
  launched, so a locked or unplugged device keeps it waiting indefinitely.
- **GetBuildLog** answers `buildIsRunning` and the last `buildResult` — and
  writes the **whole last build log** (about a megabyte) to `fullLogPath` on
  every call, filters notwithstanding. Polled naïvely that is a gigabyte an hour.
- **GetConsoleOutput** answers `launchSessionInfo`:
  `Launch Session: <name>, ref: <ref>, PID: <pid>, State: running|expired`, or
  an error with no launch session. That is the "app runs" signal.
- **XcodeListRunDestinations** answers `destinations[{ displayTitle, group,
  isEligible, isGenericDevice, isSimulator, platformIdentifier, osVersion }]`,
  `activeDestinationDisplayTitle`, `activeSchemeName`. An unplugged device is
  gone from the next answer and Xcode moves the active destination off it.
- Answers with a `full…Path` leave a file under `…/T/ActionArtifacts/default/`
  that Xcode never removes.

## Local signals (no Xcode call)

- **Something builds**: Xcode's build service (`SWBBuildService`, one per Xcode
  app and one per headless service; `XCBBuildService` on older Xcode) spawns a
  build's compilers and tools as children and has none while idle. Match it with
  `pgrep -x` (a `pgrep -f` pattern also matches the shell that runs it). Indexing
  can spawn children too: the band then asks `GetBuildLog`, which says no.
- **Device locked**: `xcrun devicectl device info lockState --device <name>
  --json-output /dev/stdout` → `result.passcodeRequired`, under a second.
  Simulators answer an error (no lock state).

## The plugin API: what the code relies on

- `$.mcp.call` is documented as needing no permission ("the plugin's call … is
  the grant"). The terminal honours that. The **desktop app** does not: in auto
  mode it sends the call to the classifier, which refuses it
  ([anthropics/claude-code#101884](https://github.com/anthropics/claude-code/issues/101884));
  in manual mode it shows a permission dialog per call. A `tool.check` hook
  cannot help: the engine skips a mod's own hooks for calls the mod made
  (re-entry), and a hook that loosens permissions is not this plugin's to ship.
- `$.mcp.connect('xcode')` connects the server the manifest ships and answers
  the name to call it by; when the person registered the same server already,
  it answers that one's name (`xcode`) instead of starting a second.
- `$.process.run` runs a host command with no permission check, ten minutes at
  most; `$.process.spawn` has no time limit.
- A hook's own time is bounded (10 s), but time spent awaiting `$` calls or
  `next` does not count. Waiting is done with `$` calls (a `sleep` child), not
  with `$.clock.sleep`, which counts.
- The band slot is shared: the hook draws its tree **above** `next(e)` with a
  rule between, and draws nothing of its own outside an Xcode project.
- Element keys are prefixed `xcode-…`; `$.state` keys use the literal plugin
  name (the validator reads them from the source).

## Design decisions

- **Who may press what, when** (`bandView`, `refusal`): during Claude's turn
  nothing that builds; while the app runs or a band action runs, Stop only;
  while anything builds anywhere on the project, nothing that builds; a device
  another session runs on cannot be run on. Every action re-checks fresh
  (`refusalNow`): workspaces, registry, `GetBuildLog`, and the picked device
  still being Xcode's active one.
- **Claude's builds** (`tool.call` on `mcp__<server>__BuildProject|RunProject|
  RunAllTests|RunSomeTests|XcodeSwitch*` and Bash `xcodebuild`) wait while the
  band, Xcode or another session builds this checkout, and are refused after
  15 minutes. **Stop never waits**: it is how a stuck run ends.
- **One project, one place.** With the project open in an Xcode window the band
  acts there and closes the headless copy (unless something runs in it); with
  the window gone it reopens the headless one.
- **Registry** (`~/.claude/xcode-companion/busy/<session>--<activity>.json`):
  each running build, run or test, heartbeat every 15 s, stale after 60 s.
  Same project path = same checkout = blocked; another path (a worktree) = only
  the device is shared. Of two claims made at once the later gives way.
- **Polling** on one 1 s tick: local build look every tick; `GetBuildLog` only
  when it says something builds; app state and registry every 4th tick;
  workspaces every 8th; devices every 16th. Paused after 10 idle minutes,
  resumed by a prompt, a press, a reattach or Refresh. No Xcode calls during
  Claude's turn; workspaces and devices are refreshed when it ends.
- **Run phases** follow a run every 2 s: building (build service has children),
  launching, locked (`devicectl`), until RunProject returns.
- **Results** say what happened (`Launched on …`), never what is (`Running on`
  comes only from a live launch session). A launch that ends is marked
  `App ended`, with who launched it and when it ended; who ended it is unknown.
- **Artifacts**: every `full…Path` an own call leaves under `ActionArtifacts`
  is removed right away.
- **Setup** (`probe`) walks the first unmet step each time: project file found
  (a `.xcodeproj` counts only with its `project.pbxproj`), backend chosen,
  `mcpbridge` present (else Command Line Tools / too old / no Xcode), headless
  or app open, permission, MCP connected, approval, project open. Steps the
  person resolves outside the band are re-checked every 3 s.
