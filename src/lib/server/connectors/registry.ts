/**
 * Connector registry — placeholder for the spike.
 *
 * For now: a single hard-coded handler that decides whether to echo,
 * delegate to OpenClaw, etc. Will be replaced by real per-channel
 * routing once the DB schema is in.
 */

import { openclawConnector } from './openclaw';

export type ConnectorContext = {
	channel_id: string;
	body: string;
};

const ECHO = (process.env.FINN_ECHO_ONLY ?? '').toLowerCase() === '1';

export async function dispatchUserMessage(ctx: ConnectorContext): Promise<string | null> {
	if (ECHO) {
		return `echo: ${ctx.body}`;
	}
	return openclawConnector.send(ctx.body);
}
