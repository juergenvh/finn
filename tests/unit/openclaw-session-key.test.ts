/**
 * Unit tests for the OpenClaw connector's session-key derivation.
 *
 * Covers all three shapes from ADR-0012 + ADR-0017:
 *   - default-agent, no override (ADR-0002 shape)            → `finn:<channel_id>`
 *   - explicit agent, no override (ADR-0012 shape)           → `agent:<agentId>:finn:<channel_id>`
 *   - explicit agent + override (ADR-0017 shape)             → `agent:<agentId>:<override>`
 *
 * Plus the rejection case from ADR-0017:
 *   - default agent + override                               → throws
 *
 * And the model-parsing helper (`explicitAgentIdFromModel`)
 * exhaustively, because both ADRs hang off correct agent-id
 * extraction from the `model` field.
 *
 * The functions under test are exported as `@internal` from
 * the connector module — they are not part of finn's runtime
 * public API, but they ARE the canonical place to lock the
 * session-key contract.
 */

import { describe, it, expect } from 'vitest';
import {
	__test__explicitAgentIdFromModel as explicitAgentIdFromModel,
	__test__sessionKeyFor as sessionKeyFor
} from '../../src/lib/server/connectors/openclaw.ts';

describe('explicitAgentIdFromModel', () => {
	it('returns null for the bare default forms', () => {
		expect(explicitAgentIdFromModel('openclaw')).toBeNull();
		expect(explicitAgentIdFromModel('openclaw/default')).toBeNull();
	});

	it('returns null for empty / whitespace input', () => {
		expect(explicitAgentIdFromModel('')).toBeNull();
		expect(explicitAgentIdFromModel('   ')).toBeNull();
	});

	it('extracts the agent id from openclaw/<id>', () => {
		expect(explicitAgentIdFromModel('openclaw/dixie')).toBe('dixie');
		expect(explicitAgentIdFromModel('openclaw/gwen')).toBe('gwen');
	});

	it('extracts the agent id from the openclaw:<id> alias', () => {
		expect(explicitAgentIdFromModel('openclaw:dixie')).toBe('dixie');
	});

	it('extracts the agent id from the agent:<id> alias', () => {
		expect(explicitAgentIdFromModel('agent:dixie')).toBe('dixie');
	});

	it('treats agent:default as null (the gateway resolves the default)', () => {
		// Lower-case the model field before matching is the contract.
		expect(explicitAgentIdFromModel('openclaw/default')).toBeNull();
		expect(explicitAgentIdFromModel('openclaw:default')).toBeNull();
		expect(explicitAgentIdFromModel('agent:default')).toBeNull();
	});

	it('returns null for unrecognised model strings', () => {
		expect(explicitAgentIdFromModel('gpt-4')).toBeNull();
		expect(explicitAgentIdFromModel('openclaw/dixie/extra')).toBeNull();
		expect(explicitAgentIdFromModel('openclaw//empty-after-slash')).toBeNull();
	});

	it('respects the agent-id character set (alnum + dash + underscore, 64 chars max)', () => {
		expect(explicitAgentIdFromModel('openclaw/dixie-finn')).toBe('dixie-finn');
		expect(explicitAgentIdFromModel('openclaw/dixie_finn')).toBe('dixie_finn');
		// Disallowed characters → null
		expect(explicitAgentIdFromModel('openclaw/dixie.finn')).toBeNull();
		expect(explicitAgentIdFromModel('openclaw/dixie finn')).toBeNull();
	});
});

describe('sessionKeyFor', () => {
	describe('without session_override (ADR-0012 shapes preserved)', () => {
		it('default-agent → finn:<channel_id> (ADR-0002 shape)', () => {
			expect(sessionKeyFor(null, 'c_w-fq8qo7f1xx')).toBe('finn:c_w-fq8qo7f1xx');
		});

		it('explicit-agent → agent:<agentId>:finn:<channel_id> (ADR-0012 shape)', () => {
			expect(sessionKeyFor('dixie', 'c_w-fq8qo7f1xx')).toBe('agent:dixie:finn:c_w-fq8qo7f1xx');
			expect(sessionKeyFor('gwen', 'c_abc')).toBe('agent:gwen:finn:c_abc');
		});
	});

	describe('with session_override (ADR-0017 shape)', () => {
		it('explicit-agent + override → agent:<agentId>:<override> (channel dropped)', () => {
			expect(sessionKeyFor('dixie', 'c_anything', 'finn')).toBe('agent:dixie:finn');
			expect(sessionKeyFor('dixie', 'c_anything', 'sagesmith')).toBe('agent:dixie:sagesmith');
			expect(sessionKeyFor('dixie', 'c_anything', 'main')).toBe('agent:dixie:main');
		});

		it('override value does not interpolate the channel id', () => {
			// The override is a flat session-key suffix. Even if the
			// channel id happens to look "compositional", we don't
			// build a longer key.
			const key = sessionKeyFor('dixie', 'c_w-fq8qo7f1xx', 'finn');
			expect(key).toBe('agent:dixie:finn');
			expect(key).not.toContain('c_w-fq8qo7f1xx');
		});
	});

	describe('default-agent + override is rejected (ADR-0017)', () => {
		it('throws when explicitAgentId is null and an override is provided', () => {
			expect(() => sessionKeyFor(null, 'c_w-fq8qo7f1xx', 'finn')).toThrow(
				/session_override requires an explicit agent/i
			);
		});

		it('error message references ADR-0017', () => {
			expect(() => sessionKeyFor(null, 'c_x', 'sagesmith')).toThrow(/ADR-0017/);
		});

		it('empty-string override is treated as absent (no throw on default agent)', () => {
			// Belt-and-suspenders: the Zod schema rejects empty
			// overrides at config-load time (min(1)), but the
			// connector also tolerates undefined / "" defensively.
			expect(() => sessionKeyFor(null, 'c_x', '')).not.toThrow();
			expect(sessionKeyFor(null, 'c_x', '')).toBe('finn:c_x');
		});
	});
});
