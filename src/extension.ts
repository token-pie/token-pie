import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findTraceDbs, fallbackDbPath } from './locate';
import { ingestAll, IngestResult, dayKey } from './ingest';
import { clearWorkspaceCache } from './workspaces';
import { clearSelectionCache } from './selection';
import { purgeAll, PurgeResult } from './purge';
import { fetchEntitlement, governingSnapshot, hasCopilotAccess, QuotaError } from './quota';
import { ReadingStore, toReading, reconcile, periodCoverage } from './reconcile';
import { userDirs, readTurns, clearTurnCache, Turn } from './sessions';
import { project, statusLabel, barLabel, dayPressure, Projection } from './projection';
import { Progress, phaseLabel } from './progress';
import { renderCompact } from './sidebar';
import { Entitlement } from './entitlement';
import { RollupStore } from './store';
import { KNOWN_SCHEMA_VERSION, num } from './schema';
import { renderReport, creditsByDay, fmtDaysWith } from './report';
import { Tuning, KnobReading, read } from './tuning';
import { renderSpecs } from './specs';
import { LoadedCard, load as loadCard, refresh as refreshCard, isDue } from './ratecard';

const DB_EXPORTER_SETTING = 'github.copilot.chat.otel.dbSpanExporter.enabled';
const OTEL_ENABLED_SETTING = 'github.copilot.chat.otel.enabled';
const CAPTURE_CONTENT_SETTING = 'github.copilot.chat.otel.captureContent';
const MAX_ATTR_SETTING = 'github.copilot.chat.otel.maxAttributeSizeChars';

let store: RollupStore;
let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let panel: vscode.WebviewPanel | undefined;
let consolePanel: vscode.WebviewPanel | undefined;
let timer: NodeJS.Timeout | undefined;
let lastRefresh: Date | undefined;
let lastResult: IngestResult | undefined;
let extensionContext: vscode.ExtensionContext;
let entitlement: Entitlement | undefined;
let projection: Projection | undefined;
let progress: Progress = { phase: 'idle' };
/**
 * Errors the last refresh survived.
 *
 * Per-database failures are collected rather than thrown, so a machine where
 * every read fails would otherwise show a contented pie chart beside no data.
 * Anything in here earns the warning mark, even when a figure is available.
 */
let lastErrors: string[] = [];
/**
 * Findings, redacted the way errors already were.
 *
 * These are rendered in the panel and the sidebar and they quote the database
 * path, so on Windows the untouched text carried `C:\\Users\\<username>` into a
 * warning people screenshot. `lastErrors` had been redacted since it existed;
 * notices arrived later and did not inherit it.
 */
let lastNotices: string[] = [];
/**
 * The refresh in flight, if any.
 *
 * The pipeline yields to the event loop, so without this the 120-second timer
 * can start a second pass through the same store while the first is mid-way
 * through it. Two passes then raced each other's writes.
 */
let inFlight: Promise<void> | undefined;

export function activate(context: vscode.ExtensionContext): void {
	extensionContext = context;
	output = vscode.window.createOutputChannel('Token Pie');
	store = new RollupStore(path.join(context.globalStorageUri.fsPath, 'rollup.json'));

	statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = 'tokenPie.showReport';
	context.subscriptions.push(statusBar, output);

	sidebar = new Sidebar();
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(Sidebar.viewId, sidebar,
			// Kept alive while hidden: rebuilding it on every reveal would
			// re-render from the same cached state anyway, and losing the scroll
			// position of the week is a worse trade than a few kilobytes.
			{ webviewOptions: { retainContextWhenHidden: true } })
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tokenPie.setup', () => setup()),
		vscode.commands.registerCommand('tokenPie.showReport', () => showReport(context)),
		vscode.commands.registerCommand('tokenPie.refresh', () => {
			// A repo opened since the last scan won't be in the session map yet.
			clearWorkspaceCache();
			clearSelectionCache();
			clearTurnCache();
			return refresh(true);
		}),
		vscode.commands.registerCommand('tokenPie.doctor', () => doctor()),
		vscode.commands.registerCommand('tokenPie.tokenSpecs', () => showSpecs(context)),
		vscode.commands.registerCommand('tokenPie.refreshRateCard', () => refreshRateCard(true)),
		vscode.commands.registerCommand('tokenPie.purgeContent', () => purgeContent()),
		vscode.commands.registerCommand('tokenPie.checkQuota', () => checkQuota()),
		vscode.commands.registerCommand('tokenPie.showLogs', () => output.show(true))
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration('tokenPie')) {
				return;
			}
			scheduleRefresh();
			// Every surface reads the gate ladder live. Someone raising a floor
			// to see what it was withholding should see the answer immediately,
			// which is the only way the console is worth opening twice.
			repaint();
		})
	);

	// Show something before any I/O. The first render used to be chained behind
	// a call to api.github.com, so on a slow or proxied network the item simply
	// never appeared and the extension looked dead.
	setProgress({ phase: 'starting' });

	void firstRun();
	scheduleRefresh();

	// Local work first: it needs no network and produces a usable panel. The
	// entitlement only adds the denominator, so it arrives when it arrives.
	// Deferred so activation returns immediately: VS Code renders the item
	// before any of this begins, and each phase repaints it as it goes.
	setTimeout(() => void refresh(false), 0);

	// Published prices, at most weekly and never blocking. The bundled snapshot
	// is what the comparison runs on until this lands, so nothing waits on it.
	// The refresh cycle checks again as it runs -- this only covers the first
	// few minutes after activation, before that cycle has come round.
	setTimeout(() => void refreshRateCard(), 5000);
}

export function deactivate(): void {
	if (timer) {
		clearInterval(timer);
	}
	store?.save();
}

/**
 * Replace the home directory with `~` in anything written to the log.
 *
 * The broken state invites the user to open the log and share it, and a raw
 * filesystem error carries the account name in every path it mentions.
 */
function redactPaths(text: string): string {
	const home = os.homedir();
	return home && home !== '/' ? text.split(home).join('~') : text;
}

/**
 * Strip account identifiers from the diagnostic dump.
 *
 * The dump exists so an unfamiliar plan shape can be reported, and none of
 * that needs the account it came from. `analytics_tracking_id` in particular
 * is a stable per-user identifier.
 */
