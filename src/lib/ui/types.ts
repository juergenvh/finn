/**
 * UI-side type mirrors. These match the wire types in
 * src/lib/server/ws/attach.ts but live separately so the client
 * code does not import server modules.
 */

export type ChannelInfo = { id: string; name: string; description: string | null };

export type AgentInfo = {
	id: string;
	name: string;
	connectorType: string;
	enabled: boolean;
};

export type DBMessage = {
	id: string;
	channelId: string;
	senderType: 'user' | 'agent' | 'system';
	senderId: string | null;
	body: string;
	createdAt: number;
};

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'routed';

export type ApprovalSnapshot = {
	id: string;
	messageId: string;
	status: ApprovalStatus;
	targets: string[];
	rejectReason: string | null;
	createdAt: number;
	decidedAt: number | null;
};

export type WSInbound =
	| {
			type: 'message';
			channel_id: string;
			sender: 'user' | 'agent' | 'system';
			sender_id: string | null;
			body: string;
			ts: number;
			id: string;
	  }
	| { type: 'approval_created'; approval: ApprovalSnapshot; message_id: string }
	| { type: 'approval_updated'; approval: ApprovalSnapshot }
	| { type: 'system'; body: string }
	| { type: 'pong' };
