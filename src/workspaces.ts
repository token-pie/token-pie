import * as fs from 'fs';
import * as path from 'path';

/**
 * Maps a chat session id to the workspace it happened in.
 *
 * No span attribute records the workspace -- the trace database knows only
 * `chat_session_id`. But VS Code stores chat sessions under the per-workspace
 * storage directory, and each of those directories carries a `workspace.json`
 * naming the folder. Walking that gives us per-repo attribution that the spans
 * alone cannot provide:
 *
 *   workspaceStorage/<hash>/chatSessions/<session-id>.jsonl
 *   workspaceStorage/<hash>/workspace.json  ->  { "folder": "file:///path/to/repo" }
 *
 * Sessions whose workspace has since been removed simply resolve to "unknown",
 * which is the honest answer rather than a guess.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;

interface Cached {
	map: Map<string, string>;
	built: number;
}

const caches = new Map<string, Cached>();

export function sessionToWorkspace(userDir: string): Map<string, string> {
	const cached = caches.get(userDir);
	if (cached && Date.now() - cached.built < CACHE_TTL_MS) {
		return cached.map;
	}

	const map = build(userDir);
	caches.set(userDir, { map, built: Date.now() });
	return map;
}

function build(userDir: string): Map<string, string> {
	const map = new Map<string, string>();
	const root = path.join(userDir, 'workspaceStorage');

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return map;
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const dir = path.join(root, entry.name);
		const label = workspaceLabel(dir);
		if (!label) {
			continue;
		}
		for (const sessionId of sessionIds(dir)) {
			map.set(sessionId, label);
		}
	}
	return map;
}

function workspaceLabel(dir: string): string | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8');
	} catch {
		return undefined;
	}

	let parsed: { folder?: string; workspace?: string };
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}

	// `folder` for a single-root window, `workspace` for a .code-workspace file.
	const uri = parsed.folder ?? parsed.workspace;
	if (!uri) {
		return undefined;
	}

	try {
		const decoded = decodeURIComponent(uri.replace(/^file:\/\//, ''));
		const base = path.basename(decoded);
		return base.replace(/\.code-workspace$/, '') || undefined;
	} catch {
		return undefined;
	}
}

/** Session ids are the chat session filenames, with or without an extension. */
function sessionIds(dir: string): string[] {
	const ids: string[] = [];
	for (const sub of ['chatSessions', 'chatEditingSessions']) {
		let names: string[];
		try {
			names = fs.readdirSync(path.join(dir, sub));
		} catch {
			continue;
		}
		for (const name of names) {
			ids.push(name.replace(/\.(jsonl|json)$/, ''));
		}
	}
	return ids;
}

/** Drop cached maps; used by the refresh command so a new repo shows up at once. */
export function clearWorkspaceCache(): void {
	caches.clear();
}