const IDENTIFIER_KEYS = ['login', 'analytics_tracking_id', 'organization_login_list',
	'organization_list', 'assigned_date'];

function withoutIdentifiers(raw: unknown): unknown {
	if (!raw || typeof raw !== 'object') {
		return raw;
	}
	const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
	for (const key of IDENTIFIER_KEYS) {
		if (key in out) {
			out[key] = '(removed)';
		}
	}
	return out;
}

function config() {
	return vscode.workspace.getConfiguration('tokenPie');
}

/**
 * The gate ladder, read fresh each time.
 *
 * Not cached: a developer who raises a floor in settings to see what it was
 * withholding should see the answer on the next refresh, not after a reload.
 */
function tuning(): { tuning: Tuning; readings: KnobReading[] } {
	return read(id => config().get(id));
}

function creditsPerNanoAiu(): number {
	return config().get<number>('creditsPerNanoAiu', 1e-9);
}

/** Nudge once if collection was never switched on; there is nothing to show until it is. */
async function firstRun(): Promise<void> {
	if (findTraceDbs().length > 0) {
		return;
	}
	const enabled = vscode.workspace
		.getConfiguration()
		.get<boolean>(DB_EXPORTER_SETTING, false);
	if (enabled) {
		return;
	}

	const choice = await vscode.window.showInformationMessage(
		'Token Pie needs local trace collection enabled to see any usage.',
		'Enable',
		'Not now'
	);
	if (choice === 'Enable') {
		await setup();
	}
}

/**
 * Writes the one setting that matters, and guards the trap around it.
 *
 * Copilot resolves a DB-only mode as `dbSpanExporter && !enabledExplicitly &&
 * !fileExporterPath && exporterType !== "console"`. Setting `otel.enabled` as
 * well flips `enabledExplicitly`, which builds a real OTLP HTTP exporter aimed
 * at localhost:4318. The database still gets written -- the SQLite processor is
 * attached independently of that flag -- but every span is also retried against
 * a port nobody is listening on. Local-only means this setting and no other.
 */
async function setup(): Promise<void> {
	const root = vscode.workspace.getConfiguration();

	// Global scope only: the exporter setting is documented as user-settings-only,
	// and the database it produces is machine-wide regardless of workspace.
	await root.update(DB_EXPORTER_SETTING, true, vscode.ConfigurationTarget.Global);

	// Cap stored content.
	//
	// `captureContent` is the documented control, but in copilot-chat 0.62.0 the
	// first-party chat path writes copilot_chat.user_request,
	// gen_ai.input.messages and gen_ai.system_instructions with no captureContent
	// check -- only the BYOK provider paths honour it. maxAttributeSizeChars is
	// applied to every string attribute regardless, so it is the control that
	// actually works today.
	//
	// The default of 0 means UNLIMITED, not "none": `truncate(s, 0)` returns `s`
	// untouched. 1 truncates every string attribute to a single character.
	// Numeric attributes -- token counts and copilot_usage_nano_aiu -- are never
	// passed through the truncator, so everything Token Pie reads survives.
	if (num(root.get(MAX_ATTR_SETTING)) !== 1) {
		await root.update(MAX_ATTR_SETTING, 1, vscode.ConfigurationTarget.Global);
	}

	const conflicts: string[] = [];
	const otelEnabled = root.inspect<boolean>(OTEL_ENABLED_SETTING);
	if (otelEnabled?.globalValue === true || otelEnabled?.workspaceValue === true) {
		conflicts.push(
			`"${OTEL_ENABLED_SETTING}" is true, so Copilot also exports every span over the network to localhost:4318. Set it to false or remove it.`
		);
	}
	if (root.get<boolean>(CAPTURE_CONTENT_SETTING, false)) {
		conflicts.push(
			`"${CAPTURE_CONTENT_SETTING}" is true, so full prompts and responses are being written to disk. Token Pie does not need it.`
		);
	}

	if (conflicts.length > 0) {
		void vscode.window.showWarningMessage(
			`Token Pie: ${conflicts.join(' ')}`,
			'Open Settings'
		).then(pick => {
			if (pick === 'Open Settings') {
				void vscode.commands.executeCommand(
					'workbench.action.openSettings',
					'github.copilot.chat.otel'
				);
			}
		});
		return;
	}

	const choice = await vscode.window.showInformationMessage(
		'Local trace collection enabled. Reload the window to start collecting, then use Copilot Chat normally.',
		'Reload Window'
	);
	if (choice === 'Reload Window') {
		await vscode.commands.executeCommand('workbench.action.reloadWindow');
	}
}

function scheduleRefresh(): void {
	if (timer) {
		clearInterval(timer);
	}
	const seconds = Math.max(30, config().get<number>('refreshIntervalSeconds', 120));
	timer = setInterval(() => void refresh(false), seconds * 1000);
}

async function refresh(interactive: boolean): Promise<void> {
	// Join the run already under way rather than starting a second one.
	if (inFlight) {
		return inFlight;
	}
	inFlight = runRefresh(interactive);
	try {
		await inFlight;
	} finally {
		inFlight = undefined;
	}

	// Published prices, checked on the same cycle as everything else.
	//
	// This used to run once, five seconds after activation, so an editor left
	// open for a month never picked up a price change -- the one span of time
	// over which prices are most likely to have moved. `isDue` is a stat call
	// and the fetch itself still fires at most weekly, so riding this cycle
	// costs nothing.
	void refreshRateCard();
}

