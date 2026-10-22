# kero-pi-background

A [Pi](https://pi.dev) extension that runs jobs in [Kero](https://kero.sh) ([egoist/kero](https://github.com/egoist/kero)) panes and **wakes the agent with a message when they finish**, instead of holding a turn open on `kero wait`.

```text
kero_bg {command: "pnpm test"}      → "Started in session k3f9a. End your turn."
                                      … agent stops …
                                      [kero-background] pane k3f9a succeeded
                                      Last screen: 42 passed
```

## Why

`kero wait` blocks the process that calls it, so an agent that uses it just stalls — it cannot stop, and it cannot do anything else either. Kero has no push channel into a running agent, but Pi does: `pi.sendMessage(..., { triggerTurn: true })`.

So the waiting is moved into a detached child process. The tool returns immediately, the turn ends, and the result arrives later as a message that starts a new turn:

- Pi idle → the message starts a run.
- Pi still working → `deliverAs: "followUp"` queues it, so it never interrupts.

No polling, no blocked turn, one sleeping pid per job.

## Install

```bash
pi install git:github.com/sulthonuladib/kero-pi-background

# or try it for one run
pi -e git:github.com/sulthonuladib/kero-pi-background
```

Run `/reload` in an open session to pick it up. It does nothing outside Kero (guarded by `KERO_SESSION`).

## Make it the default

Tools are chosen by the model, so the default has to live in the prompt. The extension adds a `kero_background` system-prompt section on every run and guidelines next to the tools:

> Long work belongs in a Kero pane. A bash call that blocks is a stall…
> Use `kero_bg` for tests, builds, installs, migrations, servers, and any command whose duration you do not know. After it returns, say what is running and end the turn. Do not sleep, poll, re-read the pane, or call `kero wait`.
> Never cap a background job with a timeout: `kero_bg` watches until the command exits.

That is the whole mechanism — no wrapper around `bash`, no interception. `bash` still runs short commands; the model stops reaching for it on long ones.

## Tools

### `kero_bg`

Start a command in its own background Kero session and return at once. Each job gets a session of its own, so the session you are working in stays one agent doing one thing; pass `split: true` to put a job beside the current pane instead.

| Param | Meaning |
| --- | --- |
| `command` | Shell command to run |
| `dir` | Working directory (default: current) |
| `name` | Session name (default: the command's first word, e.g. `pnpm`) |
| `split` | Run in a pane beside this one instead of its own session |

There is no `timeout`: the job is watched until the command exits, however long that takes. An hour-long build and a three-day server both report when they really end, because a time limit only ever stops you watching a job that is still running.

You are messaged with the exit status and the last 20 lines of the pane when the command ends.

### `kero_watch`

Watch a pane you did not start — another agent, a dev server, something you spawned by hand.

| Param | Meaning |
| --- | --- |
| `pane` | Pane or session id (prefix works) or session name |
| `mode` | `exit` (default): wait for the pane's command to end. `agent`: wait until the agent there stops working, even if a process it started keeps running |
| `label` | What you are waiting on, for the message |
| `timeout` | Stop watching after this long (default `24h`); the job keeps running |

`mode: "agent"` is the "agent finished while its long job still runs" case: Kero's status comes from the agent's OSC 7501 reports (`kero report`), not from the process tree. For that to work the agent in the pane needs Kero's hook (`kero skill setup`).

## Message format

```text
Background job in pane <id> succeeded: <command>

Last screen:
```
<last 20 lines>
```

Read more with: kero read <id> -a
```

A pane that disappears or a job killed by a signal is reported as `lost` / `ended with status N`. If `kero_watch`'s timeout elapses first, the message says the job **is still running** and points at `kero_watch` to resume — it is never reported as an exit status, and it never cuts a job short.

## Caveats

- The wake-up lives in the Pi process. Quit Pi, close the pane, or reload the extension and pending jobs stop reporting (reload kills watchers on purpose to avoid double delivery).
- `/reload` reloads extensions and activates newly registered tools in the current session — no restart needed.
- Exit codes are Kero's: `3` no such target, `4` Kero is not running.

## License

MIT

## Links

- Kero: <https://kero.sh> · <https://github.com/egoist/kero>
- Pi: <https://pi.dev>
