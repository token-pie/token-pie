import * as fs from 'fs';
import * as path from 'path';

/**
 * Reads Copilot chat turns from VS Code's own session files.
 *
 * NOT the source of truth for spend -- see docs/DECISIONS.md#source. VS Code
 * writes `promptTokens`, `completionTokens` and `copilotCredits` here with no
 * configuration required, which made this look like the better source. It
 * records only *completed* user turns: retried, cancelled and superseded
 * requests are billed and never written, undercounting agent work by ~55%.
 *
 * This module survives for reconciliation against `agent-traces.db`, and for
 * `selection.ts` to recover whether Auto picked the model. Do not compute
 * spend from it.
 *
 * Two on-disk shapes:
 *   .json   a single session object
 *   .jsonl  an append-log: record 0 is a full snapshot, every later record is
 *           `{ kind, k: [path...], v }` patching one path. Rather than replay
 *           the patches, we scan every record for turn objects and keep the
 *           last version of each -- a turn can be rewritten as it streams.
 *
 * Only objects carrying a `requestId` count as turns. The nested
 * `result.metadata` object repeats `promptTokens` without one; counting it
 * would double every turn's tokens.
 */

export interface Turn {
	requestId: string;
	sessionId: string;
	workspace: string;
	timestamp: number;
	/** What was actually served -- `resolvedModel`, not the "copilot/auto" alias. */
	model: string;
	promptTokens: number;
	completionTokens: number;
	/** Billed credits. Undefined when VS Code did not record one. */
	credits?: number;
}

export function userDirs(base?: string): string[] {
	const home = process.env.HOME ?? '';
	const root =
		base ??
		(process.platform === 'darwin'
			? path.join(home, 'Library', 'Application Support')
			: process.platform === 'win32'
				? process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
				: process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'));

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter(e => e.isDirectory())
		.map(e => path.join(root, e.name, 'User'))
		.filter(d => fs.existsSync(path.join(d, 'workspaceStorage')));
}

interface SessionFile {
	file: string;
	sessionId: string;
	workspace: string;
}

/** Every chat session file on this machine, workspace-scoped and windowless. */
export function findSessionFiles(userDir: string): SessionFile[] {
	const out: SessionFile[] = [];

	const wsRoot = path.join(userDir, 'workspaceStorage');
	for (const hash of readdir(wsRoot)) {
		const label = workspaceLabel(path.join(wsRoot, hash)) ?? hash.slice(0, 8);
		for (const entry of readdir(path.join(wsRoot, hash, 'chatSessions'))) {
			if (!entry.endsWith('.json') && !entry.endsWith('.jsonl')) {
				continue;
			}
			out.push({
				file: path.join(wsRoot, hash, 'chatSessions', entry),
				sessionId: entry.replace(/\.jsonl?$/, ''),
				workspace: label
			});
		}
	}

	// Chats started in a window with no folder open.
	const empty = path.join(userDir, 'globalStorage', 'emptyWindowChatSessions');
	for (const entry of readdir(empty)) {
		if (!entry.endsWith('.json') && !entry.endsWith('.jsonl')) {
			continue;
		}
		out.push({
			file: path.join(empty, entry),
			sessionId: entry.replace(/\.jsonl?$/, ''),
			workspace: '(no folder)'
		});
	}

	return out;
}

function readdir(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

function workspaceLabel(dir: string): string | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
		const uri: string | undefined = parsed.folder ?? parsed.workspace;
		if (!uri) {
			return undefined;
		}
		const decoded = decodeURIComponent(uri.replace(/^file:\/\//, ''));
		return path.basename(decoded).replace(/\.code-workspace$/, '') || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Parsed turns, keyed by file path and invalidated by size and mtime.
 *
 * Without this every ingest re-read and re-parsed every transcript on the
 * machine -- on a heavy user that is minutes of blocking work, repeated every
 * two minutes.
 */
const fileCache = new Map<string, { mtimeMs: number; size: number; turns: Turn[] }>();

export function clearTurnCache(): void {
	fileCache.clear();
}

/**
 * One transcript, parsed at most once per change.
 *
 * Exposed per file so a caller can hand control back to the event loop between
 * them: parsing every transcript in one synchronous pass froze the extension
 * host for minutes on a heavy machine.
 */
export function readSessionFileCached(sf: SessionFile, notBefore = 0): Turn[] | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(sf.file);
	} catch {
		return undefined;
	}
	// A transcript untouched since before the window cannot hold a turn inside
	// it. Skipping on mtime alone avoids opening a year of files.
	if (notBefore > 0 && stat.mtimeMs < notBefore) {
		return undefined;
	}

	const cached = fileCache.get(sf.file);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.turns;
	}
	const turns = readFile(sf);
	fileCache.set(sf.file, { mtimeMs: stat.mtimeMs, size: stat.size, turns });
	return turns;
}

export function readTurns(userDir: string, notBefore = 0): Turn[] {
	const turns = new Map<string, Turn>();
	for (const sf of findSessionFiles(userDir)) {
		const parsed = readSessionFileCached(sf, notBefore);
		if (!parsed) {
			continue;
		}
		for (const turn of parsed) {
			// Last write wins: a streaming turn is rewritten as it completes.
			turns.set(turn.requestId, turn);
		}
	}
	return [...turns.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function readFile(sf: SessionFile): Turn[] {
	let text: string;
	try {
		text = fs.readFileSync(sf.file, 'utf8');
	} catch {
		return [];
	}

	const records: unknown[] = [];
	if (sf.file.endsWith('.jsonl')) {
		for (const line of text.split('\n')) {
			if (!line.trim()) {
				continue;
			}
			try {
				records.push(JSON.parse(line));
			} catch {
				// A torn final line is normal while VS Code is writing.
			}
		}
	} else {
		try {
			records.push(JSON.parse(text));
		} catch {
			return [];
		}
	}

	const found: Turn[] = [];
	for (const record of records) {
		collect(record, sf, found);
	}
	return found;
}

function collect(node: unknown, sf: SessionFile, out: Turn[]): void {
	if (Array.isArray(node)) {
		for (const child of node) {
			collect(child, sf, out);
		}
		return;
	}
	if (!node || typeof node !== 'object') {
		return;
	}

	const o = node as Record<string, unknown>;
	const requestId = typeof o['requestId'] === 'string' ? o['requestId'] : undefined;
	if (requestId && (o['promptTokens'] !== undefined || o['copilotCredits'] !== undefined)) {
		const metadata = (o['result'] as Record<string, unknown> | undefined)?.['metadata'] as
			Record<string, unknown> | undefined;
		out.push({
			requestId,
			sessionId: sf.sessionId,
			workspace: sf.workspace,
			timestamp: num(o['timestamp']) || num(o['responseTimestamp']),
			// `modelId` is often the "copilot/auto" alias; resolvedModel is real.
			model: str(metadata?.['resolvedModel']) ?? str(o['modelId']) ?? 'unknown',
			promptTokens: num(o['promptTokens']),
			completionTokens: num(o['completionTokens']),
			credits: typeof o['copilotCredits'] === 'number' ? o['copilotCredits'] : undefined
		});
	}

	for (const value of Object.values(o)) {
		collect(value, sf, out);
	}
}

function num(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}
