import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

/** Portable default memory location under the DSH home (`$DSH_HOME` or `~/.dsh`). */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const DEFAULT_MEMORY_FILE = path.join(DSH_HOME, 'dsh-memory', 'memory.json');

/** Cordis plugin name (must be unique; it becomes the row id component). */
const name = 'token-stack';

/** Hard dependencies. `settings`/`tools`/`tokenMeter` are host services; `fs`/`systemPrompt` are the seams this plugin consumes. */
const inject = ['systemPrompt', 'fs', 'settings', 'tools', 'tokenMeter', 'commands', 'webServer'];

/** Composition-authored config (row-level). */
const Config = z.object({
	terse: z.boolean().default(true),
	memory: z.boolean().default(true),
	filter: z.boolean().default(true),
	memoryFile: z.string().default(DEFAULT_MEMORY_FILE),
	memoryMaxItems: z.number().default(40),
	recallLimit: z.number().default(3),
	textMaxChars: z.number().default(6000),
	minimumTextChars: z.number().default(100),
});

/** Runtime-toggleable settings via the native settings service. */
const SettingsSchema = z.object({
	terse: z.boolean().default(true),
	memory: z.boolean().default(true),
	filter: z.boolean().default(true),
	recallLimit: z.number().default(3),
	// A/B control condition: when true every layer is disabled, so the same task
	// can be run with the stack off and compared against a normal run.
	abControl: z.boolean().default(false),
});

