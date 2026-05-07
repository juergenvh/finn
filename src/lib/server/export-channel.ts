/**
 * Markdown export for a single channel.
 *
 * Format goals:
 *   - Human-readable as plain text (no markdown renderer required).
 *   - Round-trippable enough that the source-of-truth message body
 *     and timestamp survive verbatim.
 *   - Audit-faithful: approval decisions appear inline with the
 *     agent message they applied to.
 *   - Includes archived/deleted state notes in the channel header
 *     so a stale export reads honestly.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from './db/client.ts';
import { agents, channelMembers, channels, type Message, type Approval } from './db/schema.ts';
import { recentMessages } from './messages.ts';
import { approvalsForMessages, targetsOf } from './approvals.ts';

export type ChannelExport = {
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

function senderName(
	m: Message,
	agentNameById: Map<string, string>
): string {
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
			return a.rejectReason
				? `_rejected: "${a.rejectReason}"_`
				: `_rejected_`;
	}
}

export function exportChannelMarkdown(channelId: string): ChannelExport | null {
	const db = getDb();
	const channel = db.select().from(channels).where(eq(channels.id, channelId)).get();
	if (!channel) return null;

	// Collect all member agents (including soft-deleted, so historical
	// senders resolve correctly).
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

	// Pull the full history. We deliberately use a high cap rather
	// than an unbounded fetch; for the export-everything use case
	// 5000 is far more than expected and still fits in memory.
	const allMessages = recentMessages(channelId, 5000);
	const approvals = approvalsForMessages(allMessages.map((m) => m.id));
	const approvalByMessageId = new Map(approvals.map((a) => [a.messageId, a]));

	const lines: string[] = [];
	lines.push(`# ${channel.name}`);
	lines.push('');
	if (channel.description) {
		lines.push(`> ${channel.description}`);
		lines.push('');
	}
	lines.push(`- Channel id: \`${channel.id}\``);
	lines.push(`- Created: ${fmtTs(channel.createdAt)}`);
	if (channel.deletedAt) {
		lines.push(`- **Archived: ${fmtTs(channel.deletedAt)}**`);
	}
	if (memberRows.length > 0) {
		lines.push(`- Members:`);
		for (const m of memberRows) {
			const tag = m.deletedAt ? ' (archived)' : '';
			lines.push(`  - **${m.name}** \`${m.connectorType}\`${tag}`);
		}
	}
	lines.push(`- Exported: ${fmtTs(Date.now())}`);
	lines.push('');
	lines.push('---');
	lines.push('');

	if (allMessages.length === 0) {
		lines.push('_(no messages)_');
	} else {
		for (const m of allMessages) {
			const who = senderName(m, agentNameById);
			lines.push(`### ${who} · ${fmtTs(m.createdAt)}`);
			lines.push('');
			// Body verbatim. We don't escape Markdown inside the body
			// because finn does not render it today; if export
			// readers re-render through Markdown, agent code blocks
			// and bullets will Just Work.
			lines.push(m.body);
			const approval = approvalByMessageId.get(m.id);
			if (approval) {
				lines.push('');
				lines.push(approvalSummary(approval, agentNameById));
			}
			lines.push('');
		}
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
	const safeName = channel.name.replace(/[^a-zA-Z0-9_-]+/g, '-');
	return {
		filename: `${safeName}-${stamp}.md`,
		body: lines.join('\n')
	};
}