async function runRefresh(interactive: boolean): Promise<void> {
	try {
		// Local first. The allowance needs the network and only supplies a
		// denominator, so waiting for it here would hold up everything the
		// machine can already answer on its own.
		const t = tuning().tuning;
		// Backfill converts transcript credits back to nano-AIU, so it needs the
		// same conversion the panel reads or the two sources land on different
		// scales the moment anyone recalibrates it.
		const result = await ingestAll(store, undefined, setProgress, undefined, {
			creditsPerNanoAiu: creditsPerNanoAiu(),
			historyDays: t.history.days
		});
		lastResult = result;
		lastRefresh = new Date();

		// Purge after ingest, never before: our rollup is the durable record, and
		// the trace database is only a spool. Ordering also means a purge that
		// loses its lock race simply retries next cycle with nothing lost.
		setProgress({ phase: 'tidying' });
		autoPurge();

		setProgress({ phase: 'checking-quota' });
		await refreshEntitlement();

		lastErrors = result.errors.map(redactPaths);
		lastNotices = result.notices.map(redactPaths);
		setProgress({ phase: 'ready' });
		recomputeProjection();
		updateStatusBar();
		repaint();

		if (interactive) {
			void vscode.window.showInformationMessage(
				`Token Pie: read ${result.dbCount} database(s), counted ${result.spansCounted} LLM span(s).`
			);
		}
		if (result.errors.length > 0) {
			output.appendLine(
				`[${new Date().toISOString()}] ${redactPaths(result.errors.join(' | '))}`
			);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const safe = redactPaths(message);
		lastErrors = [safe];
		setProgress({ phase: 'failed' });
		updateStatusBar();
		// The views carry the warnings, and a failure is when there is one worth
		// carrying. Without this the status bar turned broken while the panel and
		// the sidebar went on showing the last good render, saying nothing --
		// which is the worst of the three states to be in, because the surface
		// with the detail is the one that stays silent.
		repaint();
		output.appendLine(`[${new Date().toISOString()}] refresh failed: ${safe}`);
		if (interactive) {
			void vscode.window.showErrorMessage(`Token Pie: ${safe}`);
		}
	}
}

/**
 * Announce a phase on the status bar.
 *
 * The point of this is that a slow start looks like progress rather than a
 * hang. It is called from inside the pipeline between units of work, which is
 * why it touches only the status bar: re-rendering two webviews between every
 * unit would cost more than the progress is worth. The views are repainted
 * once, when the pass ends.
 *
 * It used to say it repainted. It never did.
 */
function setProgress(p: Progress): void {
	progress = p;
	updateStatusBar();
}

/**
 * Delete the content that configuration cannot suppress, on every cycle.
 *
 * Cheap by construction: a no-op probe takes no write lock and costs ~0.4 ms,
 * and because this runs continuously the database stays small enough that
 * VACUUM never has much to rewrite. The busy timeout is short by default -- if
 * Copilot holds the lock we skip and try again rather than stalling the editor.
 */
function autoPurge(): void {
	if (!config().get<boolean>('autoPurge.enabled', true)) {
		return;
	}

	let results: PurgeResult[];
	try {
		results = purgeAll({
			// No longer offered as a setting: a millisecond lock timeout is not a
			// preference anyone can hold. Still read, so an existing override
			// keeps working. The purge is idempotent, so a skipped cycle is
			// harmless and there is nothing here worth tuning.
			busyTimeoutMs: config().get<number>('autoPurge.busyTimeoutMs', 250),
			vacuum: 'auto'
		});
	} catch (err) {
		output.appendLine(`[purge] failed: ${redactPaths(err instanceof Error ? err.message : String(err))}`);
		return;
	}

	for (const r of results) {
		if (r.error) {
			output.appendLine(`[purge] ${redactPaths(r.db)}: ${redactPaths(r.error)}`);
		} else if (r.attributeRows > 0 || r.eventRows > 0) {
			output.appendLine(
				`[purge] ${r.attributeRows} attrs, ${r.eventRows} events, ` +
				`${(r.bytesFreed / 1024).toFixed(1)} KB${r.vacuumed ? ', vacuumed' : ''}`
			);
		}
		// A busy skip is the expected outcome under load; not worth logging.
	}
}

/**
 * One number, and it has to be the right one.
 *
 * The first version showed credits spent today next to a $(graph) codicon. The
 * icon was decorative -- a static glyph that never changed, which is worse than
 * no icon because it reads as a fill meter. And "23.0 credits" has no
 * denominator: a developer cannot tell whether that is fine or alarming.
 *
 * What is actionable is time. "5.2d left" answers the only question that
 * matters -- will I still be able to work this week -- and the icon and colour
 * now carry the verdict rather than decoration.
 */
/**
 * Never Copilot's own glyph, and never unlabelled.
 *
 * `$(copilot) 98%` in the status bar reads as a first-party Copilot readout --
 * it borrows GitHub's mark to report a number GitHub did not produce. A name
 * of our own is what makes the attribution honest, so it ships in every state.
 *
 * The mark never changes. Severity is carried by the background colour and by
 * the text after the separator, not by swapping the icon -- a status bar item
 * whose glyph keeps changing is one nobody can find at a glance.
 */
/**
 * Three marks, and only three.
 *
 * The icon says what the *extension* is doing, never how much allowance is
 * left -- severity is the background colour. Reading them is meant to take no
 * thought: pie chart means it is showing you something, spinner means wait,
 * warning means it is broken and the logs will say why.
 */
const MARK = {
	ready: '$(pie-chart)',
	busy: '$(sync~spin)',
	broken: '$(warning)'
} as const;

/**
 * The icon carries the name; the text carries only state.
 *
 * This read "TP | 97%". The initials were doing the identifying back when the
 * mark was a generic codicon shared with every other extension, and the pie
 * has been the product's own logo everywhere else for a while now. Two
 * characters and a separator of pure redundancy in the most crowded strip of
 * the window.
 */
function label(mark: string, state: string): string {
	return `${mark} ${state}`;
}

function updateStatusBar(): void {
	if (!config().get<boolean>('statusBar.enabled', true)) {
		statusBar.hide();
		return;
	}

	// While work is in flight, the item reports the work. A spinning icon is
	// the difference between "this is slow" and "this is broken", and the
	// reported symptom for the latter was that the button had vanished.
	const busy = phaseLabel(progress);
	if (busy) {
		// The phase used to be the text, and the text was four widths in two
		// seconds: "usage", "history 24/61", "allowance", then the figure. The
		// strip is packed, so every item beside it moved each time. Once there
		// is a figure the figure stays and only the mark spins -- both marks
		// are one codicon, so nothing reflows. The phase moves to the tooltip,
		// which is where a detail that changes three times a refresh belongs.
		const settled = projection !== undefined && projection.verdict !== 'unknown';
		statusBar.text = label(MARK.busy, settled ? barLabel(projection!) : busy);
		statusBar.tooltip =
			`Token Pie is reading your usage (${busy}). The editor stays usable; ` +
			(settled
				? 'the figures stand from the last complete reading until it finishes.'
				: 'the report opens once this finishes.');
		statusBar.backgroundColor = undefined;
		// Nothing to open yet, so the click does nothing rather than showing a
		// half-built report and looking broken.
		statusBar.command = undefined;
		statusBar.show();
		return;
	}

	if (progress.phase === 'failed') {
		statusBar.text = label(MARK.broken, 'error');
		statusBar.tooltip = 'Token Pie hit an error and stopped. Click to open the log.';
		statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		statusBar.command = 'tokenPie.showLogs';
		statusBar.show();
		return;
	}

	// A refresh that finished but hit problems still has something to say, so
	// the figure stays and the mark reports the trouble.
	const degraded = lastErrors.length > 0;
	statusBar.command = degraded ? 'tokenPie.showLogs' : 'tokenPie.showReport';
	const mark = degraded ? MARK.broken : MARK.ready;

	const p = projection;
	if (!p || p.verdict === 'unknown') {
		statusBar.text = label(mark, '--');
		statusBar.tooltip = unknownTooltip(p?.unknownReason);
		statusBar.backgroundColor = undefined;
		statusBar.show();
		return;
	}

	// Two horizons on one item: the month, which is a fact until the reset, and
	// today, which is the only figure this afternoon can still move.
	statusBar.text = label(mark, barLabel(p));

	// One background, not two signals fighting over it. The month's severity
	// and the day's pressure are both ranked on the same scale and the higher
	// one wins; the tooltip says which, so the colour is never unexplained.
	const monthly =
		p.verdict === 'exhausted' || p.verdict === 'will-exhaust' ? 2
		: p.verdict === 'tight' ? 1
		: 0;
	const pressure = dayPressure(p, tuning().tuning);
	const daily = pressure === 'over' ? 2 : pressure === 'near' ? 1 : 0;
	const severity = Math.max(monthly, daily);
	statusBar.backgroundColor =
		severity === 2 ? new vscode.ThemeColor('statusBarItem.errorBackground')
		: severity === 1 ? new vscode.ThemeColor('statusBarItem.warningBackground')
		: undefined;

	statusBar.tooltip = degraded
		? `Token Pie read what it could, but ${lastErrors.length} problem` +
		  `${lastErrors.length === 1 ? '' : 's'} came up. Click to open the log; ` +
		  'the report is on the command palette.'
		: buildTooltip(p, daily > monthly ? 'day' : monthly > 0 ? 'month' : undefined);
	statusBar.show();
}

/**
 * Say which unknown this is.
 *
 * Telling a signed-in user to run a check they have already run, because their
 * plan reports no metered quota, leaves them with no way to resolve it.
 */
function unknownTooltip(reason: Projection['unknownReason']): string {
	switch (reason) {
		case 'no-binding-quota':
			return 'Token Pie: signed in, but this plan reports no metered quota to project ' +
				'against -- every allowance came back unlimited or absent. Spend is still ' +
				'tracked; click for the report.';
		case 'no-remaining-figure':
			return 'Token Pie: this plan reports a quota but no remaining figure, so there is ' +
				'nothing to project against. Spend is still tracked; click for the report.';
		default:
			return 'Token Pie: not signed in to GitHub yet. Run "Token Pie: Check Quota".';
	}
}

function buildTooltip(
	p: Projection,
	/** Which horizon is driving the background colour, so it is never unexplained. */
	driving?: 'day' | 'month'
): vscode.MarkdownString {
	const md = new vscode.MarkdownString();
	md.supportThemeIcons = true;
	// The hover reports GitHub's numbers, so it has to say who is reporting
	// them. Without this line it reads as a Copilot-authored readout.
	md.appendMarkdown('$(pie-chart) **Token Pie**\n\n');

	const headline =
		p.verdict === 'exhausted'
			? `**Your ${p.quotaId ?? 'allowance'} is used up.**` +
			  (p.creditsUsed !== undefined && p.entitlement
				? ` ${fmt(p.creditsUsed)} credits used against an allowance of ${fmt(p.entitlement)}.`
				: '') +
			  ' Copilot will refuse premium requests until it resets.'
		: p.verdict === 'will-exhaust' && p.exhaustDate
			? `**You run out on ${p.exhaustDate.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}**, before your quota resets.`
			: p.verdict === 'tight'
				? '**Close to the line.** Little headroom before the quota resets.'
				: p.verdict === 'no-rate'
					? 'Not enough history yet to project a burn rate.'
					: '**On track.** Current pace stays within the allowance.';
	md.appendMarkdown(`${headline}\n\n`);

	if (p.remaining !== undefined && p.entitlement) {
		md.appendMarkdown(
			`Remaining: **${fmt(p.remaining)} / ${fmt(p.entitlement)}** credits` +
			(p.percentRemaining !== undefined ? ` (${Math.round(p.percentRemaining)}%)` : '') +
			`  \n`
		);
	}
	if (p.todayBudget !== undefined && p.todayShare !== undefined) {
		// The status bar shows a percent; the hover shows the credits behind it,
		// because "118% today" is a reading nobody can act on without knowing
		// what the day was allowed to cost.
		md.appendMarkdown(
			`Today: **${fmt(p.todayCredits ?? 0)} of ${fmt(p.todayBudget)}** credits` +
			` (${Math.round(p.todayShare * 100)}%)  \n`
		);
	}
	if (p.burnPerDay !== undefined) {
		// The window is stated only when it is known. `?? 0` printed "over 0.0
		// days", which is a measurement nobody took.
		const over = p.daysObserved !== undefined
			? ` over ${fmtDaysWith(p.daysObserved)}` : '';
		md.appendMarkdown(`Your pace: **${fmt(p.burnPerDay)} credits/day**${over}  \n`);
	}
	if (p.sustainableDailyBurn !== undefined) {
		// "credits/day until reset" reads as a rate you can hold for whatever is
		// left, and on the final day what is left is a few hours. So the last
		// day drops the rate entirely: the allowance does not carry over, so
		// everything remaining is simply today's to spend. Any other day names
		// the span it is averaged over, which was the number nobody could see.
		const days = p.daysToCover;
		md.appendMarkdown(days === 1
			? `Sustainable: **${fmt(p.sustainableDailyBurn)} credits** today  \n`
			: `Sustainable: **${fmt(p.sustainableDailyBurn)} credits/day**` +
			  `${days !== undefined ? ` over the ${days} days left` : ' until reset'}  \n`);
	}
	if (p.daysToReset !== undefined) {
		// Not `fmt(...) days`: under a day the figure counts hours, and this
		// line read "resets in 0.3 days" while the panel beside it said eight
		// hours. One formatter for the figure and its unit, as everywhere else.
		md.appendMarkdown(`Quota resets in **${fmtDaysWith(p.daysToReset)}**  \n`);
	}
	// A coloured status bar with no stated cause is a puzzle, and the two
	// horizons share one background -- so say which of them turned it.
	if (driving === 'day') {
		md.appendMarkdown(
			`\nThe colour is **today's budget**, not the month.  \n`
		);
	} else if (driving === 'month') {
		md.appendMarkdown(`\nThe colour is **the month**, not today.  \n`);
	}
	// Says where the click goes, not just that it does something: a click that
	// opened a tab and now reveals a view is a different promise.
	md.appendMarkdown(`\n_${p.quotaId ?? 'quota'} — click for detail_`);
	return md;
}

function fmt(n: number): string {
	return n >= 100 ? String(Math.round(n)) : n.toFixed(1);
}

/** Refresh the entitlement without prompting anyone to sign in. */
async function refreshEntitlement(): Promise<void> {
	try {
		entitlement = await fetchEntitlement(false);
	} catch {
		// No silent session, or the endpoint is unreachable. The status bar
		// degrades to "--" rather than nagging mid-task.
	}
}

function recomputeProjection(): void {
	const t = tuning().tuning;
	projection = project(
		entitlement,
		store.since(t.history.days),
		creditsPerNanoAiu(),
		Date.now(),
		t
	);
}

function buildHtml(): string {
	const warnings: string[] = [];
	if (lastResult && lastResult.dbCount === 0) {
		warnings.push(
			'No agent-traces.db found. Run "Token Pie: Enable Local Trace Collection", reload, and use Copilot Chat.'
		);
	}
	// Both reach the reader; only errors reach `lastErrors`, and only that
	// makes the status bar send its click to the log rather than here.
	if (lastResult?.errors.length) {
		warnings.push(...lastResult.errors);
	}
	if (lastNotices.length) {
		warnings.push(...lastNotices);
	}
	// Only warn about content that is actually substantial. With
	// maxAttributeSizeChars set to 1 the keys still exist but hold a single
	// character, and warning about that would be noise.
	const AVG_BYTES_PER_SPAN_THRESHOLD = 200;
	if (
		lastResult &&
		lastResult.contentSpans > 0 &&
		lastResult.contentBytes / lastResult.contentSpans > AVG_BYTES_PER_SPAN_THRESHOLD
	) {
		const mb = (lastResult.contentBytes / 1024 / 1024).toFixed(1);
		warnings.push(
			`The trace database is storing prompt and response text: ${lastResult.contentSpans} span(s), ~${mb} MB. ` +
			`Set "${MAX_ATTR_SETTING}" to 1 and reload -- its default of 0 means unlimited, and ` +
			'captureContent does not suppress the first-party chat path.'
		);
	}

	const coverage =
		lastResult && lastResult.spansCounted > 0
			? lastResult.costSpans / lastResult.spansCounted
			: 1;

	const t = tuning().tuning;
	const inspected = config().inspect<number>('creditsPerNanoAiu');
	return renderReport({
		rollups: store.since(t.history.days),
		creditsPerNanoAiu: creditsPerNanoAiu(),
		// Whether the developer set this changes only how the doubt is worded,
		// not whether there is any: a hand-set conversion is still unverified.
		conversionOverridden: inspected?.globalValue !== undefined
			|| inspected?.workspaceValue !== undefined,
		tuning: t,
		dbCount: lastResult?.dbCount ?? 0,
		lastRefresh,
		costCoverage: coverage,
		warnings,
		projection,
		prices: store.priceStats(),
		depth: store.depthStats(),
		conversations: store.conversationStats(),
		history: {
			traceStartDay: lastResult?.traceStartMs !== undefined
				? dayKey(lastResult.traceStartMs) : undefined,
			oldestTranscriptDay: lastResult?.backfill?.oldestTranscriptDay,
			recoveredMessages: lastResult?.backfill?.turnsCounted ?? 0
		}
	});
}

/* ------------------------------------------------------- rate card --- */

/** Where a fetched card is cached. Beside the rollup, not inside the package. */
function cardCachePath(): string | undefined {
	return extensionContext
		? path.join(extensionContext.globalStorageUri.fsPath, 'rate-card.json')
		: undefined;
}

function currentCard(): LoadedCard {
	return loadCard({
		bundledPath: path.join(extensionContext!.extensionUri.fsPath, 'rate-card.json'),
		cachePath: cardCachePath(),
		override: config().get('rateCard.models') ?? undefined
	});
}

/**
 * Weekly, and never on the critical path.
 *
 * Nothing on the panel needs this to succeed: the extension ships a dated
 * snapshot, so a machine that never reaches the network still compares measured
 * rates against published ones. A refused fetch is logged and forgotten.
 */
async function refreshRateCard(manual = false): Promise<void> {
	const cachePath = cardCachePath();
	if (!cachePath) {
		return;
	}
	if (!manual && !config().get<boolean>('rateCard.autoUpdate', true)) {
		return;
	}
	if (!manual && !isDue(cachePath)) {
		return;
	}
	const url = config().get<string>(
		'rateCard.url',
		'https://raw.githubusercontent.com/token-pie/token-pie/main/rate-card.json'
	);
	const result = await refreshCard(url, cachePath);
	output.appendLine(`rate card refresh: ${result.outcome} -- ${result.note}`);
	if (!manual) {
		return;
	}

	// A source with no card yet is the ordinary state, not a fault: the bundled
	// table is what the comparison runs on either way, and it is dated. Saying
	// "kept the existing price table -- 404" reads as a broken extension when
	// nothing is wrong, so each outcome says what it actually means for you.
	const card = currentCard().card;
	const bundled = `The bundled table, effective ${card.effective}, is still in use.`;
	const message =
		result.outcome === 'updated'
			? `Token Pie: published prices updated -- ${result.note}.`
		: result.outcome === 'not-published'
			? `Token Pie: no newer price list published at that URL yet. ${bundled}`
		: result.outcome === 'malformed'
			? `Token Pie: that URL did not return a rate card, so it was ignored. ${bundled}`
			: `Token Pie: could not reach the price list -- ${result.note}. ${bundled}`;
	void (result.outcome === 'updated' || result.outcome === 'not-published'
		? vscode.window.showInformationMessage(message)
		: vscode.window.showWarningMessage(message));
	repaint();
}

/* ----------------------------------------------------- token specs --- */

function buildSpecsHtml(): string {
	const { tuning: t, readings } = tuning();
	const inspected = config().inspect<number>('creditsPerNanoAiu');
	return renderSpecs({
		rollups: store.since(t.history.days),
		creditsPerNanoAiu: creditsPerNanoAiu(),
		// `inspect` distinguishes "left alone" from "set to the same value",
		// which matters here: the page's whole claim is that this number is
		// assumed unless somebody has checked it.
		creditsPerNanoAiuIsDefault:
			inspected?.globalValue === undefined && inspected?.workspaceValue === undefined,
		prices: store.priceStats(),
		readings,
		card: currentCard(),
		// The same reconciliation the panel draws, so the two pages cannot
		// disagree about whether the conversion has been checked.
		coverage: periodCoverage({
			resetDate: projection?.resetDate,
			githubCredits: projection?.creditsUsed ??
				(projection?.entitlement !== undefined && projection?.remaining !== undefined
					? Math.max(0, projection.entitlement - projection.remaining)
					: undefined),
			creditsByDay: creditsByDay(store.since(t.history.days), creditsPerNanoAiu()),
			traceStartMs: lastResult?.traceStartMs,
			tuning: t
		}),
		pipeline: {
			databases: lastResult?.dbCount ?? 0,
			spansScanned: lastResult?.spansScanned ?? 0,
			spansCounted: lastResult?.spansCounted ?? 0,
			costSpans: lastResult?.costSpans ?? 0,
			recoveredMessages: lastResult?.backfill?.turnsCounted ?? 0,
			errors: [...lastErrors, ...lastNotices]
		},
		lastRefresh
	});
}

function showSpecs(context: vscode.ExtensionContext): void {
	if (consolePanel) {
		consolePanel.reveal();
		consolePanel.webview.html = buildSpecsHtml();
		return;
	}
	consolePanel = vscode.window.createWebviewPanel(
		'tokenPie.specs',
		'Token Pie: Token Specs',
		vscode.ViewColumn.Active,
		{ enableScripts: false, retainContextWhenHidden: true }
	);
	consolePanel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'images', 'icon.png');
	consolePanel.webview.html = buildSpecsHtml();
	consolePanel.onDidDispose(() => { consolePanel = undefined; }, undefined, context.subscriptions);
}

