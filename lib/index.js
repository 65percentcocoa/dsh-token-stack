import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

/** Portable default memory location under the DSH home (`$DSH_HOME` or `~/.dsh`). */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const DEFAULT_MEMORY_FILE = path.join(DSH_HOME, 'dsh-memory', 'memory.json');

/** Cordis plugin name (must be unique; it becomes the row id component). */
const name = 'token-stack';

/** Hard dependencies. `settings` and `tools` are host services; `fs`, `systemPrompt` are the seams this plugin consumes. */
const inject = ['systemPrompt', 'fs', 'settings', 'tools'];

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
			},
		},
	});

	const rt = () => {
		const s = ctx.settings.get('tokenStack') || {};
		return {
			terse: s.terse ?? config.terse,
			memory: s.memory ?? config.memory,
			filter: s.filter ?? config.filter,
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
	}
	function persistMemory() { if (memTarget) writeJson(memTarget, memoryCache); }

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
		if (isDuplicate(tool, compact)) return;
		memoryCache.unshift({ ts: Date.now(), kind: 'tool', tool, text: compact });
		if (memoryCache.length > config.memoryMaxItems) memoryCache.length = config.memoryMaxItems;
		persistMemory();
	}

	ctx.on('tools/result', (exec, result) => recordMemory(exec, result));
	ctx.on('agent/turn-stopping', () => { if (rt().memory) return persistMemory(); });

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
		return '## Relevant prior context (token-stack memory, injected once)\n' + lines.join('\n') + '\n(verify before relying)';
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
		const trimmed = trimContent(decision.content ?? result.content, config.textMaxChars);
		if (trimmed === undefined) return decision;
		return { kind: 'accept', content: trimmed, ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}) };
	}, { prepend: true });

	// best-effort state sync; start async
	loadAll();
	console.log('[token-stack] package active', JSON.stringify(config));
}

export { Config, SettingsSchema, apply, inject, name };
