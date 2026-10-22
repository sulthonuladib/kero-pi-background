/**
 * kero-pi-background
 *
 * Runs jobs in Kero panes and delivers a message when they end, so a Pi turn
 * can stop instead of blocking on `kero wait`.
 *
 * How it works: `kero_bg` starts a pane and returns at once. The extension
 * spawns a detached `kero wait <pane>` child; when that child exits, the
 * extension sends itself a custom message with `triggerTurn: true` and
 * `deliverAs: "followUp"`, so the message starts a new turn when Pi is idle
 * and waits its turn when Pi is still working. Nothing polls, and no turn is
 * held open while the job runs.
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const KERO = process.env.KERO_BIN ?? "kero";
const TAIL_LINES = 20;
const TAIL_CHARS = 2000;

/** Prompt section that makes backgrounding the default, not a memorised habit. */
const DEFAULT_SECTION = `Long work belongs in its own Kero session, not in a bash call that blocks the turn.

- Use kero_bg for anything that may take more than a few seconds: test suites, builds, installs and package managers, docker, database migrations, tarballs, servers and watchers, batch scripts, and any command whose duration you do not know.
- Each job gets its own session, so the current session stays one agent doing one thing. Pass split=true only when you deliberately want the job beside this pane.
- Prefer a single kero_bg call to splitting one long job across several bash calls.
- After kero_bg returns, say what is running (session id and command) in one line, then end the turn. Do not sleep, poll, re-read the pane, or call kero wait: the job's exit status and last screen arrive as a message that starts your next turn.
- Never cap a background job with a timeout. kero_bg watches until the command exits, however long that takes; a timeout only makes you stop watching a job that is still running.
- Close the session with kero close once you have read what you need from it.
- Use bash only for commands you expect to take seconds: reads, greps, git status and commits, formatters, short scripts.
- Use kero_watch when the work already runs in a pane you did not start; mode "agent" fires when that agent stops working even if its own job keeps running.`;

interface RunResult {
	code: number | null;
	out: string;
}