/** Every surface that draws the rollup, repainted from one place. */
function repaint(): void {
	if (panel) {
		panel.webview.html = buildHtml();
	}
	if (consolePanel) {
		consolePanel.webview.html = buildSpecsHtml();
	}
	sidebar?.repaint();
}

/**
 * The compact view in the activity bar.
 *
 * A webview view rather than a tree: the panel's figures are a meter and a
 * chart, and a tree of label-value rows would be a worse rendering of both.
 *
 * `enableCommandUris` rather than a script. The link back to the full report
 * is the only interactive thing here, and a `command:` href needs no script at
 * all -- which keeps the same guarantee the panel makes.
 */
class Sidebar implements vscode.WebviewViewProvider {
	static readonly viewId = 'tokenPie.summary';
	private view?: vscode.WebviewView;

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: false, enableCommandUris: true };
		this.repaint();
		view.onDidDispose(() => { this.view = undefined; });
		// Rendered from cached state, so a view revealed after a refresh shows
		// what the panel shows rather than waiting for the next cycle.
		view.onDidChangeVisibility(() => { if (view.visible) { this.repaint(); } });
	}

	repaint(): void {
		if (!this.view) {
			return;
		}
		const t = tuning().tuning;
		this.view.webview.html = renderCompact({
			rollups: store.since(t.history.days),
			creditsPerNanoAiu: creditsPerNanoAiu(),
			projection,
			tuning: t,
			warnings: [...lastErrors, ...lastNotices]
		});
	}
}

