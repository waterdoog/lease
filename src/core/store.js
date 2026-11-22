// Persistence for the lease board with optimistic concurrency.
//
// The whole set of active leases lives in ONE custom-entity record ("board")
// with a revision number. Every change reads the board (strictly consistent
// get), computes the new board with the pure functions in leases.js, and
// writes it back in a transaction that only commits if the revision is still
// the one it read. If another agent got there first, we re-read and decide
// again, so two agents can never both be granted overlapping paths.
//
// History (finished leases) and events (grants, denials, expiries) are
// append-only keys, so they need no coordination.

import { emptyBoard } from './leases.js';

export const BOARD_ENTITY = 'board';
export const BOARD_KEY = 'leases';
const MAX_ATTEMPTS = 8;

export class ConflictError extends Error {}

export function makeStore({ kvs, Filter, FilterConditions, WhereConditions, boardKey = BOARD_KEY, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const entity = () => kvs.entity(BOARD_ENTITY);

  async function readBoard() {
    const rec = await entity().get(boardKey);
    if (!rec) return emptyBoard();
    return { rev: rec.rev, leases: rec.leases || {} };
  }

  async function writeBoard(prev, next) {
    const value = { rev: prev.rev + 1, leases: next.leases, updatedAt: Date.now() };
    if (prev.rev === 0) {
      // First write ever: create the record only if nobody else just did.
      try {
        await entity().set(boardKey, value, { keyPolicy: 'FAIL_IF_EXISTS' });
      } catch (e) {
        throw new ConflictError(String(e && e.message));
      }
      return value;
    }
    try {
      await kvs
        .transact()
        .set(boardKey, value, {
          entityName: BOARD_ENTITY,
          conditions: new Filter().and('rev', FilterConditions.equalTo(prev.rev)),
        })
        .execute();
    } catch (e) {
      throw new ConflictError(String(e && e.message));
    }
    return value;
  }

  // mutate(board) -> { board, ...result }. Runs until it commits or gives up.
  async function update(mutate) {
    let lastErr;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const current = await readBoard();
      const result = mutate(current);
      const changed = result.board !== current && JSON.stringify(result.board.leases) !== JSON.stringify(current.leases);
      if (!changed) return { ...result, board: current, attempts: attempt + 1 };
      try {
        const saved = await writeBoard(current, result.board);
        return { ...result, board: { rev: saved.rev, leases: saved.leases }, attempts: attempt + 1 };
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
        lastErr = e;
        await sleep(20 + Math.floor(Math.random() * 60) * (attempt + 1));
      }
    }
    throw new Error(`The lease board is busy; try again in a moment. (${lastErr && lastErr.message})`);
  }

  // Keys sort ascending, so store the time inverted: newest records come first.
  const pad = (at) => String(9_999_999_999_999 - at).padStart(13, '0');

  async function logEvent(evt) {
    const at = evt.at || Date.now();
    const key = `evt:${pad(at)}:${Math.random().toString(36).slice(2, 8)}`;
    await kvs.set(key, { ...evt, at }, { ttl: { unit: 'DAYS', value: 30 } });
  }

  async function saveHistory(record) {
    const at = record.endedAt || Date.now();
    await kvs.set(`hist:${pad(at)}:${record.id}`, record, { ttl: { unit: 'DAYS', value: 90 } });
  }

  async function listPrefix(prefix, { since = 0, limit = 200 } = {}) {
    const out = [];
    let cursor;
    do {
      let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(Math.min(100, limit - out.length));
      if (cursor) q = q.cursor(cursor);
      const page = await q.getMany();
      for (const r of page.results || []) out.push(r.value);
      cursor = page.nextCursor;
    } while (cursor && out.length < limit);
    return out.filter((v) => (v.at || v.endedAt || 0) >= since); // newest first
  }

  async function getPolicy(projectKey) {
    return (await kvs.get(`policy:${projectKey}`)) || null;
  }
  async function setPolicy(projectKey, policy) {
    await kvs.set(`policy:${projectKey}`, policy);
  }

  const clear = () => entity().delete(boardKey);

  return { readBoard, update, clear, logEvent, saveHistory, listPrefix, getPolicy, setPolicy };
}
