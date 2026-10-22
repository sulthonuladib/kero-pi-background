# kero-pi-background

A [Pi](https://pi.dev) extension that runs long jobs in [Kero](https://kero.sh) ([egoist/kero](https://github.com/egoist/kero)) sessions and lets **the session tell Pi when it is done** — by typing a line into Pi's terminal pane. Pi never watches the job, never holds a turn open, and there is no timeout: the command finishes when it finishes.

```text
kero_bg {command: "pnpm test"}  → "Started in session k3f9a…"     … agent ends its turn …
                                  kero-pi-background: pnpm (k3f9a) exited 0; kero read k3f9a -a; kero close k3f9a
```

## Why

A `bash` call holds the turn for exactly as long as the command runs, so a download or a build means Pi standing still with nothing to do. A `timeout` on top does not fix that — it is the same stall with a number attached, and if the command is quicker than the timeout, the timeout was never the point.

Kero and Pi both live in terminals, so they can simply talk. The job's own session runs `kero send <pi-pane> --enter …` when the command ends. Pi receives it as typed input, starts a turn, reads the session, and closes it. No watcher process in Pi, no polling, no polling loop, no timeout.

## Install

```bash
pi install git:github.com/sulthonuladib/kero-pi-background

# or try it for one run
pi -e git:github.com/sulthonuladib/kero-pi-background
```

Run `/reload` in an open session to pick it up. It does nothing outside Kero (guarded by `KERO_SESSION`).

## The round trip

1. `kero_bg` starts a **new session in the current project**: `kero new -p <project> -n <name> -d <dir> -- sh -c '<job>'`. No split, no pane beside the agent.
2. The tool returns at once. The turn ends; Pi is free.
3. When the command ends — even if it calls `exit` itself, because the notification runs from an `EXIT` trap — the session sends one line to Pi's pane with `kero send --enter`, then exits with the command's status.
4. Pi starts a turn on that line. It names the session and the exit status, and says what to do next: `kero read <session> -a`, then `kero close <session>`.

That last step is the whole point: the session that did the work is closed as soon as the agent has recognised its result, so finished jobs do not pile up.

## Tools

### `kero_bg`

Start a command in a new Kero session in the current project and return at once.

| Param | Meaning |
| --- | --- |
| `command` | Shell command to run |
| `name` | Session name (default: the command's first word, e.g. `pnpm`) |
| `dir` | Working directory (default: the current session's) |

No `split`, no `timeout`. The job reports itself when it ends, however long that takes.

### `kero_watch`

Watch a pane you did not start — another agent, a dev server, something spawned by hand — without watching it yourself.

| Param | Meaning |
| --- | --- |
| `pane` | Pane or session id (prefix works) or session name |
| `mode` | `exit` (default): wait for the pane's command to end. `agent`: wait until the agent there stops working, even if a process it started keeps running |
| `label` | What you are waiting on, for the message |

The watcher is a session too: it runs `kero wait`, sends the same one-line message to Pi, and closes itself, so there is nothing left behind.

`mode: "agent"` is the "agent finished while its long job still runs" case: Kero's status comes from the agent's OSC 7501 reports (`kero report`), not from the process tree. For that to work the agent in the pane needs Kero's hook (`kero skill setup`).

## The bash gate

The prompt asks the model to background long work, and the `tool_call` gate makes it stick: stock long commands are refused in `bash`, because there bash would hold the turn while something loads.

| Bash call | Result |
| --- | --- |
| installs, builds, clones, downloads, test suites (`npm install`, `cargo build`, `docker build`, `git clone`, `pytest`, `wget`, `curl -O`, …) | blocked, reason points at `kero_bg` |
| everything else (`ls`, `git status`, `grep`, formatters, short scripts) | runs as usual |

```text
`npm install` is long work, and bash would hold this turn until it ends.
Start it with kero_bg instead: it runs in a new Kero session in this project,
you end the turn and do something else, and the session messages you when the
command ends.
```

The block is a tool result the model must read, not a silent drop, so its next call is the right one. `KERO_BG_BASH_GATE=off` turns it off.

## Message format

```text
kero-pi-background: <name> (<session>) exited <status>; kero read <session> -a; kero close <session>
```

The status is the command's own — a failed build reports its exit code. The watcher's version names the pane and mode instead (`kero-pi-background: the build exited (2); kero close <watcher>`).

## Caveats

- The wake-up is a message typed into Pi's terminal pane, so Pi has to be running in Kero (`KERO_PANE`). If that pane is gone, the send has nowhere to land and the job's session still holds its output for a manual `kero read`.
- Typed input is typed input: if you have a draft in Pi's compose box when the job ends, the completion line joins it. That is the price of a real push between two terminal programs.
- A job's session is left open after its message, because `kero read` needs the scrollback; the message tells the agent to close it. Watcher sessions close themselves.
- Quitting Pi closes its pane, so completions that arrive afterwards cannot wake anything.

## License

MIT

## Links

- Kero: <https://kero.sh> · <https://github.com/egoist/kero>
- Pi: <https://pi.dev>
