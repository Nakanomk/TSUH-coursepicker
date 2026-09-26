'use strict';
const { makeConfig } = require('../src/config');
const { Store } = require('../src/storage');
const { Engine } = require('../src/engine');
const config = overrides => makeConfig({ term: '20261', targets: [{ name: '计算机图形学', teacher: '何云峰' }], ...overrides });
const course = overrides => ({ KCMC: '计算机图形学', KCBH: 'C101', FZID: 'G1', ID: 'P1', XQH: '20261', XKGZ: '1', FAMC: '计算机类', ...overrides });
const row = overrides => ({ KTBH: 'T1', XQH: '20261', TYPE: '0', XM: '何云峰', KTRL: 80, KTRS: 70, ...overrides });
const details = c => ({ code: 0, fafzXx: { FAID: c.ID, FZID: c.FZID, XQH: c.XQH, XKGZ: c.XKGZ, FAMC: c.FAMC }, fzKcs: { KCMC: c.KCMC, KCBH: c.KCBH } });
function memoryStorage() {
    const map = new Map();
    return { map, getItem: key => map.has(key) ? map.get(key) : null,
        setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
}
function fixture(options = {}) {
    const cfg = options.config || config();
    const storage = options.storage || memoryStorage(), store = options.store || new Store(storage);
    const courses = options.courses || [course()], rows = options.rows || [row()];
    const calls = [];
    const api = {
        async courses() { calls.push(['courses']); return structuredClone(courses); },
        async details(c) { calls.push(['details', c.ID]); return details(c); },
        async classes(c) { calls.push(['classes', c.ID]); return structuredClone(options.rowsFor ? options.rowsFor(c) : rows); },
        async enroll(params, guard) {
            guard(); calls.push(['enroll', params]);
            if (options.enroll) return options.enroll(params, { store, rows, calls });
            rows.filter(r => r.KTBH === params.ktbh).forEach(r => { r.TYPE = '1'; });
            return { code: 0 };
        },
    };
    const engine = new Engine({ api, journal: store, config: cfg, readOnly: options.readOnly ?? false,
        now: options.now || (() => 1000) });
    return { cfg, storage, store, courses, rows, calls, api, engine, writes: () => calls.filter(c => c[0] === 'enroll') };
}
function locks() {
    const held = new Set();
    return { held, async request(name, options, action) {
        if (held.has(name)) return action(null);
        held.add(name);
        try { return await action({ name }); } finally { held.delete(name); }
    } };
}
const response = (data, status = 200) => ({ status, ok: status >= 200 && status < 300,
    text: async () => typeof data === 'string' ? data : JSON.stringify(data) });
module.exports = { config, course, row, details, memoryStorage, fixture, locks, response };
