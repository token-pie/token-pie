import * as vscode from 'vscode';
import { Entitlement, parseSnapshots, str } from './entitlement';

export * from './entitlement';

/**
 * Real entitlement, read from the endpoint Copilot itself uses.
 *
 * This is the half nobody joins. Every usage tracker on the Marketplace either
 * reports spend against a budget the user typed in, or reports quota with no
 * spend attached. Combining actual remaining allowance with observed burn rate
 * is what turns "you have spent 12 credits" into "you get cut off on Thursday".
 *
 * The endpoint is internal and unversioned -- the same one the bundled
 * copilot-chat extension calls -- so every field is treated as optional and the
 * raw payload is preserved for diagnostics.
 */

const USER_ENDPOINT = 'https://api.github.com/copilot_internal/user';

/** Long enough for a slow corporate proxy, short enough to fail visibly. */
const REQUEST_TIMEOUT_MS = 15_000;

export class QuotaError extends Error {}

async function githubToken(interactive: boolean, chooseAccount: boolean): Promise<string> {
	// Signing in to GitHub for one purpose (say, pushing a repo) silently makes
	// that account the default for every extension. Copilot may well be on a
	// different account, so the interactive path can force the picker.
	const session = await vscode.authentication.getSession(
		'github',
		['read:user'],
		interactive
			? { createIfNone: true, clearSessionPreference: chooseAccount }
			: { createIfNone: false, silent: true }
	);
	if (!session) {
		throw new QuotaError('No GitHub session. Run "Token Pie: Check Quota" to sign in.');
	}
	return session.accessToken;
}

/**
 * Identifies this extension to GitHub, under its own name.
 *
 * It previously claimed to be Copilot Chat, which meant GitHub's logs
 * attributed this traffic to Copilot -- the same impersonation the status bar
 * was corrected for, one layer down and less visible. Probed against a live
 * account: the endpoint returns 200 for both, so the Copilot identity buys
 * nothing and is not used.
 */
export function userAgent(): string {
	const version = vscode.extensions.getExtension('token-pie.token-pie')
		?.packageJSON?.version;
	return version ? `token-pie/${version}` : 'token-pie';
}

export async function fetchEntitlement(
	interactive = false,
	chooseAccount = false,
	agent: string = userAgent()
): Promise<Entitlement> {
	const token = await githubToken(interactive, chooseAccount);

	// Without a deadline a proxied or captive network leaves this pending
	// forever, and every caller that awaits it stalls with it.
	const response = await fetch(USER_ENDPOINT, {
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		headers: {
			Authorization: `token ${token}`,
			Accept: 'application/json',
			'Editor-Version': `vscode/${vscode.version}`,
			'User-Agent': agent
		}
	});

	if (!response.ok) {
		throw new QuotaError(
			`${USER_ENDPOINT} returned ${response.status} ${response.statusText}`
		);
	}

	return parseEntitlement((await response.json()) as Record<string, unknown>);
}

function parseEntitlement(body: Record<string, unknown>): Entitlement {
	return {
		login: str(body['login']),
		accessTypeSku: str(body['access_type_sku']),
		chatEnabled: typeof body['chat_enabled'] === 'boolean'
			? (body['chat_enabled'] as boolean)
			: undefined,
		plan: str(body['copilot_plan']) ?? str(body['sku']),
		resetDate: str(body['quota_reset_date_utc']) ?? str(body['quota_reset_date']),
		tokenBasedBilling: typeof body['token_based_billing'] === 'boolean'
			? (body['token_based_billing'] as boolean)
			: undefined,
		snapshots: parseSnapshots(body['quota_snapshots']),
		organizations: Array.isArray(body['organization_login_list'])
			? (body['organization_login_list'] as unknown[]).map(String)
			: [],
		raw: body
	};
}