function run(args: string[], timeoutMs = 15_000): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(KERO, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		const finish = (code: number | null) => resolve({ code, out });
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ code: null, out: `${out}${e.message}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			finish(code);
		});
	});
}

function tail(text: string, lines = TAIL_LINES, chars = TAIL_CHARS): string {
	const trimmed = text.replace(/\s+$/, "").split("\n").slice(-lines).join("\n");
	return trimmed.length > chars ? trimmed.slice(-chars) : trimmed;
}

/** The last line of `kero` output is the id it prints. */
function lastLine(out: string): string {
	return out.trim().split("\n").pop()?.trim() ?? "";
}

/** A readable session name from the first word of the command: "pnpm test" → "pnpm". */
function commandName(command: string): string | undefined {
	const first = command.trim().split(/\s+/)[0] ?? "";
	const base = first.split("/").pop() ?? "";
	if (!/^[A-Za-z0-9][\w.+-]{0,23}$/.test(base)) return undefined;
	return base;
}

export default function keroBackground(pi: ExtensionAPI) {
	if (!process.env.KERO_SESSION) return; // only inside Kero

	const watching = new Map<string, () => void>();

	function watch(
		pane: string,
		label: string,
		mode: "exit" | "agent",
		timeout?: string,
		noun: "session" | "pane" = "pane",
	) {
		if (watching.has(pane)) return;
		const args =
			mode === "agent" ? ["wait", pane, "--for", "idle,waiting,error,exited"] : ["wait", pane, "--exit"];
		if (timeout) args.push("--timeout", timeout);
		const child = spawn(KERO, args, { stdio: ["ignore", "pipe", "pipe"] });
		let err = "";
		child.stderr.on("data", (d) => (err += d));
		watching.set(pane, () => child.kill());
		child.on("error", () => watching.delete(pane));
		child.on("close", async (code) => {
			watching.delete(pane);
			// kero wait prints "kero: timed out" and exits 1 when its --timeout
			// elapses. The job is still running, so that is not an exit status.
			const timedOut = /timed out/i.test(err);
			const screen = await run(["read", pane, "-n", String(TAIL_LINES)], 5000);
			const outcome = timedOut
				? `is still running (stopped watching after ${timeout})`
				: code === 0
					? mode === "agent"
						? "stopped working"
						: "succeeded"
					: code === null
						? "lost"
						: `ended with status ${code}`;
			const why = !timedOut && err.trim() ? `\n(kero said: ${err.trim()})` : "";
			const resume = timedOut ? `\nNot watching any more; call kero_watch on ${pane} to pick it up again.` : "";
			const body = tail(screen.out);
			await pi.sendMessage(
				{
					customType: "kero-background",
					display: true,
					content: [
						`Background job in ${noun} ${pane} ${outcome}: ${label}${why}`,
						resume,
						body ? `\nLast screen:\n\`\`\`\n${body}\n\`\`\`` : "",
						`\nRead more with: kero read ${pane} -a`,
					].join(""),
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		});
	}

	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections.kero_background = DEFAULT_SECTION;
	});

	pi.on("session_shutdown", () => {
		for (const stop of watching.values()) stop();
		watching.clear();
	});

	pi.registerTool({
		name: "kero_bg",
		label: "Kero Background Job",
		description:
			"Run a shell command in its own background Kero session and return at once. It is watched until the command exits, however long that takes; then you are sent a message with its exit status and last screen, so you can end your turn now and continue then.",
		promptSnippet: "Run a long command in its own Kero session; you are messaged when it ends",
		promptGuidelines: [
			"Use kero_bg instead of bash for builds, tests, installs, migrations, servers, and any command of unknown duration; then end the turn instead of waiting.",
			"Do not ask kero_bg for a timeout: a long job is watched until it exits, not cut off while it still runs.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run" }),
			name: Type.Optional(Type.String({ description: "Session name (default: the command's first word)" })),
			dir: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
			split: Type.Optional(
				Type.Boolean({
					description: "Run in a pane beside this one instead of its own session (the default)",
				}),
			),
		}),
		async execute(_id, params) {
			const args = params.split ? ["split", "--down"] : ["new"];
			const name = params.name ?? (params.split ? undefined : commandName(params.command));
			if (name) args.push("-n", name);
			if (params.dir) args.push("-d", params.dir);
			args.push("--", "sh", "-c", params.command);
			const { code, out } = await run(args);
			const pane = lastLine(out);
			if (code !== 0 || !pane) {
				throw new Error(`kero ${args[0]} failed (${code}): ${out.trim()}`);
			}
			watch(pane, params.command, "exit", undefined, params.split ? "pane" : "session");
			return {
				content: [
					{
						type: "text",
						text: `Started in session ${pane}. You will be messaged when it ends; end your turn now if there is nothing else to do.`,
					},
				],
				details: { pane },
			};
		},
	});

	pi.registerTool({
		name: "kero_watch",
		label: "Kero Watch",
		description:
			"Watch a Kero pane you did not start and return at once; you are messaged when it ends. mode=exit waits for the pane's command to end and reports its status; mode=agent waits until the agent running there stops working, even if a process it started keeps running.",
		promptGuidelines: [
			"Use kero_watch, not a polling loop, to learn when a pane started elsewhere (another agent, a server) finishes.",
		],
		parameters: Type.Object({
			pane: Type.String({ description: "Pane or session id (a prefix works) or session name" }),
			mode: Type.Optional(Type.String({ description: '"exit" (default) or "agent"' })),
			label: Type.Optional(Type.String({ description: "What you are waiting on, for the message" })),
			timeout: Type.Optional(
				Type.String({ description: "Stop watching after this long, kero syntax (default 24h); the job keeps running" }),
			),
		}),
		async execute(_id, params) {
			const status = await run(["status", params.pane, "--json"]);
			if (status.code !== 0) throw new Error(`kero status failed: ${status.out.trim()}`);
			const mode = params.mode === "agent" ? "agent" : "exit";
			watch(params.pane, params.label ?? `pane ${params.pane}`, mode, params.timeout ?? "24h");
			const what = mode === "agent" ? "stops working" : "exits";
			return {
				content: [{ type: "text", text: `Watching ${params.pane}; you will be messaged when it ${what}.` }],
				details: { pane: params.pane, mode },
			};
		},
	});
}
