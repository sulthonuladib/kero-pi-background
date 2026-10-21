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

export default function keroBackground(pi: ExtensionAPI) {
	if (!process.env.KERO_SESSION) return; // only inside Kero

	const watching = new Map<string, () => void>();

	function watch(pane: string, label: string, mode: "exit" | "agent", timeout: string) {
		if (watching.has(pane)) return;
		const args =
			mode === "agent"
				? ["wait", pane, "--for", "idle,waiting,error,exited", "--timeout", timeout]
				: ["wait", pane, "--exit", "--timeout", timeout];
		const child = spawn(KERO, args, { stdio: ["ignore", "pipe", "pipe"] });
		let err = "";
		child.stderr.on("data", (d) => (err += d));
		watching.set(pane, () => child.kill());
		child.on("error", () => watching.delete(pane));
		child.on("close", async (code) => {
			watching.delete(pane);
			const screen = await run(["read", pane, "-n", String(TAIL_LINES)], 5000);
			const outcome =
				code === 0
					? mode === "agent"
						? "stopped working"
						: "succeeded"
					: code === null
						? "lost"
						: `ended with status ${code}`;
			const why = err.trim() ? `\n(kero said: ${err.trim()})` : "";
			const body = tail(screen.out);
			await pi.sendMessage(
				{
					customType: "kero-background",
					display: true,
					content: [
						`Background job in pane ${pane} ${outcome}: ${label}${why}`,
						body ? `\nLast screen:\n\`\`\`\n${body}\n\`\`\`` : "",
						`\nRead more with: kero read ${pane} -a`,
					].join(""),
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		});
	}

	pi.on("session_shutdown", () => {
		for (const stop of watching.values()) stop();
		watching.clear();
	});

	pi.registerTool({
		name: "kero_bg",
		label: "Kero Background Job",
		description:
			"Run a shell command in a background Kero pane and return at once. When the command exits you are sent a message with its exit status and last screen, so you can end your turn now and continue then.",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run" }),
			name: Type.Optional(Type.String({ description: "Session name (with session=true)" })),
			dir: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
			session: Type.Optional(
				Type.Boolean({ description: "Start a new session instead of a pane beside this one" }),
			),
			timeout: Type.Optional(
				Type.String({ description: "Stop watching after this long (kero syntax, e.g. 2h); default none" }),
			),
		}),
		async execute(_id, params) {
			const args = params.session ? ["new"] : ["split", "--down"];
			if (params.name) args.push("-n", params.name);
			if (params.dir) args.push("-d", params.dir);
			args.push("--", "sh", "-c", params.command);
			const { code, out } = await run(args);
			const pane = lastLine(out);
			if (code !== 0 || !pane) {
				throw new Error(`kero ${args[0]} failed (${code}): ${out.trim()}`);
			}
			watch(pane, params.command, "exit", params.timeout ?? "24h");
			return {
				content: [
					{
						type: "text",
						text: `Started in pane ${pane}. You will be messaged when it ends; end your turn now if there is nothing else to do.`,
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
		parameters: Type.Object({
			pane: Type.String({ description: "Pane or session id (a prefix works) or session name" }),
			mode: Type.Optional(Type.String({ description: '"exit" (default) or "agent"' })),
			label: Type.Optional(Type.String({ description: "What you are waiting on, for the message" })),
			timeout: Type.Optional(Type.String({ description: "Stop watching after this long (e.g. 2h)" })),
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
