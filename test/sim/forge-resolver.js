export default class Resolver {
  constructor() { this.defs = {}; }
  define(name, fn) { this.defs[name] = fn; }
  getDefinitions() { const defs = this.defs; return async (name, payload, context) => defs[name]({ payload, context }); }
}
