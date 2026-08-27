import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const COPILOT_EXT_ID = 'github.copilot-chat';
const DB_NAME = 'agent-traces.db';

/** A discovered trace database, tagged with where it came from. */
export interface TraceDb {
	/** Absolute path to agent-traces.db */
	path: string;
	/** "Code", "Code - Insiders", "Cursor", ... */
	channel: string;
	/** "default" or the profile directory id */
	profile: string;
	/** The `User` directory this database belongs to, for workspaceStorage lookups. */
	userDir: string;
	sizeBytes: number;
	mtime: number;
}

/**
 * Roots that hold a VS Code (or fork) `User` directory. We scan every install
 * channel we can find rather than assuming Stable, because a dev running
 * Insiders alongside Stable produces two entirely separate trace databases.
 */
function userRoots(): { root: string; channel: string }[] {
	const home = os.homedir();
	let base: string;
	switch (process.platform) {
		case 'darwin':
			base = path.join(home, 'Library', 'Application Support');
			break;
		case 'win32':
			base = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
			break;
		default:
			base = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(base, { withFileTypes: true });
	} catch {
		return [];
	}

	const roots: { root: string; channel: string }[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const userDir = path.join(base, entry.name, 'User');
		if (fs.existsSync(path.join(userDir, 'globalStorage'))) {
			roots.push({ root: userDir, channel: entry.name });
		}
	}
	return roots;
}

/**
 * globalStorage is per *profile*, not per machine: the default profile lives at
 * `User/globalStorage`, and every additional profile gets its own copy under
 * `User/profiles/<id>/globalStorage`. Miss the profiles and you silently report
 * a fraction of a developer's real spend.
 */
function profileStorageDirs(userDir: string): { dir: string; profile: string }[] {
	const dirs = [{ dir: path.join(userDir, 'globalStorage'), profile: 'default' }];

	const profilesDir = path.join(userDir, 'profiles');
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(profilesDir, { withFileTypes: true });
	} catch {
		return dirs;
	}

	for (const entry of entries) {
		if (entry.isDirectory()) {
			dirs.push({
				dir: path.join(profilesDir, entry.name, 'globalStorage'),
				profile: entry.name
			});
		}
	}
	return dirs;
}

/** Every agent-traces.db on this machine, across install channels and profiles. */
export function findTraceDbs(): TraceDb[] {
	const found: TraceDb[] = [];

	for (const { root, channel } of userRoots()) {
		for (const { dir, profile } of profileStorageDirs(root)) {
			const dbPath = path.join(dir, COPILOT_EXT_ID, DB_NAME);
			try {
				const stat = fs.statSync(dbPath);
				found.push({
					path: dbPath,
					channel,
					profile,
					// workspaceStorage always lives directly under `User`, even for
					// additional profiles, so keep the channel root rather than the
					// profile's globalStorage directory.
					userDir: root,
					sizeBytes: stat.size,
					mtime: stat.mtimeMs
				});
			} catch {
				// No database here: OTel has never been enabled for this profile.
			}
		}
	}

	return found;
}

/**
 * The tmpdir fallback the exporter uses when globalStorageUri is unavailable.
 * Rare, but cheap to check and confusing to debug if we don't.
 */
export function fallbackDbPath(): string {
	return path.join(os.tmpdir(), 'copilot-agent-traces.db');
}