let sidebar: Sidebar | undefined;

function showReport(context: vscode.ExtensionContext): void {
	if (panel) {
		panel.reveal();
		panel.webview.html = buildHtml();
		return;
	}

	panel = vscode.window.createWebviewPanel(
		'tokenPie.report',
		'Token Pie',
		vscode.ViewColumn.Active,
		{ enableScripts: false, retainContextWhenHidden: true }
	);
	// The editor tab is the one place outside the page itself that can carry a
	// real image, so it takes the same icon the Marketplace listing uses. The
	// status bar cannot: its label accepts codicons only, so `$(pie-chart)`
	// stays the closest available match there.
	panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'images', 'icon.png');
	panel.webview.html = buildHtml();
	panel.onDidDispose(() => { panel = undefined; }, undefined, context.subscriptions);
}

/**
 * Removes retained model output and tool schemas from the trace database.
 *
 * Confirmed against copilot-chat 0.62.0: `maxAttributeSizeChars` is honoured
 * everywhere except three call sites that omit the limit argument, so those
 * payloads cannot be suppressed by configuration. Deleting them afterwards is
 * the only remedy short of an upstream fix.
 */
async function purgeContent(): Promise<void> {
	const confirmed = await vscode.window.showWarningMessage(
		'Delete retained prompt content and tool schemas from Copilot\'s trace database? ' +
		'Usage and cost data are untouched, but the Chat Debug View will lose history.',
		{ modal: true },
		'Purge'
	);
	if (confirmed !== 'Purge') {
		return;
	}

	const results = purgeAll({ vacuum: true });
	const failures = results.filter(r => r.error);
	const freedKb = results.reduce((n, r) => n + r.bytesFreed, 0) / 1024;
	const rows = results.reduce((n, r) => n + r.attributeRows + r.eventRows, 0);

	for (const r of results) {
		output.appendLine(
			r.error
				? `[purge] FAILED ${redactPaths(r.db)}: ${redactPaths(r.error)}`
				: `[purge] ${redactPaths(r.db)}: ${r.attributeRows} attrs, ${r.eventRows} events, ${(r.bytesFreed / 1024).toFixed(1)} KB`
		);
	}

	if (failures.length > 0) {
		void vscode.window.showErrorMessage(
			`Token Pie: purge failed for ${failures.length} database(s). See the Token Pie output channel.`
		);
	} else {
		void vscode.window.showInformationMessage(
			`Token Pie: purged ${rows} row(s), freed ${freedKb.toFixed(1)} KB.`
		);
	}
}

