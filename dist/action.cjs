const require_run = require("./run-63Xqn35Z.cjs");
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
const DEFAULT_LABEL = "aperture";
/** The task after the trigger, or null when the comment does not start with it. */
function taskFrom(body, trigger = DEFAULT_TRIGGER) {
	const text = body.trimStart();
	if (!text.toLowerCase().startsWith(trigger.toLowerCase())) return null;
	const rest = text.slice(trigger.length);
	if (rest !== "" && !/^\s/.test(rest)) return null;
	return rest.trim();
}
/**
* `/aperture check`: the first line is the word alone, so "check the login
* flow" stays a task, and a signature or footer under it changes nothing.
*/
function isCheck(task) {
	return /^check[.!]?$/i.test(task.trim().split("\n")[0].trim());
}
function parseEvent(name, payload, trigger = DEFAULT_TRIGGER, label = DEFAULT_LABEL) {
	if (name === "schedule" || name === "workflow_dispatch") return { scheduled: true };
	if (name === "issues") return labelled(payload, label);
	if (name === "pull_request") return pushed(payload);
	if (name !== "issue_comment") return { ignored: `${name} events are not commands; the bot answers comments, its label, its schedule and pull requests.` };
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
	const check = isCheck(task);
	return { command: {
		number: issue.number,
		isPull: Boolean(issue.pull_request),
		title,
		body: issue.body ?? "",
		task: check ? "Check this pull request" : task || `Do what this ${issue.pull_request ? "pull request" : "issue"} asks: ${title}`,
		commentId: event.comment.id,
		author: user.login,
		via: "comment",
		...check ? { check: true } : {},
		owner: repo.owner.login,
		repo: repo.name,
		defaultBranch: repo.default_branch ?? "main"
	} };
}
/** The pull requests that change: checked on every push, for whoever pushed. */
const PULL_ACTIONS = /* @__PURE__ */ new Set([
	"opened",
	"synchronize",
	"reopened",
	"ready_for_review"
]);
/** A pull request opened or pushed to: check it, as the "check every pull request" job. */
function pushed(payload) {
	const event = payload ?? {};
	if (!PULL_ACTIONS.has(event.action ?? "")) return { ignored: `a pull request ${event.action ?? "event"} changes no code to check.` };
	if (event.sender?.type === "Bot") return { ignored: "pushes by bots are not checked." };
	const pull = event.pull_request;
	const repo = event.repository;
	if (!pull?.number || !event.sender?.login || !repo?.name || !repo.owner?.login) return { ignored: "the event is missing the pull request, sender or repository." };
	if (pull.draft) return { ignored: "drafts are checked once they are ready for review." };
	return { command: {
		number: pull.number,
		isPull: true,
		title: pull.title ?? "",
		body: pull.body ?? "",
		task: "Check this pull request",
		commentId: null,
		author: event.sender.login,
		via: "pull",
		check: true,
		owner: repo.owner.login,
		repo: repo.name,
		defaultBranch: repo.default_branch ?? "main"
	} };
}
/** An issue given the bot's label: do what it asks, for whoever added the label. */
function labelled(payload, label) {
	const event = payload ?? {};
	if (event.action !== "labeled") return { ignored: "only an added label is a command." };
	const added = event.label?.name ?? "";
	if (added.toLowerCase() !== label.toLowerCase()) return { ignored: `the label ${added || "(none)"} is not ${label}.` };
	if (event.sender?.type === "Bot") return { ignored: "labels added by bots are not commands." };
	const issue = event.issue;
	const repo = event.repository;
	if (!issue?.number || !event.sender?.login || !repo?.name || !repo.owner?.login) return { ignored: "the event is missing the issue, sender or repository." };
	if (issue.pull_request) return { ignored: "the label only asks on issues." };
	const title = issue.title ?? "";
	return { command: {
		number: issue.number,
		isPull: false,
		title,
		body: issue.body ?? "",
		task: `Do what this issue asks: ${title}`,
		commentId: null,
		author: event.sender.login,
		via: "label",
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
	/**
	* Every page of a list, oldest first as GitHub gives them, up to `max`
	* pages of 100: one page would miss the newest comments on a long thread,
	* or a job's tracking issue in a busy repository.
	*/
	async all(path, max = 10) {
		const out = [];
		const sep = path.includes("?") ? "&" : "?";
		for (let page = 1; page <= max; page++) {
			const items = await this.call("GET", `${path}${sep}per_page=100&page=${page}`);
			out.push(...items);
			if (items.length < 100) break;
		}
		return out;
	}
	async comments(issue) {
		return (await this.all(`${this.base}/issues/${issue}/comments`)).map((c) => ({
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
	/** Posts a comment; `by` is who the token posts as, which names the bot's commits. */
	async comment(issue, body) {
		const out = await this.call("POST", `${this.base}/issues/${issue}/comments`, { body });
		const by = out.user?.login && typeof out.user.id === "number" ? {
			login: out.user.login,
			id: out.user.id
		} : null;
		return {
			id: out.id,
			url: out.html_url,
			by
		};
	}
	async defaultBranch() {
		return (await this.call("GET", this.base)).default_branch ?? "main";
	}
	/** The commit a branch points at. */
	async head(branch) {
		return (await this.call("GET", `${this.base}/branches/${encodeURIComponent(branch)}`)).commit?.sha ?? "";
	}
	/** The checks and statuses on a commit that finished red, with what they said. */
	async failures(sha) {
		const [runs, status] = await Promise.all([this.call("GET", `${this.base}/commits/${sha}/check-runs?per_page=100`), this.call("GET", `${this.base}/commits/${sha}/status`)]);
		const out = [];
		for (const run of runs.check_runs ?? []) {
			if (run.status !== "completed" || !["failure", "timed_out"].includes(run.conclusion ?? "")) continue;
			const notes = await this.call("GET", `${this.base}/check-runs/${run.id}/annotations?per_page=20`).catch(() => []);
			out.push({
				name: run.name,
				detail: [run.output?.title, run.output?.summary].filter(Boolean).join("\n"),
				annotations: notes.map((n) => `${n.path}:${n.start_line ?? 1}: ${n.message ?? ""}`)
			});
		}
		for (const s of status.statuses ?? []) if (s.state === "failure" || s.state === "error") out.push({
			name: s.context,
			detail: s.description ?? "",
			annotations: []
		});
		return out;
	}
	async openIssues() {
		return (await this.all(`${this.base}/issues?state=open`)).map((i) => ({
			number: i.number,
			title: i.title,
			isPull: Boolean(i.pull_request)
		}));
	}
	async createIssue(title, body) {
		return (await this.call("POST", `${this.base}/issues`, {
			title,
			body
		})).number;
	}
	/** Open pull requests from this repository's branches: their branch and page. */
	async openPulls() {
		return (await this.all(`${this.base}/pulls?state=open`)).map((p) => ({
			headRef: p.head.ref,
			url: p.html_url
		}));
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
		task: summary.task === void 0 ? void 0 : clip(summary.task, LIMITS.error),
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
const STATES = /* @__PURE__ */ new Set([
	"working",
	"clear",
	"red",
	"stopped",
	"no-change",
	"declined",
	"error"
]);
function isString(value) {
	return typeof value === "string";
}
const strings = (value) => Array.isArray(value) ? value.filter(isString) : void 0;
/**
* The summary a comment carries, or null when it has none. Comments are
* written by anyone who can comment, so every field is checked, and only a
* github.com link is kept.
*/
function readSummary(body) {
	const start = body.lastIndexOf(OPEN);
	if (start < 0) return null;
	const end = body.indexOf(CLOSE, start + 18);
	if (end < 0) return null;
	let raw;
	try {
		raw = JSON.parse(body.slice(start + 18, end));
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw;
	if (r.v !== 1 || typeof r.state !== "string" || !STATES.has(r.state)) return null;
	if (typeof r.asked !== "number" || !Number.isSafeInteger(r.asked)) return null;
	const out = {
		v: 1,
		state: r.state,
		asked: r.asked,
		run: isGithubUrl(r.run) ? r.run : ""
	};
	if (r.kind === "check") out.kind = "check";
	if (r.via === "label" || r.via === "schedule" || r.via === "pull") out.via = r.via;
	if (typeof r.by === "string") out.by = r.by.slice(0, 100);
	if (typeof r.task === "string") out.task = r.task;
	if (typeof r.phase === "string" && r.phase in PHASE_TEXT) out.phase = r.phase;
	if (typeof r.round === "number") out.round = r.round;
	if (typeof r.rounds === "number") out.rounds = r.rounds;
	out.plan = strings(r.plan);
	out.files = strings(r.files);
	if (Array.isArray(r.checks)) out.checks = r.checks.flatMap((row) => {
		const c = row;
		return typeof c?.status === "string" && typeof c.label === "string" && typeof c.detail === "string" ? [{
			status: c.status,
			label: c.label,
			detail: c.detail
		}] : [];
	});
	const link = r.link;
	if (link && isGithubUrl(link.url) && (link.what === "pull" || link.what === "commit")) out.link = {
		url: link.url,
		what: link.what
	};
	if (typeof r.tests === "string" || r.tests === null) out.tests = r.tests;
	if (typeof r.usage === "string") out.usage = r.usage;
	if (typeof r.error === "string") out.error = r.error;
	return out;
}
function isGithubUrl(value) {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.hostname === "github.com";
	} catch {
		return false;
	}
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
/**
* The commit author for whoever the token posts as: a GitHub App's bot user
* (`my-app[bot]`), so its commits show the app's name and avatar, or else
* the workflow's own identity.
*/
function authorFor(poster) {
	if (!poster || !poster.login.endsWith("[bot]") || poster.login === "github-actions[bot]") return BOT_AUTHOR;
	return {
		name: "Aperture Bot",
		email: `${poster.id}+${poster.login}@users.noreply.github.com`
	};
}
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
/**
* Fetches a pull request's base branch, with the history Agent Check needs to
* find where the two meet: actions/checkout clones one commit deep, so a
* shallow checkout is deepened first. Returns the ref to compare against.
*/
function fetchBase(cwd, ref) {
	const spec = `+refs/heads/${ref}:refs/remotes/origin/${ref}`;
	const shallow = require_run.git(["rev-parse", "--is-shallow-repository"], cwd).trim() === "true";
	require_run.git([
		"fetch",
		"--no-tags",
		...shallow ? ["--unshallow"] : [],
		"origin",
		spec
	], cwd);
	return `refs/remotes/origin/${ref}`;
}
/** Commits exactly `paths` (relative to `cwd`) and returns the commit. */
function commitFiles(cwd, paths, message, author = BOT_AUTHOR) {
	require_run.git([
		"add",
		"--",
		...paths
	], cwd);
	require_run.git([
		"-c",
		`user.name=${author.name}`,
		"-c",
		`user.email=${author.email}`,
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
//#region packages/aperture-bot/src/replies.ts
const MARK = {
	pass: "✓",
	fail: "✗",
	warn: "!",
	skip: "–"
};
const cell = (text) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const firstLine = (text) => text.split("\n")[0].trim();
const SITE = "https://aperturesais.grok.me";
/** How the asking reads in a commit or a pull request: who asked, and how. */
function askedBy(command) {
	if (command.via === "label") return `@${command.author} labelled #${command.number} for the bot`;
	if (command.via === "schedule") return `A standing job, on #${command.number}`;
	if (command.via === "pull") return `@${command.author} pushed to #${command.number}`;
	return `@${command.author} asked in #${command.number}`;
}
/** The fields of a summary that say who asked, when no comment did. */
const askedFields = (ctx) => ctx.via ? {
	via: ctx.via,
	by: ctx.by,
	task: ctx.task
} : {};
/** A title for the commit and the pull request: the task's first line, or the issue's title. */
function titleFor(command) {
	if (command.via === "schedule") {
		const job = command.title.replace(/^Aperture Bot: /, "");
		return `${job.charAt(0).toUpperCase()}${job.slice(1)}`.slice(0, 72);
	}
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
		...askedFields(ctx),
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
	return join$1([titleFor(command)], [`${askedBy(command)}. Checked by Aperture Agent Check.`], result.plan.length > 0 ? result.plan.map((s) => `- ${s.content}`) : []);
}
function pullBody(command, result, runUrl, where) {
	return join$1([
		`${askedBy(command)}:`,
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
		...askedFields(ctx),
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
/** `/aperture check` on an issue: there is no change to check. */
function notPullReply(ctx) {
	return join$1([
		"`/aperture check` runs Aperture Agent Check on a pull request, and this is an issue, so there is nothing to check.",
		"",
		"Comment it on the pull request instead, or say what to do after `/aperture` and the bot will make the change."
	], [summaryMarker({
		v: 1,
		state: "declined",
		kind: "check",
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
		...askedFields(ctx),
		error: message
	})]);
}
/**
* Aperture Agent Check on a pull request, asked with `/aperture check` or by a
* push: its report, and nothing changed.
*/
function checkReply(check, ctx) {
	const report = check.rows.length > 0 ? require_run.summaryMarkdown(check.rows, check.meta).trim() : `### Aperture Agent Check\n\n${check.text.replace(/^Aperture Agent Check: /, "")}`;
	const tests = ctx.tests ? `Tests ran ${ctx.tests}.` : "Tests were not run.";
	return join$1([report], [`${tests} Nothing was changed. [The run](${ctx.run}) · [Aperture Bot](${SITE})`], [summaryMarker({
		v: 1,
		state: check.verdict,
		kind: "check",
		asked: ctx.asked,
		run: ctx.run,
		...askedFields(ctx),
		checks: require_run.shownRows(check.rows).map((r) => ({
			status: r.status,
			label: r.label,
			detail: r.detail
		})),
		tests: ctx.tests
	})]);
}
//#endregion
//#region packages/aperture-bot/src/jobs.ts
function jobFrom(scheduled) {
	const text = scheduled?.trim() ?? "";
	if (!text) return null;
	return text.toLowerCase() === "fix-ci" ? { kind: "fix-ci" } : {
		kind: "task",
		task: text
	};
}
function jobTitle(job, branch) {
	if (job.kind === "fix-ci") return `Aperture Bot: fix what is red on ${branch}`;
	const first = job.task.split("\n")[0].trim();
	return `Aperture Bot: ${first.length <= 60 ? first : `${first.slice(0, 59)}…`}`;
}
const MAX_FAILURES = 8;
const MAX_ANNOTATIONS = 10;
const DETAIL_CHARS = 1500;
/** The task for a red branch: which checks fail, and what they said. */
function fixCiTask(branch, sha, failures) {
	const lines = [
		`These checks fail on ${branch} at ${sha.slice(0, 7)}. Find why in the code, and fix it so they pass.`,
		"Never skip, delete or weaken a test to get there: if a test is wrong, say why in your answer and leave it.",
		""
	];
	for (const f of failures.slice(0, MAX_FAILURES)) {
		lines.push(`- ${f.name}`);
		if (f.detail.trim()) lines.push(`  ${f.detail.trim().slice(0, DETAIL_CHARS).replace(/\n/g, "\n  ")}`);
		for (const a of f.annotations.slice(0, MAX_ANNOTATIONS)) lines.push(`  ${a}`);
	}
	if (failures.length > MAX_FAILURES) lines.push(`- and ${failures.length - MAX_FAILURES} more`);
	return lines.join("\n");
}
/** The command a job comes to on this run, or why it does nothing. */
async function planJob(gh, job, repo) {
	const branch = await gh.defaultBranch();
	let task = job.kind === "task" ? job.task : "";
	let body = job.kind === "task" ? `A standing job for Aperture Bot, run on the workflow's schedule:\n\n> ${job.task.replace(/\n/g, "\n> ")}` : "";
	if (job.kind === "fix-ci") {
		const sha = await gh.head(branch);
		const failures = sha ? await gh.failures(sha) : [];
		if (failures.length === 0) return { skip: `${branch} is green: nothing to fix.` };
		task = fixCiTask(branch, sha, failures);
		body = `Aperture Bot's nightly job found checks failing on ${branch}.\n\n${task}`;
	}
	const title = jobTitle(job, branch);
	const existing = (await gh.openIssues()).find((i) => !i.isPull && i.title === title);
	if (existing) {
		const waiting = (await gh.openPulls()).find((p) => p.headRef.startsWith(`aperture/${existing.number}-`));
		if (waiting) return { skip: `a pull request for #${existing.number} is waiting for review: ${waiting.url}` };
	}
	return { command: {
		number: existing?.number ?? await gh.createIssue(title, body),
		isPull: false,
		title,
		body,
		task,
		commentId: null,
		author: "schedule",
		via: "schedule",
		owner: repo.owner,
		repo: repo.repo,
		defaultBranch: branch
	} };
}
//#endregion
//#region packages/aperture-bot/src/action.ts
/**
* Aperture Bot as a GitHub Action. A comment that starts with `/aperture`, or
* the `aperture` label on an issue, from someone with write access becomes a
* task; so does the workflow's schedule, with its `scheduled` job (jobs.ts).
* The bot runs it on the checkout and, only when Aperture Agent Check is
* clear, opens a pull request (asked on an issue) or pushes to the pull
* request (asked on one). Otherwise it replies with what it tried and why it
* stopped. `/aperture check` on a pull request, or a push to one, runs Agent
* Check alone and replies with its report: no model, and no change.
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
	if (!cfg.apiKey && provider !== "custom") throw new Error("model-key is empty: the secret the workflow passes as model-key is not set. Add it under the repository's Settings, Secrets and variables, Actions, as a repository secret with the name the workflow's model-key line uses (XAI_API_KEY for Grok).");
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
	const parsed = parseEvent(env.GITHUB_EVENT_NAME ?? "", payload, input(env, "trigger") ?? "/aperture", input(env, "label") ?? "aperture");
	const ignore = (why) => {
		log(`Aperture Bot: nothing to do: ${why}`);
		setOutput(env, { outcome: "ignored" });
		return 0;
	};
	if ("ignored" in parsed) return ignore(parsed.ignored);
	const job = "scheduled" in parsed ? jobFrom(input(env, "scheduled")) : null;
	if ("scheduled" in parsed && !job) return ignore("the workflow ran on its schedule, but its scheduled input is empty.");
	const [owner, name] = "command" in parsed ? [parsed.command.owner, parsed.command.repo] : (env.GITHUB_REPOSITORY ?? "").split("/");
	if (!owner || !name) throw new Error("GITHUB_REPOSITORY is not owner/repo.");
	const token = input(env, "github-token") ?? env.GITHUB_TOKEN;
	if (!token) throw new Error("github-token is empty.");
	const gh = new GitHub({
		owner,
		repo: name
	}, token, env.GITHUB_API_URL ?? "https://api.github.com", deps.fetch);
	let command;
	if ("command" in parsed) {
		command = parsed.command;
		const permission = await gh.permission(command.author);
		if (!canWrite(permission)) {
			log(`Aperture Bot: @${command.author} has ${permission} access; only people who can write may ask.`);
			setOutput(env, { outcome: "ignored" });
			return 0;
		}
		if (command.commentId !== null) await gh.react(command.commentId, "eyes").catch(() => void 0);
	} else {
		const planned = await planJob(gh, job, {
			owner,
			repo: name
		});
		if ("skip" in planned) return ignore(planned.skip);
		command = planned.command;
	}
	const repoUrl = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${command.owner}/${command.repo}`;
	const runUrl = env.GITHUB_RUN_ID ? `${repoUrl}/actions/runs/${env.GITHUB_RUN_ID}` : repoUrl;
	const cwd = (0, node_path.resolve)(input(env, "working-directory") ?? env.GITHUB_WORKSPACE ?? process.cwd());
	const asked = {
		asked: command.commentId ?? 0,
		run: runUrl,
		...command.via === "comment" ? {} : {
			via: command.via,
			by: command.author,
			task: command.task
		}
	};
	let status = null;
	/** Who the token posts as: a GitHub App's bot, or the workflow's. */
	let poster = null;
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
	const sandboxFor = async () => deps.sandbox !== void 0 ? deps.sandbox : await prepareDocker(input(env, "sandbox-image") ?? "mirror.gcr.io/library/node:22-slim", log);
	/**
	* Agent Check on the pull request's head, against its base: the report is
	* the reply. A push's report replaces the last push's, so the thread keeps
	* one, not one per push.
	*/
	const checkPull = async () => {
		if (!command.isPull) {
			await gh.comment(command.number, notPullReply(asked));
			setOutput(env, { outcome: "declined" });
			return 0;
		}
		const pull = await gh.pull(command.number);
		if (pull.headRepo.toLowerCase() !== `${command.owner}/${command.repo}`.toLowerCase()) {
			await gh.comment(command.number, forkReply(asked));
			setOutput(env, { outcome: "declined" });
			return 0;
		}
		const working = workingReply({ phase: "checking" }, asked);
		if (command.via === "pull") {
			const earlier = (await gh.comments(command.number)).filter((c) => {
				const s = c.authorType === "Bot" ? readSummary(c.body) : null;
				return s?.kind === "check" && s.via === "pull";
			}).at(-1);
			if (earlier) status = await gh.editComment(earlier.id, working).then(() => earlier.id).catch(() => null);
		}
		if (status === null) status = await gh.comment(command.number, working).then((posted) => Number.isSafeInteger(posted.id) ? posted.id : null).catch(() => null);
		checkoutPullHead(cwd, pull.headRef);
		const base = fetchBase(cwd, pull.baseRef);
		install(cwd, input(env, "install") ?? "auto", log);
		const sandbox = await sandboxFor();
		log(`Aperture Bot: checking #${command.number} for @${command.author}`);
		const result = require_run.check({
			cwd,
			base,
			runTests: sandbox !== null,
			testScript: input(env, "test-script") ?? "test",
			timeoutMs: number(env, "timeout-minutes", 10) * 6e4,
			failOn: "red",
			testRunner: sandbox ? require_run.asTestRunner(sandbox) : void 0,
			testsWhere: sandbox?.where
		});
		log(result.text);
		if (env.GITHUB_STEP_SUMMARY) (0, node_fs.appendFileSync)(env.GITHUB_STEP_SUMMARY, result.rows.length > 0 ? require_run.summaryMarkdown(result.rows, result.meta) : `### Aperture Agent Check\n\n${result.text.replace(/^Aperture Agent Check: /, "")}\n`);
		await reply(checkReply(result, {
			...asked,
			tests: sandbox?.where ?? null
		}));
		setOutput(env, {
			outcome: result.verdict,
			verdict: result.verdict
		});
		return result.exitCode;
	};
	try {
		if (command.check) return await checkPull();
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
		status = await gh.comment(command.number, workingReply({ phase: "starting" }, asked)).then((posted) => {
			poster = posted.by;
			return Number.isSafeInteger(posted.id) ? posted.id : null;
		}).catch(() => null);
		if (pull) {
			checkoutPullHead(cwd, pull.headRef);
			diff = await gh.diff(command.number);
		}
		install(cwd, input(env, "install") ?? "auto", log);
		const sandbox = await sandboxFor();
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
			const sha = commitFiles(cwd, result.written, commitMessage(command, result), authorFor(poster));
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
