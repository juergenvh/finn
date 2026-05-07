/**
 * Markdown export — single channel and cross-channel (issues #2, #14).
 *
 * Format goals:
 *   - Human-readable as plain text (no markdown renderer required).
 *   - Round-trippable enough that the source-of-truth message body
 *     and timestamp survive verbatim.
 *   - Audit-faithful: approval decisions appear inline with the
 *     agent message they applied to. Groomed (hidden_at IS NOT NULL)
 *     messages are included with a marker — exports are audit, per
 *     ADR-0004 addendum.
 *   - Channel context (archived state, members) appears in the
 *     header for single-channel exports; for protocol-viewer
 *     exports, each message gets a `[#channel-name]` prefix on its
 *     heading instead.
 */

import { eq } from 'drizzle-orm';
import { getDb } from './db/client.ts';
import { agents, channelMembers, channels, type Message, type Approval } from './db/schema.ts';
import { recentMessages } from './messages.ts';
import { approvalsForMessages, targetsOf } from './approvals.ts';

export type Export = {
	filename: string;
	body: string;
};

function fmtTs(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
	);
}

function senderName(m: Message, agentNameById: Map<string, string>): string {
	if (m.senderType === 'user') return m.senderId ?? 'user';
	if (m.senderType === 'agent') return agentNameById.get(m.senderId ?? '') ?? m.senderId ?? 'agent';
	return 'system';
}

function approvalSummary(a: Approval, agentNameById: Map<string, string>): string {
	const targets = targetsOf(a)
		.map((id) => agentNameById.get(id) ?? id)
		.join(', ');
	switch (a.status) {
		case 'pending':
			return `_approval pending → ${targets || '(no targets)'}_`;
		case 'approved':
			return `_approved → ${targets} (relay in progress)_`;
		case 'routed':
			return `_routed → ${targets}_`;
		case 'rejected':
			return a.rejectReason ? `_rejected: "${a.rejectReason}"_` : `_rejected_`;
	}
}

/**
 * Render a list of messages as audit markdown. Pure function.
 * Caller decides what messages to include and what header text to
 * prepend. Channel-name-prefix on each heading is opt-in for
 * cross-channel renderings.
 */
export function renderMessagesAsMarkdown(args: {
	header: string[];
	messages: Message[];
	agentNameById: Map<string, string>;
	channelNameById?: Map<string, string>;
	includeChannelInHeading?: boolean;
}): string {
	const { header, messages: msgs, agentNameById, channelNameById, includeChannelInHeading } = args;
	const approvalsRows = approvalsForMessages(msgs.map((m) => m.id));
	const approvalByMessageId = new Map(approvalsRows.map((a) => [a.messageId, a]));

	const lines: string[] = [...header];
	if (msgs.length === 0) {
		lines.push('_(no messages)_');
	} else {
		for (const m of msgs) {
			const who = senderName(m, agentNameById);
			const channelTag =
				includeChannelInHeading && channelNameById
					? `[#${channelNameById.get(m.channelId) ?? m.channelId}] `
					: '';
			lines.push(`### ${channelTag}${who} · ${fmtTs(m.createdAt)}`);
			lines.push('');
			lines.push(m.body);
			const approval = approvalByMessageId.get(m.id);
			if (approval) {
				lines.push('');
				lines.push(approvalSummary(approval, agentNameById));
			}
			if (m.hiddenAt !== null) {
				lines.push('');
				lines.push(`_hidden from channel view at ${fmtTs(m.hiddenAt)}_`);
			}
			lines.push('');
		}
	}
	return lines.join('\n');
}

/**
 * Single-channel export. Audit-faithful: includes groomed messages
 * (hidden_at IS NOT NULL) since the export *is* the audit record.
 */
export function exportChannelMarkdown(channelId: string): Export | null {
	const db = getDb();
	const channel = db.select().from(channels).where(eq(channels.id, channelId)).get();
	if (!channel) return null;

	const memberRows = db
		.select({
			id: agents.id,
			name: agents.name,
			connectorType: agents.connectorType,
			deletedAt: agents.deletedAt
		})
		.from(channelMembers)
		.innerJoin(agents, eq(channelMembers.agentId, agents.id))
		.where(eq(channelMembers.channelId, channelId))
		.all();

	const agentNameById = new Map(memberRows.map((m) => [m.id, m.name]));

	// Audit-scope: includes hidden messages.
	const allMessages = recentMessages(channelId, 5000, undefined, 'all');

	const header: string[] = [];
	header.push(`# ${channel.name}`);
	header.push('');
	if (channel.description) {
		header.push(`> ${channel.description}`);
		header.push('');
	}
	header.push(`- Channel id: \`${channel.id}\``);
	header.push(`- Created: ${fmtTs(channel.createdAt)}`);
	if (channel.deletedAt) {
		header.push(`- **Archived: ${fmtTs(channel.deletedAt)}**`);
	}
	if (memberRows.length > 0) {
		header.push(`- Members:`);
		for (const m of memberRows) {
			const tag = m.deletedAt ? ' (archived)' : '';
			header.push(`  - **${m.name}** \`${m.connectorType}\`${tag}`);
		}
	}
	header.push(`- Exported: ${fmtTs(Date.now())}`);
	header.push('');
	header.push('---');
	header.push('');

	const body = renderMessagesAsMarkdown({
		header,
		messages: allMessages,
		agentNameById
	});

	const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
	const safeName = channel.name.replace(/[^a-zA-Z0-9_-]+/g, '-');
	return {
		filename: `${safeName}-${stamp}.md`,
		body
	};
}

/**
 * Cross-channel protocol export. Used by the protocol viewer (#14).
 * Caller passes the already-filtered messages plus a description of
 * the filter for the header. Channel-name-prefix is added to each
 * message heading so a single file can carry rows from many channels.
 */
export function exportProtocolMarkdown(args: {
	rows: Message[];
	filterSummary: string[];
}): Export {
	const { rows, filterSummary } = args;
	const db = getDb();

	const allAgents = db.select({ id: agents.id, name: agents.name }).from(agents).all();
	const agentNameById = new Map(allAgents.map((a) => [a.id, a.name]));

	const channelRows = db.select({ id: channels.id, name: channels.name }).from(channels).all();
	const channelNameById = new Map(channelRows.map((c) => [c.id, c.name]));

	const header: string[] = [];
	header.push(`# finn — protocol export`);
	header.push('');
	header.push(`- Exported: ${fmtTs(Date.now())}`);
	header.push(`- Rows: ${rows.length}`);
	if (filterSummary.length > 0) {
		header.push('- Filter:');
		for (const f of filterSummary) header.push(`  - ${f}`);
	}
	header.push('');
	header.push('---');
	header.push('');

	const body = renderMessagesAsMarkdown({
		header,
		messages: rows,
		agentNameById,
		channelNameById,
		includeChannelInHeading: true
	});

	const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
	return {
		filename: `protocol-${stamp}.md`,
		body
	};
}
