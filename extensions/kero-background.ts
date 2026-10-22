/**
 * kero-pi-background
 *
 * Long work runs in a Kero session of its own, and that session tells Pi when
 * it is done: its shell runs `kero send <pi-pane> --enter ...`, which lands in
 * Pi as a prompt and starts the next turn. The CLIs talk to each other, so Pi
 * never watches the job, never holds a turn open, and there is no timeout
 * anywhere: the command finishes when it finishes.
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const KERO = process.env.KERO_BIN ?? "kero";
/** The pane to type the completion message into: Pi's own pane. */
const PI_TARGET = process.env.KERO_PANE ?? process.env.KERO_SESSION;
/** Guard against a kero call hanging, not a limit on the job. */
const CALL_LIMIT_MS = 15_000;

/** Refuse stock long work in bash, where it would stall the turn. */
const BASH_GATE = process.env.KERO_BG_BASH_GATE !== "off";

/** Commands that are long by nature. */
const LONG_WORK = [
	/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci|update|upgrade|remove|uninstall)\b/i,
	/\b(npm|pnpm|yarn|bun)\s+run\s+(build|test|e2e|start)\b/i,
	/\b(pip|pip3|uv|poetry|pipx)\s+(install|sync|add|lock|update)\b/i,
	/\b(cargo|rustup)\s+(build|install|fetch|test|update)\b/i,
	/\bgo\s+(build|install|test|generate|mod\s+(download|tidy|vendor))\b/i,
	/\b(apt|apt-get|dnf|yum|pacman|yay|paru|zypper|brew|gem|composer|dotnet|mix|nix)\s+(install|add|update|upgrade|restore|get|build|sync|develop|shell)\b/i,
	/\b(docker|podman|nerdctl)\s+(build|pull|push|run|up|compose\s+(up|build)|image\s+(pull|build))\b/i,
	/\bgit\s+(clone|fetch|pull|push|lfs|submodule)\b/i,
	/\b(make|ninja|gradle|mvn|bazel|cmake\s+--build|meson\s+compile)\b(?!.*--version)/i,
	/\b(rsync|scp|ffmpeg|unzip|7z\s+x)\b/i,
	/\btar\b[^\n]*(\s-?[a-zA-Z]*x[a-zA-Z]*\b|--extract)/i,
	/(^|[;&|]\s*|\bsudo\s+)wget\b/i,
	/\b(pytest|jest|vitest|playwright|cypress|tox|nox|rspec)\b/i,
	/\bcurl\b[^\n]*\s(-O|--output|-o|--remote-name)\b/i,
];

/** Prompt section that makes backgrounding the default, not a memorised habit. */
const DEFAULT_SECTION = `Long work belongs in a Kero session of its own, not in a bash call that spends the turn watching it load.

- Use kero_bg for anything that may take more than a few seconds: test suites, builds, installs and package managers, docker, database migrations, downloads, tarballs, servers and watchers, batch scripts, and any command whose duration you do not know.
- kero_bg always starts a new session in the current project. There is no split and no timeout to set: the command finishes when it finishes.
- After kero_bg returns, say what is running (session id and command) in one line, then end the turn. Do not sleep, poll, read the screen, or call kero wait: the session itself messages you when the command ends, and that message starts your next turn.
- When that message arrives, read the session with kero read <session> -a, then close it with kero close <session>.
- A bash call that is stock long work (installs, builds, clones, downloads, test suites) is refused and handed back to you with this instruction.
- Use bash only for commands you expect to take seconds: reads, greps, git status and commits, formatters, short scripts.
- Use kero_watch when the work already runs in a pane you did not start; mode "agent" fires when that agent stops working even if its own job keeps running.`;

interface RunResult {
	code: number | null;
	out: string;
}

