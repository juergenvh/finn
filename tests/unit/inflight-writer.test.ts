/**
 * InflightWriter unit tests (issue #112).
 *
 * Exercises the lifecycle of one writer end-to-end against a real
 * SQLite file in a tmp dir (better-sqlite3 doesn't accept `:memory:`
 * cleanly with our drizzle wiring + WAL pragma, so we use a tempfile
 * and clean it up per-test).
 *
 * Throttling is tested by injecting a manual clock + verifying
 * `flushNow()` directly. The setTimeout-driven path is exercised
 * with `vi.useFakeTimers()` so we don't sleep in real wall-clock
 * time.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb } from '../../src/lib/server/db/client';
import { inflightMessages, channels, agents } from '../../src/lib/server/db/schema';
import { InflightWriter, sweepStaleInflightOnBoot } from '../../src/lib/server/inflight-writer';

const CHANNEL_ID = 'channel-test';
const AGENT_ID = 'agent-test';

let dbDir: string;
let dbFile: string;

beforeEach(async () => {
	// Per-test on-disk database. Cheap (a few KB), guaranteed
	// isolation, no shared cache leaks between tests.
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finn-test-'));
	dbFile = path.join(dbDir, 'finn.db');
	process.env.FINN_DB_PATH = dbFile;

	// Apply migrations against the fresh DB.
	const Database = (await import('better-sqlite3')).default;
	const { drizzle } = await import('drizzle-orm/better-sqlite3');
	const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
	const sqlite = new Database(dbFile);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON');
	const tmpDb = drizzle(sqlite);
	migrate(tmpDb, { migrationsFolder: './drizzle' });
	sqlite.close();

	// Seed the FK dependencies. Channel and agent rows have to
	// exist or the inflight insert hits the FK constraint.
	const db = getDb();
	db.insert(channels).values({
		id: CHANNEL_ID,
		name: 'Test channel',
		description: null,
		createdAt: 1000,
		deletedAt: null
	}).run();
	db.insert(agents).values({
		id: AGENT_ID,
		name: 'Test agent',
		connectorType: 'anthropic-stub',
		config: '{}',
		enabled: true,
		createdAt: 1000,
		deletedAt: null
	}).run();
});

afterEach(() => {
	closeDb();
	delete process.env.FINN_DB_PATH;
	fs.rmSync(dbDir, { recursive: true, force: true });
});

describe('InflightWriter lifecycle', () => {
	it('start() inserts an empty row', () => {
		const w = new InflightWriter('msg-1', CHANNEL_ID, AGENT_ID, 5000, { now: () => 5001 });
		w.start();

		const row = getDb()
			.select()
			.from(inflightMessages)
			.where(eq(inflightMessages.id, 'msg-1'))
			.get();
		expect(row).toBeDefined();
		expect(row!.body).toBe('');
		expect(row!.status).toBe('streaming');
		expect(row!.errorMessage).toBeNull();
		expect(row!.createdAt).toBe(5000);
		expect(row!.updatedAt).toBe(5001);
	});

	it('flushNow() writes the buffer to the row', () => {
		const w = new InflightWriter('msg-2', CHANNEL_ID, AGENT_ID, 5000, {
			flushMs: 999_999, // throttle effectively disabled
			now: () => 6000
		});
		w.start();
		w.appendDelta('hel');
		w.appendDelta('lo');
		w.flushNow();

		const row = getDb()
			.select()
			.from(inflightMessages)
			.where(eq(inflightMessages.id, 'msg-2'))
			.get();
		expect(row!.body).toBe('hello');
		expect(row!.updatedAt).toBe(6000);
	});

	it('finalizeOk() deletes the row', () => {
		const w = new InflightWriter('msg-3', CHANNEL_ID, AGENT_ID, 5000);
		w.start();
		w.appendDelta('partial');
		w.finalizeOk();

		const row = getDb()
			.select()
			.from(inflightMessages)
			.where(eq(inflightMessages.id, 'msg-3'))
			.get();
		expect(row).toBeUndefined();
	});

	it('finalizeError() updates the row to status=error and persists the buffer', () => {
		const w = new InflightWriter('msg-4', CHANNEL_ID, AGENT_ID, 5000, { now: () => 7000 });
		w.start();
		w.appendDelta('half-written');
		w.finalizeError('upstream connection closed');

		const row = getDb()
			.select()
			.from(inflightMessages)
			.where(eq(inflightMessages.id, 'msg-4'))
			.get();
		expect(row).toBeDefined();
		expect(row!.body).toBe('half-written');
		expect(row!.status).toBe('error');
		expect(row!.errorMessage).toBe('upstream connection closed');
		expect(row!.updatedAt).toBe(7000);
	});

	it('appendDelta after finalize is a no-op (no late writes)', () => {
		const w = new InflightWriter('msg-5', CHANNEL_ID, AGENT_ID, 5000);
		w.start();
		w.appendDelta('first');
		w.finalizeOk();
		w.appendDelta('after-finalize');
		w.flushNow();

		const row = getDb()
			.select()
			.from(inflightMessages)
			.where(eq(inflightMessages.id, 'msg-5'))
			.get();
		expect(row).toBeUndefined(); // still gone; no zombie insert
	});
});

describe('InflightWriter throttling', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('the first delta schedules a flush ~flushMs later', () => {
		const w = new InflightWriter('msg-6', CHANNEL_ID, AGENT_ID, 5000, {
			flushMs: 500,
			now: () => 8000
		});
		w.start();
		w.appendDelta('hello');

		// Before the timer: the row still has the start-state body.
		let row = getDb()
			.select()
			.from(inflightMessages)
			.where(eq(inflightMessages.id, 'msg-6'))
			.get();
		expect(row!.body).toBe('');

		// Advance past the throttle window: flush happens.
		vi.advanceTimersByTime(600);
		row = getDb()
			.select()
			.from(inflightMessages)
			.where(eq(inflightMessages.id, 'msg-6'))
			.get();
		expect(row!.body).toBe('hello');
	});

	it('multiple deltas inside the throttle window coalesce into one write', () => {
		const w = new InflightWriter('msg-7', CHANNEL_ID, AGENT_ID, 5000, {
			flushMs: 500
		});
		w.start();

		w.appendDelta('a');
		vi.advanceTimersByTime(100);
		w.appendDelta('b');
		vi.advanceTimersByTime(100);
		w.appendDelta('c');
		vi.advanceTimersByTime(400); // total 600 > 500
		const row = getDb()
			.select()
			.from(inflightMessages)
			.where(eq(inflightMessages.id, 'msg-7'))
			.get();
		expect(row!.body).toBe('abc');
	});

	it('finalizeOk cancels a pending throttled flush', () => {
		const w = new InflightWriter('msg-8', CHANNEL_ID, AGENT_ID, 5000, {
			flushMs: 500
		});
		w.start();
		w.appendDelta('about-to-be-deleted');
		// Timer queued but not yet fired:
		w.finalizeOk();
		// Even if the timer was scheduled, it must not run anything
		// against a row we just deleted.
		vi.advanceTimersByTime(1000);

		const row = getDb()
			.select()
			.from(inflightMessages)
			.where(eq(inflightMessages.id, 'msg-8'))
			.get();
		expect(row).toBeUndefined();
	});
});

describe('sweepStaleInflightOnBoot', () => {
	it('marks streaming rows from a previous run as interrupted_by_restart', () => {
		// Simulate "previous process wrote some rows then crashed":
		// they're left as `streaming`.
		const db = getDb();
		db.insert(inflightMessages).values([
			{
				id: 'stale-1',
				channelId: CHANNEL_ID,
				agentId: AGENT_ID,
				body: 'half',
				status: 'streaming',
				errorMessage: null,
				createdAt: 1000,
				updatedAt: 1000
			},
			{
				id: 'stale-2',
				channelId: CHANNEL_ID,
				agentId: AGENT_ID,
				body: '',
				status: 'streaming',
				errorMessage: null,
				createdAt: 1100,
				updatedAt: 1100
			}
		]).run();

		sweepStaleInflightOnBoot();

		const rows = db
			.select()
			.from(inflightMessages)
			.where(eq(inflightMessages.channelId, CHANNEL_ID))
			.all();
		expect(rows.length).toBe(2);
		for (const r of rows) {
			expect(r.status).toBe('error');
			expect(r.errorMessage).toBe('interrupted_by_restart');
		}
	});

	it('does not touch rows already marked as error', () => {
		const db = getDb();
		db.insert(inflightMessages).values({
			id: 'already-errored',
			channelId: CHANNEL_ID,
			agentId: AGENT_ID,
			body: 'partial',
			status: 'error',
			errorMessage: 'original_error',
			createdAt: 1000,
			updatedAt: 1000
		}).run();

		sweepStaleInflightOnBoot();

		const row = db
			.select()
			.from(inflightMessages)
			.where(eq(inflightMessages.id, 'already-errored'))
			.get();
		expect(row!.status).toBe('error');
		expect(row!.errorMessage).toBe('original_error'); // preserved
	});
});