/**
 * The gate test for the whole thesis: does the endpoint return a real
 * allowance we can project a throttle date against?
 *
 * Dumps the parsed snapshots and the raw payload, because the shape of
 * quota_snapshots is not contractual and the raw body is what tells us how to
 * read the next version of it.
 */
async function checkQuota(): Promise<void> {
	output.clear();
	output.show(true);
	output.appendLine('Token Pie - quota check');
	output.appendLine('='.repeat(60));

	try {
		// Always show the picker: the account VS Code defaults to is frequently
		// not the one carrying the Copilot subscription.
		// Try the remembered account first. Forcing the picker every time meant
		// the choice never stuck, so the silent background refresh kept failing
		// and the status bar kept asking for a check that had already run.
		let e = await fetchEntitlement(true, false);
		if (!hasCopilotAccess(e)) {
			output.appendLine('this account has no Copilot access -- asking which account to use');
			e = await fetchEntitlement(true, true);
		}

		// Commit it. Holding the result in a local meant the check succeeded
		// while the status bar stayed at "--", still asking for a check that
		// had already run.
		entitlement = e;
		recomputeProjection();
		updateStatusBar();
		// The name is never printed. This block sits under a heading that
		// promises identifiers were removed, and the log exists to be pasted
		// into an issue; whether an account came back is the diagnostic, who
		// it belongs to is not.
		output.appendLine(`account            ${e.login ? '(signed in)' : '(absent)'}`);
		output.appendLine(`access_type_sku    ${e.accessTypeSku ?? '(absent)'}`);
		output.appendLine(`chat_enabled       ${e.chatEnabled ?? '(absent)'}`);
		output.appendLine(`plan               ${e.plan ?? '(absent)'}`);
		output.appendLine(`quota_reset_date   ${e.resetDate ?? '(absent)'}`);
		output.appendLine(`token_based_billing ${e.tokenBasedBilling ?? '(absent)'}`);
		output.appendLine(`organizations      ${e.organizations.length} (names removed)`);
		output.appendLine('');

		if (!hasCopilotAccess(e)) {
			// Distinguish "wrong account" from "endpoint has no quota data". Only
			// the second says anything about whether the idea works.
			output.appendLine(
				`INCONCLUSIVE: this account has no Copilot access ` +
				`(access_type_sku=${e.accessTypeSku}, chat_enabled=${e.chatEnabled}).`
			);
			output.appendLine('Re-run and pick the account that actually has Copilot.');
		} else if (e.snapshots.length === 0) {
			output.appendLine(
				'Copilot IS enabled on this account, but no quota_snapshots came back.'
			);
			output.appendLine('That is a real negative result for throttle projection.');
		} else {
			output.appendLine(`quota_snapshots (${e.snapshots.length}):`);
			for (const s of e.snapshots) {
				output.appendLine(
					`  ${s.name.padEnd(24)} entitlement=${s.entitlement ?? '-'} ` +
					`remaining=${s.remaining ?? '-'} percent=${s.percentRemaining ?? '-'} ` +
					`unlimited=${s.unlimited} overage=${s.overagePermitted}`
				);
			}
			const governing = governingSnapshot(e);
			output.appendLine('');
			output.appendLine(`governing snapshot: ${governing ? governing.name : '(none -- all unlimited)'}`);
		}

		// Record this reading and compare it against the previous one. Two
		// readings with chat turns in between is the only way to prove that
		// quota units and copilotCredits are the same currency.
		const readings = new ReadingStore(
			path.join(extensionContext.globalStorageUri.fsPath, 'quota-readings.json')
		);
		const now = Date.now();
		const reading = toReading(e, now);
		output.appendLine('');
		output.appendLine('unit reconciliation');
		output.appendLine('-'.repeat(60));

		if (!reading) {
			output.appendLine('  no binding quota to record');
		} else {
			const previous = readings.previous(reading.quotaId, now);
			readings.add(reading);
			output.appendLine(`  reading: ${reading.quotaId} ${reading.remaining}/${reading.entitlement}`);

			if (!previous) {
				output.appendLine('  first reading recorded. Run some chat turns, then run this again.');
			} else {
				const turns: Turn[] = userDirs().flatMap(d => readTurns(d));
				const r = reconcile(previous, reading, turns);
				const mins = Math.round((r.windowEnd - r.windowStart) / 60000);
				output.appendLine(`  window:  ${mins} min, ${r.turnCount} chat turn(s)`);
				output.appendLine(`  quota consumed:   ${r.quotaDelta.toFixed(4)}`);
				output.appendLine(`  session credits:  ${r.sessionCredits.toFixed(4)}`);
				if (r.ratio !== undefined) {
					output.appendLine(`  ratio:            ${r.ratio.toFixed(3)}  (1.000 = same units)`);
				}
				output.appendLine(`  VERDICT: ${r.verdict.toUpperCase()} -- ${r.note}`);
			}
		}

		output.appendLine('');
		output.appendLine('raw response (identifiers removed):');
		output.appendLine(redactPaths(JSON.stringify(withoutIdentifiers(e.raw), null, 2)));
		void vscode.window.showInformationMessage(
			projection && projection.verdict !== 'unknown'
				? `Token Pie: ${e.login ?? 'account'} — ${statusLabel(projection)} of your ` +
				  `${governingSnapshot(e)?.name ?? 'quota'} allowance. The status bar is live now.`
				: `Token Pie: signed in as ${e.login ?? '?'}, but nothing to project against — ` +
				  `${e.snapshots.length} allowance(s) came back and none reports a limit and a ` +
				  `remaining figure. See the output channel.`
		);
	} catch (err) {
		// Redacted like the refresh path above: an auth or proxy failure names
		// the file it could not read, and this log is written to be shared.
		const safe = redactPaths(err instanceof Error ? err.message : String(err));
		output.appendLine(`FAILED: ${safe}`);
		if (err instanceof QuotaError) {
			output.appendLine('');
			output.appendLine('If this is an auth failure, the endpoint may require the Copilot');
			output.appendLine('token rather than the plain GitHub session token.');
		}
		void vscode.window.showErrorMessage(`Token Pie: quota check failed -- ${safe}`);
	}
}

