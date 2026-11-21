import { makeFakeKvs } from '../fake-kvs.js';
const f = (globalThis.__kvs ||= makeFakeKvs());
export const Filter = f.Filter;
export const FilterConditions = f.FilterConditions;
export const WhereConditions = f.WhereConditions;
export const kvs = f.kvs;
export default f.kvs;