function run(args: string[], limitMs = CALL_LIMIT_MS): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(KERO, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		const finish = (code: number | null) => resolve({ code, out });
		const timer = setTimeout(() => child.kill("SIGKILL"), limitMs);
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

/** A single-quoted shell word. */
function shq(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

interface Project {
	id: string;
	name: string;
	dir: string;
}

async function json<T>(args: string[]): Promise<T | undefined> {
	const { code, out } = await run(args);
	if (code !== 0) return undefined;
	try {
		return JSON.parse(out) as T;
	} catch {
		return undefined;
	}
}

/** The project holding `dir`: the deepest match wins. */
async function projectFor(dir: string): Promise<Project | undefined> {
	const projects = await json<Project[]>(["projects", "--json"]);
	if (!projects) return undefined;
	const under = (p: Project) => dir === p.dir || dir.startsWith(`${p.dir.replace(/\/+$/, "")}/`);
	return projects.filter(under).sort((a, b) => b.dir.length - a.dir.length)[0];
}

/** The directory this Pi session works in, as Kero sees it. */
async function currentDir(): Promise<string | undefined> {
	if (!process.env.KERO_PANE) return undefined;
	const status = await json<{ dir?: string }>(["status", process.env.KERO_PANE, "--json"]);
	return status?.dir;
}

/**
 * Shell lines the job runs when its command ends: record the status, type a
 * one-line message into Pi's pane, and exit with the command's status. The
 * trap means a command that calls `exit` itself still reports. Pi needs no
 * watcher, because the message arrives as typed input.
 */
function announce(subject: string): string {
	if (!PI_TARGET) return "";
	return [
		"done_with_job() {",
		"\trc=$?",
		"\ttrap - EXIT",
		`\tlabel=${shq(subject)}`,
		`\tkero send ${shq(PI_TARGET)} --enter "kero-pi-background: $label ($KERO_SESSION) exited $rc; kero read $KERO_SESSION -a; kero close $KERO_SESSION"`,
		"\texit $rc",
		"}",
		"trap done_with_job EXIT",
	].join("\n");
}

export default function keroBackground(pi: ExtensionAPI) {
	if (!process.env.KERO_SESSION) return; // only inside Kero

	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections.kero_background = DEFAULT_SECTION;
	});

	// A long command in bash is Pi standing still while something loads. Refuse
	// the stock long ones and name kero_bg in the refusal, so the next call is
	// the right one. There is no timeout involved: the command's shape decides.
	pi.on("tool_call", (event) => {
		if (!BASH_GATE || event.toolName !== "bash") return;
		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (!LONG_WORK.some((pattern) => pattern.test(command))) return;
		return {
			block: true,
			reason: `\`${command.trim()}\` is long work, and bash would hold this turn until it ends. Start it with kero_bg instead: it runs in a new Kero session in this project, you end the turn and do something else, and the session messages you when the command ends.`,
		};
	});

	pi.registerTool({
		name: "kero_bg",
		label: "Kero Background Job",
		description:
			"Run a shell command in a new Kero session in the current project and return at once. When the command ends its session messages this Pi session with the exit status, so you can end the turn now, do something else, and pick the result up in the next turn.",
		promptSnippet: "Run a long command in its own Kero session; its session messages you when it ends",
		promptGuidelines: [
			"Use kero_bg instead of bash for builds, tests, installs, migrations, servers, downloads, and any command of unknown duration; then end the turn instead of waiting.",
			"There is no timeout to set: the job reports itself when it finishes, however long that takes.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run" }),
			name: Type.Optional(Type.String({ description: "Session name (default: the command's first word)" })),
			dir: Type.Optional(Type.String({ description: "Working directory (default: the current session's)" })),
		}),
		async execute(_id, params) {
			const dir = params.dir ?? (await currentDir()) ?? process.cwd();
			const project = await projectFor(dir);
			const name = params.name ?? commandName(params.command);
			const script = [announce(name ?? "job"), params.command].filter(Boolean).join("\n");
			const args = ["new"];
			if (project) args.push("-p", project.id);
			if (name) args.push("-n", name);
			args.push("-d", dir, "--", "sh", "-c", script);
			const { code, out } = await run(args);
			const pane = lastLine(out);
			if (code !== 0 || !pane) {
				throw new Error(`kero new failed (${code}): ${out.trim()}`);
			}
			const where = project ? ` in project ${project.name}` : "";
			const how = PI_TARGET
				? "Its session messages you when the command ends; end the turn and do something else."
				: "No Pi pane to message, so check it yourself with `kero read`.";
			return {
				content: [{ type: "text", text: `Started in session ${pane}${where}. ${how}` }],
				details: { pane, project: project?.name },
			};
		},
	});

	pi.registerTool({
		name: "kero_watch",
		label: "Kero Watch",
		description:
			"Watch a Kero pane you did not start, in a session of its own, and return at once. That session messages this Pi session when the pane's command ends (mode=exit) or when the agent there stops working (mode=agent), then closes itself.",
		promptGuidelines: [
			"Use kero_watch, not a polling loop, to learn when a pane started elsewhere (another agent, a server) finishes.",
		],
		parameters: Type.Object({
			pane: Type.String({ description: "Pane or session id (a prefix works) or session name" }),
			mode: Type.Optional(Type.String({ description: '"exit" (default) or "agent"' })),
			label: Type.Optional(Type.String({ description: "What you are waiting on, for the message" })),
		}),
		async execute(_id, params) {
			const status = await run(["status", params.pane, "--json"]);
			if (status.code !== 0) throw new Error(`kero status failed: ${status.out.trim()}`);
			const mode = params.mode === "agent" ? "agent" : "exit";
			const waiting =
				mode === "agent"
					? `kero wait ${shq(params.pane)} --for idle,waiting,error,exited`
					: `kero wait ${shq(params.pane)} --exit`;
			const subject = params.label ?? `pane ${params.pane}`;
			const script = PI_TARGET
				? [
						waiting,
						"rc=$?",
						`label=${shq(subject)}`,
						`kero send ${shq(PI_TARGET)} --enter "kero-pi-background: $label ${mode === "agent" ? "stopped working" : "exited"} ($rc); kero close $KERO_SESSION"`,
						'kero close "$KERO_SESSION"',
					].join("\n")
				: waiting;
			const dir = (await currentDir()) ?? process.cwd();
			const project = await projectFor(dir);
			const args = ["new", "-n", "watch"];
			if (project) args.push("-p", project.id);
			args.push("-d", dir, "--", "sh", "-c", script);
			const { code, out } = await run(args);
			const pane = lastLine(out);
			if (code !== 0 || !pane) throw new Error(`kero new failed (${code}): ${out.trim()}`);
			const what = mode === "agent" ? "stops working" : "exits";
			return {
				content: [{ type: "text", text: `Watching ${params.pane} in session ${pane}; you will be messaged when it ${what}.` }],
				details: { pane: params.pane, watcher: pane, mode },
			};
		},
	});
}
