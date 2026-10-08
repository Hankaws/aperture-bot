#!/usr/bin/env node
const require_run = require("./run-CE-7LkaD.cjs");
let node_fs = require("node:fs");
let node_path = require("node:path");
//#region packages/aperture-bot/src/main.ts
/**
* Aperture Bot from a terminal: `aperture-bot run --task "…"`: one task on the checkout in the current
* directory, edits left on disk. The model key comes from APERTURE_MODEL_KEY,
* never a flag, so it stays out of shell history and process listings.
*
* Exit codes: 0 clear or no change, 1 red or stopped, 2 a setup error.
*/
const PROVIDERS = [
	"grok",
	"openai",
	"anthropic",
	"gemini",
	"deepseek",
	"custom"
];
const USAGE = `Usage: aperture-bot run --task "<what to do>" [options]

  --task-file <path>        Read the task from a file instead
  --cwd <dir>               The project (default: the current directory)
  --provider <name>         ${PROVIDERS.join(" | ")} (default: grok)
  --base-url <url>          For --provider custom: an OpenAI-compatible endpoint
  --model <name>            For --provider custom: the model to ask for
  --sandbox <kind>          auto | docker | none (default: auto)
  --image <name>            The Docker image tests run in
  --test-script <name>      The package.json script that runs the tests (default: test)
  --timeout-minutes <n>     For one test run (default: 10)
  --max-tokens <n>          Stop the run at this many tokens (default: 1000000)
  --rounds <n>              How many times Agent Check may run (default: 2)
  --json                    Print the result as JSON

The model key is read from APERTURE_MODEL_KEY.`;
function flag(argv, name) {
	const at = argv.indexOf(`--${name}`);
	return at === -1 ? void 0 : argv[at + 1];
}
function positive(value, fallback, name) {
	if (value === void 0) return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number.`);
	return n;
}
function parseArgs(argv, env) {
	if (argv[0] !== "run") throw new Error(USAGE);
	const taskFile = flag(argv, "task-file");
	const task = (taskFile ? (0, node_fs.readFileSync)(taskFile, "utf8") : flag(argv, "task"))?.trim();
	if (!task) throw new Error(`Give the task with --task or --task-file.\n\n${USAGE}`);
	const provider = flag(argv, "provider") ?? "grok";
	if (!PROVIDERS.includes(provider)) throw new Error(`--provider must be one of ${PROVIDERS.join(", ")}.`);
	const apiKey = env.APERTURE_MODEL_KEY?.trim() ?? "";
	if (!apiKey && provider !== "custom") throw new Error("Set APERTURE_MODEL_KEY to the model provider's API key.");
	const model = {
		provider,
		apiKey
	};
	if (provider === "custom") {
		model.base = flag(argv, "base-url");
		model.model = flag(argv, "model");
		if (!model.base || !model.model) throw new Error("--provider custom needs --base-url and --model.");
	}
	const kind = flag(argv, "sandbox") ?? "auto";
	if (kind !== "auto" && kind !== "docker" && kind !== "none") throw new Error("--sandbox must be auto, docker or none.");
	return {
		cwd: (0, node_path.resolve)(flag(argv, "cwd") ?? process.cwd()),
		task,
		model,
		sandbox: require_run.chooseSandbox(kind, flag(argv, "image")),
		testScript: flag(argv, "test-script") ?? "test",
		timeoutMs: positive(flag(argv, "timeout-minutes"), 10, "timeout-minutes") * 6e4,
		maxTokens: positive(flag(argv, "max-tokens"), 1e6, "max-tokens"),
		rounds: Math.floor(positive(flag(argv, "rounds"), 2, "rounds"))
	};
}
async function main(argv, env) {
	let options;
	try {
		options = parseArgs(argv, env);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
	try {
		const result = await require_run.runTask(options);
		console.log(argv.includes("--json") ? JSON.stringify({
			...result,
			check: result.check && { ...result.check }
		}, null, 2) : result.text);
		return result.outcome === "clear" || result.outcome === "no-change" ? 0 : 1;
	} catch (error) {
		console.error(`Aperture Bot: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
}
//#endregion
//#region packages/aperture-bot/src/cli.ts
/**
*   APERTURE_MODEL_KEY=… aperture-bot run --task "Add a currency to formatPrice"
*/
main(process.argv.slice(2), process.env).then((code) => {
	process.exitCode = code;
});
//#endregion
