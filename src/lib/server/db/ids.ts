/**
 * ID generation — single source of truth.
 *
 * See docs/decisions/0003-id-formats.md for the full format spec.
 * Short version: prefixed nanoid-12 in the URL-safe alphabet.
 *
 * Schema files and application code MUST import from here. Inline
 * string concatenation like `"c_" + nanoid()` is forbidden so we have
 * one place to enforce alphabet, length, and prefix consistency.
 */

import { customAlphabet } from 'nanoid';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-';
const LENGTH = 12;

const generate = customAlphabet(ALPHABET, LENGTH);

/**
 * Reserved prefixes (see ADR-0003 §"Reserved prefixes"). Adding a new
 * prefix is an ADR-level decision; do not invent prefixes here.
 */
export const PREFIXES = {
	agent: 'a_',
	channel: 'c_',
	message: 'm_',
	approval: 'ap_'
} as const satisfies Record<string, string>;

export type EntityKind = keyof typeof PREFIXES;

export function newId(kind: EntityKind): string {
	return `${PREFIXES[kind]}${generate()}`;
}

/**
 * Test/parse a string as a valid id of the given kind. Useful for
 * validation at API boundaries before queries run.
 */
export function isId(value: string, kind: EntityKind): boolean {
	const prefix = PREFIXES[kind];
	if (!value.startsWith(prefix)) return false;
	const body = value.slice(prefix.length);
	if (body.length !== LENGTH) return false;
	for (let i = 0; i < body.length; i++) {
		if (!ALPHABET.includes(body[i] as string)) return false;
	}
	return true;
}
