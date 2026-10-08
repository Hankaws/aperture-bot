const require_run = require("./run-BXPp-VLX.cjs");
let node_fs = require("node:fs");
let node_path = require("node:path");
let node_child_process = require("node:child_process");
//#region packages/aperture-bot/src/context.ts
const CONTEXT_LIMITS = {
	comments: 20,
	commentChars: 2e3,
	total: 12e3,
	diff: 2e4
};
const clip$1 = (text, max) => text.length <= max ? text : `${text.slice(0, max)}\n… (cut at ${max} characters)`;
function threadContext(command, comments, diff) {
	const parts = [`${command.isPull ? "Pull request" : "Issue"} #${command.number}: ${command.title}`, clip$1(command.body.trim(), 4e3)];
	const shown = comments.filter((c) => c.authorType !== "Bot" && c.id !== command.commentId).slice(-CONTEXT_LIMITS.comments);
	if (shown.length > 0) {
		parts.push("Comments, oldest first:");
		for (const c of shown) parts.push(`@${c.author}: ${clip$1(c.body.trim(), CONTEXT_LIMITS.commentChars)}`);
	}
	let text = clip$1(parts.filter(Boolean).join("\n\n"), CONTEXT_LIMITS.total);
	if (diff) text += `\n\nThe pull request's diff:\n${clip$1(diff, CONTEXT_LIMITS.diff)}`;
	return text;
}
//#endregion
//#region packages/aperture-bot/src/event.ts
const DEFAULT_TRIGGER = "/aperture";
/** The task after the trigger, or null when the comment does not start with it. */
function taskFrom(body, trigger = DEFAULT_TRIGGER) {
	const text = body.trimStart();
	if (!text.toLowerCase().startsWith(trigger.toLowerCase())) return null;
	const rest = text.slice(trigger.length);
	if (rest !== "" && !/^\s/.test(rest)) return null;
	return rest.trim();
}
function parseEvent(name, payload, trigger = DEFAULT_TRIGGER) {
	if (name !== "issue_comment") return { ignored: `${name} events are not commands; the bot answers issue comments.` };
	const event = payload ?? {};
	if (event.action !== "created") return { ignored: "only new comments are commands, not edits." };
	const user = event.comment?.user;
	if (user?.type === "Bot") return { ignored: "comments from bots are not commands." };
	const task = taskFrom(event.comment?.body ?? "", trigger);
	if (task === null) return { ignored: `the comment does not start with ${trigger}.` };
	const issue = event.issue;
	const repo = event.repository;
	if (!issue?.number || !event.comment?.id || !user?.login || !repo?.name || !repo.owner?.login) return { ignored: "the event is missing the issue, comment or repository." };
	const title = issue.title ?? "";
	return { command: {
		number: issue.number,
		isPull: Boolean(issue.pull_request),
		title,
		body: issue.body ?? "",
		task: task || `Do what this ${issue.pull_request ? "pull request" : "issue"} asks: ${title}`,
		commentId: event.comment.id,
		author: user.login,
		owner: repo.owner.login,
		repo: repo.name,
		defaultBranch: repo.default_branch ?? "main"
	} };
}
//#endregion
//#region packages/aperture-bot/src/github.ts
/**
* The few GitHub REST calls the bot makes, over plain fetch with the
* workflow's token. `fetch` is injectable so the tests run against an API
* that lives in memory.
*/
var GitHubError = class extends Error {
	status;
	constructor(message, status) {
		super(message);
		this.status = status;
	}
};
var GitHub = class {
	repo;
	token;
	api;
	fetcher;
	constructor(repo, token, api = "https://api.github.com", fetcher = fetch) {
		this.repo = repo;
		this.token = token;
		this.api = api;
		this.fetcher = fetcher;
	}
	async call(method, path, body, accept = "application/vnd.github+json") {
		const res = await require_run.retryStale(() => this.fetcher(`${this.api}${path}`, {
			method,
			headers: {
				Accept: accept,
				Authorization: `Bearer ${this.token}`,
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "aperture-bot",
				...body === void 0 ? {} : { "Content-Type": "application/json" }
			},
			body: body === void 0 ? void 0 : JSON.stringify(body)
		}));
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new GitHubError(`GitHub answered ${res.status} to ${method} ${path}${text ? `: ${text.slice(0, 200)}` : ""}`, res.status);
		}
		if (accept !== "application/vnd.github+json") return await res.text();
		return res.status === 204 ? void 0 : await res.json();
	}
	get base() {
		return `/repos/${this.repo.owner}/${this.repo.repo}`;
	}
	/** admin, maintain, write, triage, read or none. */
	async permission(user) {
		try {
			const out = await this.call("GET", `${this.base}/collaborators/${encodeURIComponent(user)}/permission`);
			return out.role_name ?? out.permission ?? "none";
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) return "none";
			throw error;
		}
	}
	async react(commentId, content) {
		await this.call("POST", `${this.base}/issues/comments/${commentId}/reactions`, { content });
	}
	async comments(issue) {
		return (await this.call("GET", `${this.base}/issues/${issue}/comments?per_page=100`)).map((c) => ({
			id: c.id,
			author: c.user?.login ?? "someone",
			authorType: c.user?.type ?? "User",
			body: c.body ?? ""
		}));
	}
	async pull(number) {
		const out = await this.call("GET", `${this.base}/pulls/${number}`);
		return {
			number: out.number,
			headRef: out.head.ref,
			headSha: out.head.sha,
			headRepo: out.head.repo?.full_name ?? "",
			baseRef: out.base.ref
		};
	}
	/** The pull request's diff, as text. */
	async diff(number) {
		return this.call("GET", `${this.base}/pulls/${number}`, void 0, "application/vnd.github.diff");
	}
	async createPull(input) {
		const out = await this.call("POST", `${this.base}/pulls`, input);
		return {
			number: out.number,
			url: out.html_url
		};
	}
	async comment(issue, body) {
		const out = await this.call("POST", `${this.base}/issues/${issue}/comments`, { body });
		return {
			id: out.id,
			url: out.html_url
		};
	}
	async editComment(id, body) {
		await this.call("PATCH", `${this.base}/issues/comments/${id}`, { body });
	}
};
/** Write access, the bar for asking the bot to change the repository. */
function canWrite(permission) {
	return [
		"admin",
		"maintain",
		"write"
	].includes(permission);
}
//#endregion
//#region packages/aperture-bot/src/publish.ts
/**
* Git on the runner: checking out a pull request's branch before a run, and
* after a clear one, a commit of exactly the files the bot wrote, pushed with
* the token actions/checkout left in the repository's git config.
*/
/** The identity GitHub shows for commits made with a workflow's token. */
const BOT_AUTHOR = {
	name: "Aperture Bot",
	email: "41898282+github-actions[bot]@users.noreply.github.com"
};
function slug(text, max = 40) {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "") || "change";
}
function remoteHas(cwd, branch) {
	return require_run.git([
		"ls-remote",
		"--heads",
		"origin",
		branch
	], cwd).trim() !== "";
}
/** `aperture/12-fix-the-cart`, or `-2`, `-3`… when an earlier run used that name. */
function freeBranch(cwd, number, title) {
	const base = `aperture/${number}-${slug(title)}`;
	if (!remoteHas(cwd, base)) return base;
	for (let n = 2;; n += 1) if (!remoteHas(cwd, `${base}-${n}`)) return `${base}-${n}`;
}
/** Puts the checkout on a pull request's branch, as it is on the remote now. */
function checkoutPullHead(cwd, ref) {
	require_run.git([
		"fetch",
		"--no-tags",
		"origin",
		`+refs/heads/${ref}:refs/remotes/origin/${ref}`
	], cwd);
	require_run.git([
		"checkout",
		"-B",
		ref,
		`refs/remotes/origin/${ref}`
	], cwd);
}
/** Commits exactly `paths` (relative to `cwd`) and returns the commit. */
function commitFiles(cwd, paths, message) {
	require_run.git([
		"add",
		"--",
		...paths
	], cwd);
	require_run.git([
		"-c",
		`user.name=${BOT_AUTHOR.name}`,
		"-c",
		`user.email=${BOT_AUTHOR.email}`,
		"commit",
		"--no-verify",
		"-m",
		message
	], cwd);
	return require_run.git(["rev-parse", "HEAD"], cwd).trim();
}
function push(cwd, branch) {
	require_run.git([
		"push",
		"origin",
		`HEAD:refs/heads/${branch}`
	], cwd);
}
/** The change to `paths` as a diff, new files included, for a reply on the thread. */
function diffOf(cwd, paths, max = 3e4) {
	if (paths.length === 0) return "";
	require_run.git([
		"add",
		"--intent-to-add",
		"--",
		...paths
	], cwd);
	const diff = require_run.git([
		"diff",
		"--no-color",
		"--",
		...paths
	], cwd);
	return diff.length <= max ? diff : `${diff.slice(0, max)}\n… (cut at ${max} characters)`;
}
//#endregion
//#region src/lib/bot/summary.ts
const OPEN = "<!-- aperture-bot ";
const CLOSE = " -->";
const LIMITS = {
	plan: 7,
	checks: 30,
	files: 100,
	text: 300,
	error: 1e3
};
const clip = (text, max) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;
/** The summary kept to a size a comment can always carry. */
function bounded(summary) {
	return {
		...summary,
		plan: summary.plan?.slice(0, LIMITS.plan).map((step) => clip(step, LIMITS.text)),
		checks: summary.checks?.slice(0, LIMITS.checks).map((row) => ({
			status: row.status,
			label: clip(row.label, LIMITS.text),
			detail: clip(row.detail, LIMITS.text)
		})),
		files: summary.files?.slice(0, LIMITS.files),
		error: summary.error === void 0 ? void 0 : clip(summary.error, LIMITS.error)
	};
}
/**
* The hidden line. `<` and `>` are written as JSON escapes, so nothing in the
* text can end the HTML comment early.
*/
function summaryMarker(summary) {
	const json = JSON.stringify(bounded(summary)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
	return `${OPEN}${json}${CLOSE}`;
}
/** What the bot is doing, in a few words. */
const PHASE_TEXT = {
	starting: "Reading the thread and setting up",
	planning: "Planning the change",
	building: "Making the change",
	checking: "Running Aperture Agent Check",
	fixing: "Fixing what Agent Check found",
	publishing: "Agent Check is clear: publishing"
};
/** The phase as a line, with the round when there is one. */
function phaseLine(summary) {
	return `${PHASE_TEXT[summary.phase ?? "starting"]}${(summary.phase === "checking" || summary.phase === "fixing") && summary.round ? ` (round ${summary.round}${summary.rounds ? ` of ${summary.rounds}` : ""})` : ""}.`;
}
//#endregion
//#region packages/aperture-bot/src/replies.ts
/**
* What the bot says on GitHub: the body of the pull request it opens, and its
* replies on the thread. Pure, so every wording is tested without a network.
*/
const MARK = {
	pass: "✓",
	fail: "✗",
	warn: "!",
	skip: "–"
};
const cell = (text) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const firstLine = (text) => text.split("\n")[0].trim();
const SITE = "https://aperturesais.grok.me";
/** A title for the commit and the pull request: the task's first line, or the issue's title. */
function titleFor(command) {
	const asked = firstLine(command.task);
	const title = asked.startsWith("Do what this ") ? command.title : asked;
	return title.length <= 72 ? title : `${title.slice(0, 71)}…`;
}
function checksTable(result) {
	const rows = result.check ? require_run.shownRows(result.check.rows) : [];
	if (rows.length === 0) return [];
	return [
		"| | Check | Result |",
		"|---|---|---|",
		...rows.map((row) => `| ${MARK[row.status] ?? "?"} | ${cell(row.label)} | ${cell(row.detail)} |`)
	];
}
function plan(result) {
	return result.plan.length > 0 ? ["**Plan**", ...result.plan.map((s) => `- ${s.content}`)] : [];
}
function agentSaid(result) {
	if (!result.summary.trim()) return [];
	return [
		"<details><summary>What the agent said</summary>",
		"",
		result.summary.trim(),
		"",
		"</details>"
	];
}
function footer(result, runUrl, where) {
	return `${where ? `Tests ran ${where}.` : "Tests were not run."} Used ${result.usage}. [The run](${runUrl}) · [Aperture Bot](${SITE})`;
}
/** The hidden summary of a finished run, for the Bot page. */
function resultSummary(result, ctx, link) {
	return {
		v: 1,
		state: result.outcome,
		asked: ctx.asked,
		run: ctx.run,
		plan: result.plan.map((s) => s.content),
		checks: result.check ? require_run.shownRows(result.check.rows).map((r) => ({
			status: r.status,
			label: r.label,
			detail: r.detail
		})) : [],
		files: result.written,
		link,
		tests: ctx.tests,
		usage: result.usage,
		error: result.error
	};
}
const join$1 = (...blocks) => blocks.filter((b) => b.length > 0).map((b) => b.join("\n")).join("\n\n");
function commitMessage(command, result) {
	return join$1([titleFor(command)], [`Asked by @${command.author} in #${command.number}. Checked by Aperture Agent Check.`], result.plan.length > 0 ? result.plan.map((s) => `- ${s.content}`) : []);
}
function pullBody(command, result, runUrl, where) {
	return join$1([
		`@${command.author} asked in #${command.number}:`,
		"",
		`> ${firstLine(command.task)}`
	], command.isPull ? [] : [`Fixes #${command.number}`], plan(result), [
		`**Aperture Agent Check**: ${result.check?.verdict === "clear" ? "nothing red" : "red"}.`,
		"",
		...checksTable(result)
	], agentSaid(result), [footer(result, runUrl, where)]);
}
/** While the bot works: the comment it edits as it goes, and at the end into its reply. */
function workingReply(progress, ctx) {
	return join$1([`**Aperture Bot is on it.** ${phaseLine(progress)}`], progress.plan?.length ? ["**Plan**", ...progress.plan.map((s) => `- ${s}`)] : [], [`[Follow the run](${ctx.run}) · [Aperture Bot](${SITE})`], [summaryMarker({
		v: 1,
		state: "working",
		asked: ctx.asked,
		run: ctx.run,
		...progress
	})]);
}
/** On the thread, after a pull request is opened or a commit pushed. */
function doneReply(result, link, ctx) {
	const files = result.written.map((p) => `\`${p}\``).join(", ");
	const text = link.what === "pull" ? `Opened ${link.url}, changing ${files}. Aperture Agent Check found nothing red.` : `Pushed ${link.url} to this pull request, changing ${files}. Aperture Agent Check found nothing red.`;
	return join$1([text], plan(result), [footer(result, ctx.run, ctx.tests)], [summaryMarker(resultSummary(result, ctx, link))]);
}
const OUTCOME = {
	red: "I made a change, but Aperture Agent Check is still red after my fixes, so I did not push it.",
	stopped: "I stopped before the change was finished, and pushed nothing.",
	"no-change": "I did not change any file."
};
/** On the thread, when nothing was published. */
function notDoneReply(result, diff, ctx) {
	const outcome = result.outcome === "clear" ? "no-change" : result.outcome;
	return join$1([OUTCOME[outcome]], result.error ? [`> ${result.error}`] : [], checksTable(result), result.refused.map((r) => `Refused to write \`${r.path}\`: ${r.reason}.`), diff ? [
		"<details><summary>The change I did not push</summary>",
		"",
		"```diff",
		diff,
		"```",
		"",
		"</details>"
	] : [], agentSaid(result), [footer(result, ctx.run, ctx.tests)], [summaryMarker(resultSummary(result, ctx))]);
}
function forkReply(ctx) {
	return join$1([
		"This pull request comes from a fork, so Aperture Bot will not check out its code, run it, or push to it.",
		"",
		"Ask on an issue instead, or push the branch to this repository and ask on that pull request."
	], [summaryMarker({
		v: 1,
		state: "declined",
		asked: ctx.asked,
		run: ctx.run
	})]);
}
function errorReply(message, ctx) {
	return join$1([
		"Aperture Bot stopped with an error and changed nothing:",
		"",
		`> ${message}`
	], [`[The run](${ctx.run})`], [summaryMarker({
		v: 1,
		state: "error",
		asked: ctx.asked,
		run: ctx.run,
		error: message
	})]);
}
//#endregion
//#region packages/aperture-bot/src/action.ts
/**
* Aperture Bot as a GitHub Action, on `issue_comment`. A comment that starts
* with `/aperture` from someone with write access becomes a task; the bot runs
* it on the checkout and, only when Aperture Agent Check is clear, opens a pull
* request (asked on an issue) or pushes to the pull request (asked on one).
* Otherwise it replies with what it tried and why it stopped.
*
* Settings arrive as INPUT_* variables, as GitHub passes an action's inputs.
*/
function input(env, name) {
	const value = env[`INPUT_${name.toUpperCase()}`];
	return value === void 0 || value.trim() === "" ? void 0 : value.trim();
}
function number(env, name, fallback) {
	const raw = input(env, name);
	if (raw === void 0) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number.`);
	return n;
}
function setOutput(env, values) {
	if (!env.GITHUB_OUTPUT) return;
	(0, node_fs.appendFileSync)(env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""));
}
function modelConfig(env) {
	const provider = input(env, "provider") ?? "grok";
	const allowed = [
		"grok",
		"openai",
		"anthropic",
		"gemini",
		"deepseek",
		"custom"
	];
	if (!allowed.includes(provider)) throw new Error(`provider must be one of ${allowed.join(", ")}.`);
	const cfg = {
		provider,
		apiKey: input(env, "model-key") ?? ""
	};
	if (!cfg.apiKey && provider !== "custom") throw new Error("model-key is empty. Add the model provider's key as a repository secret and pass it as model-key.");
	if (provider === "custom") {
		cfg.base = input(env, "base-url");
		cfg.model = input(env, "model");
		if (!cfg.base || !cfg.model) throw new Error("provider custom needs base-url and model.");
	}
	return cfg;
}
/** Installs the project's packages with no install scripts, when npm can and nothing is installed. */
function install(cwd, mode, log) {
	if (mode === "none" || (0, node_fs.existsSync)((0, node_path.join)(cwd, "node_modules"))) return;
	if (!(0, node_fs.existsSync)((0, node_path.join)(cwd, "package-lock.json"))) {
		log("No package-lock.json and no node_modules: tests that need packages will say so.");
		return;
	}
	log("Installing packages: npm ci --ignore-scripts");
	const run = (0, node_child_process.spawnSync)("npm", [
		"ci",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund"
	], {
		cwd,
		encoding: "utf8",
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	});
	if (run.status !== 0) throw new Error(`npm ci failed: ${(run.stderr ?? "").trim().split("\n").at(-1)}`);
}
/**
* Docker with its image pulled first, so the pull never eats into a test's
* time. Asynchronous, so the event loop keeps up with open connections while
* it waits.
*/
async function prepareDocker(image, log) {
	log(`Pulling the sandbox image ${image}`);
	const { code, stderr } = await new Promise((done) => {
		const child = (0, node_child_process.spawn)("docker", [
			"pull",
			"--quiet",
			image
		], { stdio: [
			"ignore",
			"ignore",
			"pipe"
		] });
		let err = "";
		child.stderr.on("data", (chunk) => err += chunk.toString());
		child.on("error", (error) => done({
			code: -1,
			stderr: error.message
		}));
		child.on("close", (status) => done({
			code: status,
			stderr: err
		}));
	});
	if (code !== 0) throw new Error(`the sandbox image ${image} could not be pulled: ${stderr.trim().split("\n").at(-1)}`);
	return require_run.dockerSandbox(image);
}
async function runAction(env, deps = {}) {
	const log = deps.log ?? ((line) => console.log(line));
	let payload = {};
	try {
		payload = JSON.parse((0, node_fs.readFileSync)(env.GITHUB_EVENT_PATH ?? "", "utf8"));
	} catch {}
	const parsed = parseEvent(env.GITHUB_EVENT_NAME ?? "", payload, input(env, "trigger") ?? "/aperture");
	if ("ignored" in parsed) {
		log(`Aperture Bot: nothing to do: ${parsed.ignored}`);
		setOutput(env, { outcome: "ignored" });
		return 0;
	}
	const command = parsed.command;
	const token = input(env, "github-token") ?? env.GITHUB_TOKEN;
	if (!token) throw new Error("github-token is empty.");
	const gh = new GitHub({
		owner: command.owner,
		repo: command.repo
	}, token, env.GITHUB_API_URL ?? "https://api.github.com", deps.fetch);
	const permission = await gh.permission(command.author);
	if (!canWrite(permission)) {
		log(`Aperture Bot: @${command.author} has ${permission} access; only people who can write may ask.`);
		setOutput(env, { outcome: "ignored" });
		return 0;
	}
	await gh.react(command.commentId, "eyes").catch(() => void 0);
	const repoUrl = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${command.owner}/${command.repo}`;
	const runUrl = env.GITHUB_RUN_ID ? `${repoUrl}/actions/runs/${env.GITHUB_RUN_ID}` : repoUrl;
	const cwd = (0, node_path.resolve)(input(env, "working-directory") ?? env.GITHUB_WORKSPACE ?? process.cwd());
	const asked = {
		asked: command.commentId,
		run: runUrl
	};
	let status = null;
	let edits = Promise.resolve();
	const reply = async (body) => {
		await edits;
		if (status === null) await gh.comment(command.number, body);
		else await gh.editComment(status, body);
	};
	const report = (progress) => {
		if (status === null) return Promise.resolve();
		const id = status;
		edits = edits.then(() => gh.editComment(id, workingReply(progress, asked))).catch(() => void 0);
		return edits;
	};
	try {
		const model = modelConfig(env);
		let pull = null;
		let diff = null;
		if (command.isPull) {
			pull = await gh.pull(command.number);
			if (pull.headRepo.toLowerCase() !== `${command.owner}/${command.repo}`.toLowerCase()) {
				await gh.comment(command.number, forkReply(asked));
				setOutput(env, { outcome: "declined" });
				return 0;
			}
		}
		status = await gh.comment(command.number, workingReply({ phase: "starting" }, asked)).then((posted) => Number.isSafeInteger(posted.id) ? posted.id : null).catch(() => null);
		if (pull) {
			checkoutPullHead(cwd, pull.headRef);
			diff = await gh.diff(command.number);
		}
		install(cwd, input(env, "install") ?? "auto", log);
		const sandbox = deps.sandbox !== void 0 ? deps.sandbox : await prepareDocker(input(env, "sandbox-image") ?? "mirror.gcr.io/library/node:22-slim", log);
		const comments = await gh.comments(command.number);
		log(`Aperture Bot: working on #${command.number} for @${command.author}: ${command.task}`);
		const result = await require_run.runTask({
			cwd,
			task: command.task,
			context: threadContext(command, comments, diff),
			model,
			sandbox,
			testScript: input(env, "test-script") ?? "test",
			timeoutMs: number(env, "timeout-minutes", 10) * 6e4,
			maxTokens: number(env, "max-tokens", 1e6),
			rounds: Math.floor(number(env, "rounds", 2))
		}, {
			model: deps.model,
			onProgress: report
		});
		log(result.text);
		if (env.GITHUB_STEP_SUMMARY) (0, node_fs.appendFileSync)(env.GITHUB_STEP_SUMMARY, `### Aperture Bot\n\n\`\`\`\n${result.text}\n\`\`\`\n`);
		const ctx = {
			...asked,
			tests: sandbox?.where ?? null
		};
		if (result.outcome === "clear") {
			await report({
				phase: "publishing",
				plan: result.plan.map((s) => s.content)
			});
			const sha = commitFiles(cwd, result.written, commitMessage(command, result));
			if (pull) {
				push(cwd, pull.headRef);
				await reply(doneReply(result, {
					url: `${repoUrl}/commit/${sha}`,
					what: "commit"
				}, ctx));
				setOutput(env, {
					outcome: "clear",
					commit: sha
				});
			} else {
				const branch = freeBranch(cwd, command.number, titleFor(command));
				push(cwd, branch);
				const opened = await gh.createPull({
					title: titleFor(command),
					head: branch,
					base: command.defaultBranch,
					body: pullBody(command, result, runUrl, ctx.tests)
				});
				await reply(doneReply(result, {
					url: opened.url,
					what: "pull"
				}, ctx));
				setOutput(env, {
					outcome: "clear",
					"pull-request": opened.url,
					commit: sha
				});
			}
			return 0;
		}
		await reply(notDoneReply(result, diffOf(cwd, result.written), ctx));
		setOutput(env, { outcome: result.outcome });
		return result.outcome === "no-change" ? 0 : 1;
	} catch (error) {
		let message = require_run.describeError(error);
		if (error instanceof GitHubError && error.status === 403 && /POST \S+\/pulls/.test(message)) message += " Turn on \"Allow GitHub Actions to create and approve pull requests\" in the repository's Settings, under Actions, General, or pass a token that can.";
		log(`Aperture Bot: ${message}`);
		await reply(errorReply(message, asked)).catch(() => void 0);
		setOutput(env, { outcome: "error" });
		return 1;
	}
}
//#endregion
//#region packages/aperture-bot/src/action-entry.ts
/**
* The Action's entry point: dist/action.cjs, which action.yml runs.
*/
runAction(process.env).then((code) => {
	process.exitCode = code;
}, (error) => {
	console.log(`::error title=Aperture Bot::${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 2;
});
//#endregion