/** Everything you need to tell whether the pipeline is actually wired up. */
function doctor(): void {
	output.clear();
	output.show(true);

	const root = vscode.workspace.getConfiguration();
	output.appendLine('Token Pie diagnostics');
	output.appendLine('='.repeat(60));
	output.appendLine(`VS Code           ${vscode.version}`);
	output.appendLine(
		`copilot-chat      ${vscode.extensions.getExtension('github.copilot-chat')?.packageJSON.version ?? 'not found'}`
	);
	output.appendLine(`${DB_EXPORTER_SETTING}  ${root.get(DB_EXPORTER_SETTING, false)}`);
	output.appendLine(`${OTEL_ENABLED_SETTING}  ${root.get(OTEL_ENABLED_SETTING, false)}  (must be false for local-only)`);
	output.appendLine(`${CAPTURE_CONTENT_SETTING}  ${root.get(CAPTURE_CONTENT_SETTING, false)}`);
	const maxAttr = num(root.get(MAX_ATTR_SETTING));
	output.appendLine(
		`${MAX_ATTR_SETTING}  ${maxAttr}` +
		(maxAttr === 0 ? '  (0 means UNLIMITED - full prompt text is stored)' : '')
	);
	output.appendLine('');

	const dbs = findTraceDbs();
	output.appendLine(`trace databases: ${dbs.length}`);
	for (const db of dbs) {
		output.appendLine(
			`  ${db.channel}/${db.profile}  ${(db.sizeBytes / 1024 / 1024).toFixed(2)} MB  modified ${new Date(db.mtime).toISOString()}`
		);
		output.appendLine(`    ${redactPaths(db.path)}`);
	}
	if (dbs.length === 0) {
		output.appendLine(`  (also checked tmpdir fallback: ${redactPaths(fallbackDbPath())})`);
	}
	output.appendLine('');

	if (lastResult) {
		output.appendLine(`last ingest: scanned ${lastResult.spansScanned}, counted ${lastResult.spansCounted}, with billed cost ${lastResult.costSpans}`);
		for (const entry of lastResult.schemas) {
			if (entry.schema) {
				const known = entry.schema.version === KNOWN_SCHEMA_VERSION
					? ''
					: `  (verified against ${KNOWN_SCHEMA_VERSION} -- treat with care)`;
				output.appendLine(`  schema_version ${entry.schema.version ?? 'unknown'}${known}`);
				output.appendLine(`    span_attributes table: ${entry.schema.hasAttributes ? 'present' : 'MISSING - no cost data'}`);
				if (entry.schema.missingOptional.length > 0) {
					output.appendLine(`    absent optional columns: ${entry.schema.missingOptional.join(', ')}`);
				}
				output.appendLine(`    columns: ${[...entry.schema.columns].join(', ')}`);
			} else {
				output.appendLine(`  schema detection failed: ${redactPaths(entry.error ?? 'unknown')}`);
			}
		}
	} else {
		output.appendLine('last ingest: none yet');
	}

	output.appendLine('');
	if (lastResult && lastResult.contentSpans > 0) {
		output.appendLine(
			`stored content: ${lastResult.contentSpans} span(s), ${(lastResult.contentBytes / 1024).toFixed(0)} KB of prompt/response/tool text`
		);
		output.appendLine('  Present even with captureContent=false. Local-only, but unencrypted.');
		output.appendLine('');
	}
	output.appendLine(`rollup rows: ${store.all().length}`);
	output.appendLine('');
	output.appendLine('Remote note: in Remote-SSH, devcontainers, or Codespaces the Copilot');
	output.appendLine('extension host runs remotely, so agent-traces.db is written on the remote');
	output.appendLine('machine. Install Token Pie there to capture that usage.');
	output.appendLine('');
	output.appendLine('history available on this machine');
	output.appendLine('-'.repeat(60));
	const bf = lastResult?.backfill;
	output.appendLine(
		`  trace database starts  ${lastResult?.traceStartMs !== undefined
			? dayKey(lastResult.traceStartMs) : '(no spans)'}`);
	output.appendLine(`  chat transcripts       ${bf?.sessionFiles ?? 0} file(s)`);
	output.appendLine(`  oldest transcript      ${bf?.oldestTranscriptDay ?? '(none)'}`);
	output.appendLine(`  transcripts with cost  ${bf?.sessionFilesWithCost ?? 0}`);
	output.appendLine(`  messages recovered     ${bf?.turnsCounted ?? 0}`);
	output.appendLine(
		`  last scan              ${bf?.filesParsed ?? 0} read, ` +
		`${bf?.filesUnchanged ?? 0} skipped as unchanged`);
	if (bf && bf.sessionFiles > 0 && bf.sessionFilesWithCost === 0) {
		output.appendLine('');
		output.appendLine(
			'  No transcript records what it cost. VS Code only began writing token and');
		output.appendLine(
			'  credit figures recently, so nothing before trace collection is recoverable.');
	}
}