function apply(ctx, config) {
	// Register the runtime settings namespace backed by the native settings service.
	const settingsScope = ctx.settings.register('tokenStack', SettingsSchema, {
		base: {
			default: {
				terse: config.terse,
				memory: config.memory,
				filter: config.filter,
				recallLimit: config.recallLimit,
				abControl: false,
			},
		},
	});

	const rt = () => {
		const s = ctx.settings.get('tokenStack') || {};
		const control = s.abControl === true;
		return {
			control: control,
			terse: control ? false : (s.terse ?? config.terse),
			memory: control ? false : (s.memory ?? config.memory),
			filter: control ? false : (s.filter ?? config.filter),
			recallLimit: s.recallLimit ?? config.recallLimit,
		};
	};

	let memoryCache = [];
	let memTarget = null;

	// ---- helpers ----
	async function readJson(path, fallback) {
		try {
			const t = await ctx.fs.resolve(path);
			const raw = await ctx.fs.readText(t);
			return raw ? JSON.parse(raw) : fallback;
		} catch (e) {
			return fallback;
		}
	}
	async function writeJson(target, data) {
		try {
			await ctx.fs.writeText(target, JSON.stringify(data, null, 2));
		} catch (e) {
			console.log('[token-stack] write failed', String(e));
		}
	}
	async function loadAll() {
		try { memTarget = await ctx.fs.resolve(config.memoryFile); } catch (e) {}
		const raw = await readJson(config.memoryFile, []);
		memoryCache = Array.isArray(raw) ? raw : [];
		try { statsTarget = await ctx.fs.resolve(path.join(DSH_HOME, 'dsh-memory', 'stats.json')); } catch (e) {}
		const prior = await readJson(path.join(DSH_HOME, 'dsh-memory', 'stats.json'), null);
		if (prior && typeof prior === 'object') stats = Object.assign(stats, prior);
	}
	function persistMemory() { if (memTarget) writeJson(memTarget, memoryCache); }

	// ---- stats: what this plugin MEASURABLY saved vs. only cost ----
	// `filter.tokensSaved` is a precise estimate of tool-output tokens removed
	// before the model saw them. Memory injection is a measured COST; how much the
	// memory "saved" is counterfactual. Terse output savings need an A/B test.
	let stats = {
		since: Date.now(),
		filter: { calls: 0, tokensSaved: 0, byTool: {} },
		memory: { sessionsInjected: 0, tokensInjected: 0, entriesAdded: 0, dedupHits: 0, recalls: 0, byTool: {} },
		bySession: {},
		terse: { measured: false, note: 'output-token savings require an on/off A/B comparison' },
	};
	let statsTarget = null;
	function estimate(blocks) {
		try {
			if (!Array.isArray(blocks) || blocks.length === 0) return 0;
			// estimateMessage only reads `content`; role framing is a constant that cancels in a delta.
			return ctx.tokenMeter.estimateMessage({ content: blocks });
		} catch (e) {
			return 0;
		}
	}
	/** Session id for a tool execution, as a plain string ('unknown' when absent). */
	function sessionKey(exec) {
		try {
			return (exec && exec.agent && exec.agent.id) ? String(exec.agent.id) : 'unknown';
		} catch (e) {
			return 'unknown';
		}
	}
	function bumpTool(bucket, toolName, field, amount) {
		const key = toolName || 'unknown';
		const entry = bucket[key] || (bucket[key] = {});
		entry[field] = (entry[field] || 0) + (amount === undefined ? 1 : amount);
	}
	function sessionStat(sid) {
		return stats.bySession[sid] || (stats.bySession[sid] = { filterCalls: 0, tokensSaved: 0, memoryEntries: 0 });
	}
	/** Keep the breakdown maps bounded (top-N by activity) before every persist. */
	function trimStats() {
		const trim = (obj, n, score) => {
			const keys = Object.keys(obj);
			if (keys.length <= n) return;
			keys.sort((a, b) => score(obj[b]) - score(obj[a]));
			for (const k of keys.slice(n)) delete obj[k];
		};
		trim(stats.filter.byTool, 30, (v) => v.tokensSaved || 0);
		trim(stats.memory.byTool, 30, (v) => v.count || 0);
		trim(stats.bySession, 50, (v) => (v.tokensSaved || 0) + (v.filterCalls || 0) * 5 + (v.memoryEntries || 0) * 5);
	}
	function persistStats() { trimStats(); if (statsTarget) writeJson(statsTarget, stats); }

	// ---- capture: raw tool evidence, filtered to substantive project facts ----
	const META_PREFIXES = ['cordis_'];
	const META_NAMES = new Set([
		'todo_write', 'skill', 'list_agents', 'subagent', 'subagent_fork',
		'create_goal', 'update_goal', 'get_goal', 'job_list', 'job_output', 'job_kill',
		'workflow', 'ralph', 'interrupt_agent', 'send_message', 'ask_user_question',
		'exit_plan_mode', 'read_image', 'modlens_read_image',
	]);
	function isMetaTool(t) { if (!t) return true; if (META_PREFIXES.some((p) => t.startsWith(p))) return true; return META_NAMES.has(t); }
	function isSelfReference(tool, text) { return tool === 'read' && text.indexOf('memory.json') >= 0; }
	function extractText(blocks) {
		if (!Array.isArray(blocks)) return '';
		return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
	}
	function isDuplicate(tool, text) {
		const key = (tool || '') + ':' + text.slice(0, 120);
		return memoryCache.some((it) => (it.tool || '') + ':' + String(it.text || '').slice(0, 120) === key);
	}
	function recordMemory(exec, result) {
		const s = rt();
		if (!s.memory) return;
		const tool = exec && exec.name ? exec.name : 'unknown';
		if (isMetaTool(tool)) return;
		const text = result && result.content ? extractText(result.content) : '';
		if (!text) return;
		if (isSelfReference(tool, text)) return;
		if (text.length < config.minimumTextChars) return;
		const compact = text.slice(0, 400);
		if (isDuplicate(tool, compact)) {
			stats.memory.dedupHits++;
			bumpTool(stats.memory.byTool, tool, 'dedupHits', 1);
			return;
		}
		memoryCache.unshift({ ts: Date.now(), kind: 'tool', tool, text: compact });
		stats.memory.entriesAdded++;
		bumpTool(stats.memory.byTool, tool, 'count', 1);
		sessionStat(sessionKey(exec)).memoryEntries++;
		if (memoryCache.length > config.memoryMaxItems) memoryCache.length = config.memoryMaxItems;
		persistMemory();
	}

	ctx.on('tools/result', (exec, result) => recordMemory(exec, result));
	ctx.on('agent/turn-stopping', () => { persistStats(); if (rt().memory) return persistMemory(); });

	// ---- recall: curated entry priority + recency + tags ----
	function recall() {
		const now = Date.now();
		const scored = memoryCache.map((it) => {
			let s = 0;
			if (it.kind === 'fact' || it.kind === 'constraint') s += 5;
			else if (it.kind === 'preference') s += 4;
			else s += 1;
			if (now - (it.ts || 0) < 30 * 60 * 1000) s += 1;
			if (it.tags && it.tags.length) s += 1;
			return { it, s };
		});
		scored.sort((a, b) => b.s - a.s);
		return scored.slice(0, rt().recallLimit).map((x) => x.it);
	}

	// ---- LLM-driven compression: model distills a durable entry via this tool ----
	async function remember(args) {
		const kind = args && args.kind;
		const text = args && args.text;
		const tags = Array.isArray(args && args.tags) ? args.tags : [];
		if (kind !== 'fact' && kind !== 'preference' && kind !== 'constraint') return 'kind must be fact | preference | constraint';
		if (!text || String(text).length < 4) return 'text too short';
		memoryCache.unshift({ ts: Date.now(), kind, text: String(text).slice(0, 400), tags });
		stats.memory.entriesAdded++;
		if (memoryCache.length > config.memoryMaxItems) memoryCache.length = config.memoryMaxItems;
		if (memTarget) await writeJson(memTarget, memoryCache);
		return 'remembered [' + kind + '] ' + text;
	}

	const rememberTool = {
		name: 'token_stack_remember',
		description: 'Persist one durable cross-session memory entry (an LLM-compressed fact/preference/constraint) so future sessions can reuse it. Use for project constraints, decisions, user preferences, and non-obvious gotchas; do not store secrets.',
		parameters: {
			type: 'object',
			properties: {
				kind: { type: 'string', enum: ['fact', 'preference', 'constraint'], description: 'category of the fact' },
				text: { type: 'string', description: 'one concise durable fact' },
				tags: { type: 'array', items: { type: 'string' }, description: 'optional labels' },
			},
			required: ['kind', 'text'],
		},
		output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
		execute: (args) => remember(args),
		// avoid accidental parallel overwrites of the shared memory cache
		isConcurrencySafe: () => false,
	};
	ctx.effect(() => ctx.tools.register(rememberTool), 'token-stack.remember-tool');

	const configTool = {
		name: 'token_stack_config',
		description: 'Read or update the token-stack toggles via the native settings service: terse, memory, filter (booleans), recallLimit. Changes apply immediately.',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['get', 'set'], description: 'get to view, set to update' },
				patch: { type: 'object', description: 'partial config when action=set' },
			},
			required: ['action'],
		},
		output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
		execute: async (args) => {
			if (args.action === 'get') return 'config=' + JSON.stringify(rt());
			if (args.action === 'set' && args.patch && typeof args.patch === 'object') {
				await ctx.settings.update('tokenStack', args.patch);
				return 'config updated=' + JSON.stringify(rt());
			}
			return 'usage: {action:"get"} or {action:"set", patch:{...}}';
		},
		isConcurrencySafe: () => false,
	};
	ctx.effect(() => ctx.tools.register(configTool), 'token-stack.config-tool');

	const statsTool = {
		name: 'token_stack_stats',
		description: 'Report what dsh-token-stack has measurably done. filter.tokensSaved is a precise estimate of tool-output tokens removed before the model saw them; memory.* is the memory layer cost and size. Terse/verbosity savings are NOT measured (they need an on/off A/B comparison).',
		parameters: { type: 'object', properties: {}, required: [] },
		output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
		execute: () => JSON.stringify(statsView(), null, 2),
		isConcurrencySafe: () => true,
	};
	ctx.effect(() => ctx.tools.register(statsTool), 'token-stack.stats-tool');

	// ---- GUI command: /token-stack [stats | on | off | set key=value ...] ----
	function statsView() {
		return {
			since: new Date(stats.since).toISOString(),
			mode: rt().control ? 'AB-CONTROL (all layers off)' : 'normal',
			config: rt(),
			filter: {
				calls: stats.filter.calls,
				tokensSaved: stats.filter.tokensSaved,
				note: 'tokensSaved = precise estimate of tool-output tokens removed before the model saw them',
				byTool: stats.filter.byTool,
			},
			memory: stats.memory,
			bySession: stats.bySession,
			terse: stats.terse,
		};
	}
	ctx.effect(() => ctx.commands.register({
		name: 'token-stack',
		description: 'token-stack: show memory/token stats or switch the A/B control condition — /token-stack [stats | on | off | set key=value ...].',
		handler: async (invocation) => {
			const parts = String(invocation.rawInput || '').trim().split(/\s+/).filter((x) => x.length > 0);
			const cmd = parts[0] || 'stats';
			if (cmd === 'stats') return { kind: 'success', text: JSON.stringify(statsView(), null, 2) };
			if (cmd === 'off') {
				await ctx.settings.update('tokenStack', { abControl: true });
				return { kind: 'success', text: 'token-stack: A/B CONTROL on — all layers disabled. Run your task, then /token-stack on to compare.\n' + JSON.stringify(rt()) };
			}
			if (cmd === 'on') {
				await ctx.settings.update('tokenStack', { abControl: false });
				return { kind: 'success', text: 'token-stack: normal mode.\n' + JSON.stringify(rt()) };
			}
			if (cmd === 'set') {
				const patch = {};
				for (const kv of parts.slice(1)) {
					const eq = kv.indexOf('=');
					if (eq < 1) continue;
					const k = kv.slice(0, eq);
					const raw = kv.slice(eq + 1);
					patch[k] = raw === 'true' ? true : raw === 'false' ? false : (!isNaN(Number(raw)) ? Number(raw) : raw);
				}
				await ctx.settings.update('tokenStack', patch);
				return { kind: 'success', text: 'token-stack: updated\n' + JSON.stringify(rt()) };
			}
			return { kind: 'success', text: 'usage: /token-stack [stats | on | off | set key=value ...]\ncurrent=' + JSON.stringify(rt()) };
		},
	}), 'token-stack.command');

	// ---- HTTP route: the client card polls live stats from here ----
	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: '/token-stack/stats',
		handler: (req, res) => {
			try {
				res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
				res.end(JSON.stringify(statsView()));
			} catch (e) {
				res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
				res.end(JSON.stringify({ error: String((e && e.message) || e) }));
			}
		},
	}), 'token-stack.stats-route');

	// ---- prompt sections (runtime-toggleable; memory injected once per session) ----
	let injectionUsedThisSession = false;
	ctx.on('agent/session-start', () => { injectionUsedThisSession = false; });

	function memorySectionText() {
		if (!rt().memory) return '';
		if (injectionUsedThisSession) return '';
		const top = recall();
		if (top.length === 0) return '';
		injectionUsedThisSession = true;
		const lines = top.map((it) => {
			const when = new Date(it.ts).toISOString().slice(0, 19);
			const tag = (it.tags && it.tags.length) ? ' #' + it.tags.join(',') : '';
			return '- [' + it.kind + '] (' + when + ')' + tag + ' ' + it.text;
		});
		const text = '## Relevant prior context (token-stack memory, injected once)\n' + lines.join('\n') + '\n(verify before relying)';
		stats.memory.sessionsInjected++;
		stats.memory.recalls += top.length;
		stats.memory.tokensInjected += estimate([{ type: 'text', text: text }]);
		return text;
	}
	ctx.effect(() => ctx.systemPrompt.section({ name: 'token-stack.memory', order: 60, text: () => memorySectionText() }), 'token-stack.memory-section');
	ctx.effect(() => ctx.systemPrompt.section({
		name: 'token-stack.terse', order: 70,
		text: () => rt().terse
			? '## Style: token efficiency\nWhen a task is exploratory, scaffolding, or a straightforward edit, reply tersely (short labels, bullet points, no filler prose). Exception: when the user explicitly asks for detail, when debugging a subtle bug, or when reviewing code, be thorough and precise — correctness beats token savings.'
			: '',
	}), 'token-stack.terse-section');

	// ---- input filter: truncate noisy tool output ----
	function trimContent(blocks, maxChars) {
		if (!Array.isArray(blocks)) return undefined;
		let changed = false;
		const out = blocks.map((b) => {
			if (b && b.type === 'text' && typeof b.text === 'string' && b.text.length > maxChars) {
				changed = true;
				return { type: 'text', text: b.text.slice(0, maxChars) + '\n\n[...token-stack: truncated ' + (b.text.length - maxChars) + ' chars; read the file for full output]' };
			}
			return b;
		});
		return changed ? out : undefined;
	}
	ctx.on('tools/post-execute', async (exec, result, next) => {
		if (!rt().filter) return next();
		const decision = await next();
		if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision;
		const original = decision.content ?? result.content;
		const trimmed = trimContent(original, config.textMaxChars);
		if (trimmed === undefined) return decision;
		const saved = Math.max(0, estimate(original) - estimate(trimmed));
		stats.filter.calls++;
		stats.filter.tokensSaved += saved;
		bumpTool(stats.filter.byTool, exec && exec.name, 'calls', 1);
		bumpTool(stats.filter.byTool, exec && exec.name, 'tokensSaved', saved);
		const ss = sessionStat(sessionKey(exec));
		ss.filterCalls++;
		ss.tokensSaved += saved;
		return { kind: 'accept', content: trimmed, ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}) };
	}, { prepend: true });

	// best-effort state sync; start async
	loadAll();
	console.log('[token-stack] package active', JSON.stringify(config));
}

export { Config, SettingsSchema, apply, inject, name };
