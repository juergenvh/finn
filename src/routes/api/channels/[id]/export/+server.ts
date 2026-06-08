/**
 * GET /api/channels/:id/export?format=md
 *
 * Returns a markdown rendering of the entire channel as a download.
 * Browser triggers the file save via the Content-Disposition header.
 *
 * Format defaults to `md` and is the only supported value today.
 */

import { error } from '@sveltejs/kit';
import { exportChannelMarkdown, exportChannelMemoryLog } from '$lib/server/export-channel';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url }) => {
	const format = url.searchParams.get('format') ?? 'md';

	if (format === 'memory') {
		const sinceRaw = url.searchParams.get('since');
		const untilRaw = url.searchParams.get('until');
		const sinceMs = sinceRaw ? new Date(sinceRaw).getTime() : undefined;
		const untilMs = untilRaw ? new Date(untilRaw).getTime() : undefined;
		const exported = exportChannelMemoryLog(params.id, sinceMs, untilMs);
		if (!exported) throw error(404, 'channel not found');
		return new Response(exported.body, {
			headers: {
				'content-type': 'text/markdown; charset=utf-8',
				'content-disposition': `attachment; filename="${exported.filename}"`
			}
		});
	}

	if (format !== 'md') throw error(400, `unsupported export format: ${format}`);

	const exported = exportChannelMarkdown(params.id);
	if (!exported) throw error(404, 'channel not found');

	return new Response(exported.body, {
		headers: {
			'content-type': 'text/markdown; charset=utf-8',
			'content-disposition': `attachment; filename="${exported.filename}"`
		}
	});
};
