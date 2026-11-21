// In-memory stand-in for @forge/kvs with the semantics Lease relies on:
// strictly consistent entity get, FAIL_IF_EXISTS, and transactions whose
// conditions are checked atomically. Every call yields to the event loop so
// concurrent callers really interleave.

const tick = () => new Promise((r) => setImmediate(r));

export function makeFakeKvs() {
  const entities = new Map(); // `${entity}/${key}` -> value
  const plain = new Map(); // key -> value
  const stats = { conflicts: 0, commits: 0 };

  class Filter {
    constructor() {
      this.clauses = [];
    }
    and(field, cond) {
      this.clauses.push({ field, cond });
      return this;
    }
  }
  const FilterConditions = {
    equalTo: (value) => ({ op: 'eq', value }),
    notExists: () => ({ op: 'notExists' }),
  };
  const WhereConditions = { beginsWith: (value) => ({ op: 'begins', value }) };

  const holds = (rec, filter) =>
    filter.clauses.every(({ field, cond }) =>
      cond.op === 'eq' ? rec && rec[field] === cond.value : cond.op === 'notExists' ? !rec || rec[field] === undefined : false
    );

  const kvs = {
    entity(name) {
      return {
        async get(key) {
          await tick();
          const v = entities.get(`${name}/${key}`);
          return v === undefined ? undefined : structuredClone(v);
        },
        async set(key, value, opts = {}) {
          await tick();
          const k = `${name}/${key}`;
          if (opts.keyPolicy === 'FAIL_IF_EXISTS' && entities.has(k)) {
            stats.conflicts++;
            throw new Error('KEY_ALREADY_EXISTS');
          }
          entities.set(k, structuredClone(value));
          stats.commits++;
        },
      };
    },
    transact() {
      const ops = [];
      const b = {
        set(key, value, opts) {
          ops.push({ key, value, opts });
          return b;
        },
        async execute() {
          await tick();
          // atomic: check all conditions, then apply all writes, with no await in between
          for (const op of ops) {
            const rec = entities.get(`${op.opts.entityName}/${op.key}`);
            if (op.opts.conditions && !holds(rec, op.opts.conditions)) {
              stats.conflicts++;
              throw new Error('CONDITION_CHECK_FAILED');
            }
          }
          for (const op of ops) entities.set(`${op.opts.entityName}/${op.key}`, structuredClone(op.value));
          stats.commits++;
        },
      };
      return b;
    },
    async get(key) {
      await tick();
      return plain.get(key);
    },
    async set(key, value) {
      await tick();
      plain.set(key, structuredClone(value));
    },
    query() {
      let prefix = '';
      let limit = 100;
      let cursor = 0;
      const q = {
        where(_f, c) {
          prefix = c.value;
          return q;
        },
        limit(n) {
          limit = n;
          return q;
        },
        cursor(c) {
          cursor = +c;
          return q;
        },
        async getMany() {
          await tick();
          const keys = [...plain.keys()].filter((k) => k.startsWith(prefix)).sort();
          const page = keys.slice(cursor, cursor + limit);
          const next = cursor + limit < keys.length ? String(cursor + limit) : undefined;
          return { results: page.map((key) => ({ key, value: plain.get(key) })), nextCursor: next };
        },
      };
      return q;
    },
  };
  return { kvs, Filter, FilterConditions, WhereConditions, stats, entities, plain };
}
