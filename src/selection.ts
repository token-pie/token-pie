import * as fs from 'fs';
import * as path from 'path';

/**
 * Recovers whether a request's model was chosen by you or by Auto.
 *
 * `agent-traces.db` records only the model that served the request --
 * `request_model` is already resolved, and no attribute survives to say the
 * picker was set to Auto. Without this, Token Pie reports "claude-sonnet-5
 * took 66% of your spend" and advises switching away from it, when the user
 * may never have chosen it at all.
 *
 * VS Code's own session files do keep it, per request:
 *
 *   requests[i].modelId              -> "copilot/auto" | "copilot/claude-sonnet-5"
 *   requests[i].result.resolvedModel -> "claude-sonnet-5"
 *
 * The trace database carries `chat_session_id` but leaves `turn_index` NULL in
 * copilot-chat 0.62.0, so a per-turn join is not available. Attribution is
 * therefore at (session, resolved model), which is exact whenever a model was
 * reached only one way inside a thread and reports `mixed` when it was not.
 */

export type Selection = 'auto' | 'manual' | 'mixed' | 'unknown';

const AUTO_MODEL_ID = /(^|\/)auto$/i;

/**
 * Whether an id names the picker rather than a model.
 *
 * Exported so the models table classifies Auto the same way attribution does.
 * The table had it as a model the rate card had not caught up with, which is
 * a claim about the card; Auto has no price because it is not a thing that is
 * priced.
 */
export function isAutoModelId(id: string): boolean {
	return AUTO_MODEL_ID.test(id);
}

interface SlimRequest {
	modelId?: string;
	resolvedModel?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

interface Cached {
	/** Session id -> file path. A directory listing, not a parse. */
	files: Map<string, string>;
	built: number;
}

const caches = new Map<string, Cached>();
/** Parsed results, keyed `<sessionId>\0<resolvedModel>`. */
const parsed = new Map<string, Map<string, Selection>>();

/**
 * Session files are parsed on demand, not up front.
 *
 * A machine accumulates hundreds of them and only a handful appear in the
 * spans being ingested; parsing the rest would be work with no consumer.
 */
export class SelectionIndex {
	constructor(private readonly userDir: string) {}

	lookup(sessionId: string | undefined, model: string): Selection {
		if (!sessionId) {
			return 'unknown';
		}
		let byModel = parsed.get(sessionId);
		if (!byModel) {
			byModel = this.parseSession(sessionId);
			parsed.set(sessionId, byModel);
		}
		return byModel.get(model) ?? 'unknown';
	}

	private parseSession(sessionId: string): Map<string, Selection> {
		const out = new Map<string, Selection>();
		const file = sessionFiles(this.userDir).get(sessionId);
		if (!file) {
			return out;
		}

		let requests: SlimRequest[];
		try {
			requests = readRequests(file);
		} catch {
			return out;
		}

		for (const r of requests) {
			if (!r.resolvedModel || !r.modelId) {
				continue;
			}
			const mode: Selection = AUTO_MODEL_ID.test(r.modelId) ? 'auto' : 'manual';
			const seen = out.get(r.resolvedModel);
			out.set(r.resolvedModel, seen === undefined || seen === mode ? mode : 'mixed');
		}
		return out;
	}
}

/** Drop cached listings and parses; the refresh command calls this. */
export function clearSelectionCache(): void {
	caches.clear();
	parsed.clear();
}

function sessionFiles(userDir: string): Map<string, string> {
	const cached = caches.get(userDir);
	if (cached && Date.now() - cached.built < CACHE_TTL_MS) {
		return cached.files;
	}
	const files = new Map<string, string>();

	const roots: string[] = [];
	for (const hash of readdir(path.join(userDir, 'workspaceStorage'))) {
		roots.push(path.join(userDir, 'workspaceStorage', hash, 'chatSessions'));
	}
	roots.push(path.join(userDir, 'globalStorage', 'emptyWindowChatSessions'));

	for (const dir of roots) {
		for (const name of readdir(dir)) {
			if (!/\.jsonl?$/.test(name)) {
				continue;
			}
			files.set(name.replace(/\.jsonl?$/, ''), path.join(dir, name));
		}
	}

	caches.set(userDir, { files, built: Date.now() });
	return files;
}

function readdir(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

/**
 * Replays only the two fields we need out of the append-log.
 *
 * Record 0 is a full snapshot; every later record patches one path, with
 * `kind: 2` appending to an array and anything else setting in place. Keeping
 * a slim projection rather than the whole request object matters -- these
 * files hold entire conversations and we want two strings per turn.
 */
export function readRequests(file: string): SlimRequest[] {
	const text = fs.readFileSync(file, 'utf8');
	const requests: SlimRequest[] = [];

	const slim = (v: unknown): SlimRequest => {
		const o = v as
			{ modelId?: unknown; result?: { metadata?: { resolvedModel?: unknown } } } | null;
		const resolved = o?.result?.metadata?.resolvedModel;
		return {
			modelId: typeof o?.modelId === 'string' ? o.modelId : undefined,
			resolvedModel: typeof resolved === 'string' ? resolved : undefined
		};
	};

	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) {
			continue;
		}
		let record: { kind?: number; k?: unknown[]; v?: unknown; requests?: unknown[] };
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}

		// A plain `.json` session, or the snapshot heading a `.jsonl` -- which
		// is itself a record, `{ kind, v }`, with the session object in `v`.
		const snapshot = Array.isArray(record.requests)
			? record.requests
			: (record.v as { requests?: unknown[] } | null)?.requests;
		if (!record.k && Array.isArray(snapshot)) {
			for (const r of snapshot) {
				requests.push(slim(r));
			}
			continue;
		}

		const k = record.k;
		if (!Array.isArray(k) || k[0] !== 'requests') {
			continue;
		}
		if (k.length === 1) {
			// An append carries an array of requests, not a single one.
			if (record.kind === 2) {
				for (const r of Array.isArray(record.v) ? record.v : [record.v]) {
					requests.push(slim(r));
				}
			}
			continue;
		}

		const index = k[1];
		if (typeof index !== 'number') {
			continue;
		}
		while (requests.length <= index) {
			requests.push({});
		}

		if (k.length === 2) {
			requests[index] = slim(record.v);
		} else if (k[2] === 'modelId' && typeof record.v === 'string') {
			requests[index].modelId = record.v;
		} else if (k[2] === 'result') {
			// `['requests', N, 'result']`, `[..., 'result', 'metadata']`, or the
			// leaf itself -- the field is nested one level deeper than the
			// result object, under `metadata`.
			let resolved: unknown;
			if (k.length === 3) {
				resolved = (record.v as { metadata?: { resolvedModel?: unknown } } | null)
					?.metadata?.resolvedModel;
			} else if (k[3] === 'metadata') {
				resolved = k.length === 4
					? (record.v as { resolvedModel?: unknown } | null)?.resolvedModel
					: k[4] === 'resolvedModel' ? record.v : undefined;
			}
			if (typeof resolved === 'string') {
				requests[index].resolvedModel = resolved;
			}
		}
	}
	return requests;
}
