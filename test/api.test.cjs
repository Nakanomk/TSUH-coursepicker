'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { config, response, course } = require('./helpers.cjs');
const { RequestQueue, HustAPI, ENDPOINTS } = require('../src/api');
const { ORIGIN } = require('../src/config');
function apiFor(results, cfg = config()) {
    const calls = []; let time = 0;
    const queue = new RequestQueue({ fetchImpl: async (url, options) => {
        calls.push({ url, options }); if (!results.length) throw new Error('unexpected request');
        return response(results.shift());
    }, now: () => time, wait: async delay => { time += delay; } });
    return { api: new HustAPI({ queue, config: cfg }), calls, queue };
}
test('request queue serializes simultaneous callers and applies one global gap', async () => {
    let time = 0, inFlight = 0, maxInFlight = 0; const starts = [];
    const queue = new RequestQueue({ now: () => time, wait: async ms => { time += ms; },
        fetchImpl: async () => {
            inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); starts.push(time);
            await new Promise(resolve => setImmediate(resolve)); inFlight--; return response({ code: 0 });
        } });
    await Promise.all(Array.from({ length: 5 }, () => queue.request(ENDPOINTS.details, {}, config(), () => true)));
    assert.equal(maxInFlight, 1); assert.deepEqual(starts, [0, 500, 1000, 1500, 2000]);
});
test('a queued request rechecks pause before its guard and fetch', async () => {
    let active = true, fetched = 0, guarded = 0, time = 0;
    const queue = new RequestQueue({ now: () => time, wait: async ms => { time += ms; active = false; },
        fetchImpl: async () => { fetched++; return response({ code: 0 }); } });
    await queue.request(ENDPOINTS.details, {}, config(), () => active);
    await assert.rejects(queue.request(ENDPOINTS.enroll, {}, config(), () => active, () => guarded++), { kind: 'stopped' });
    assert.equal(fetched, 1); assert.equal(guarded, 0);
});
test('only the configured origin and whitelisted endpoints are allowed', async () => {
    assert.throws(() => new RequestQueue({ origin: 'https://elsewhere.invalid', fetchImpl: () => {} }), /站点/);
    const f = apiFor([]);
    await assert.rejects(f.queue.request('/zyxxk/dropCourse', {}, config(), () => true), { kind: 'safety' });
    await assert.rejects(f.queue.request(ENDPOINTS.enroll, {}, config(), () => true), { kind: 'safety' });
    assert.equal(f.calls.length, 0);
});
test('adapter preserves original GET enrollment parameters and same-origin credentials', async () => {
    const f = apiFor([{ code: 0 }]); let guarded = false;
    await f.api.enroll({ ktbh: 'T1', xqh: '20261', kcbh: 'C101', faid: 'P1', fzid: 'G1', sfid: '' }, () => { guarded = true; });
    assert.ok(guarded); const { url, options } = f.calls[0]; const parsed = new URL(url);
    assert.equal(parsed.origin, ORIGIN); assert.equal(parsed.pathname, ENDPOINTS.enroll);
    assert.equal(parsed.searchParams.get('ktbh'), 'T1'); assert.equal(parsed.searchParams.get('sfid'), '');
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
});
test('course and class lists use POST form parameters from the old script', async () => {
    const f = apiFor([{ code: 0, count: 0, data: [] }, { code: 0, count: 0, data: [] }]);
    await f.api.courses(); await f.api.classes(course());
    assert.equal(f.calls[0].options.method, 'POST');
    assert.equal(new URLSearchParams(f.calls[0].options.body).get('xkgz'), '1');
    const params = new URLSearchParams(f.calls[1].options.body);
    assert.equal(params.get('faid'), 'P1'); assert.equal(params.get('id'), 'P1'); assert.equal(params.get('fzid'), 'G1');
});
test('pagination continues across short pages when a positive count promises more', async () => {
    const f = apiFor([{ code: 0, count: 3, data: [{ a: 1 }] }, { code: 0, count: 3, data: [{ a: 2 }, { a: 3 }] }]);
    assert.equal((await f.api.courses()).length, 3); assert.equal(f.calls.length, 2);
});
test('count=0 with a short nonempty page works as the legacy convention', async () => {
    const f = apiFor([{ code: 0, count: 0, data: [{ a: 1 }] }]);
    assert.equal((await f.api.courses()).length, 1);
});
test('count=0 with a full page is not assumed complete', async () => {
    const f = apiFor([{ code: 0, count: 0, data: [{ a: 1 }, { a: 2 }] }, { code: 0, count: 0, data: [{ a: 3 }] }], config({ pageSize: 2 }));
    assert.equal((await f.api.courses()).length, 3); assert.equal(f.calls.length, 2);
});
test('reordered duplicate pages are detected', async () => {
    const f = apiFor([{ code: 0, data: [{ a: 1 }, { a: 2 }] }, { code: 0, data: [{ a: 2 }, { a: 1 }] }], config({ pageSize: 2 }));
    await assert.rejects(f.api.courses(), /分页重复/);
});
test('changed count, premature end, excessive rows and invalid count fail closed', async () => {
    const cases = [
        [{ code: 0, count: 3, data: [1] }, { code: 0, count: 4, data: [2] }],
        [{ code: 0, count: 3, data: [1] }, { code: 0, count: 3, data: [] }],
        [{ code: 0, count: 1, data: [1, 2] }],
        [{ code: 0, count: '', data: [] }],
        [{ code: 0, count: -1, data: [] }],
    ];
    for (const values of cases) await assert.rejects(apiFor(values).api.courses(), { kind: 'schema' });
});
test('HTML login page, 429 and malformed JSON classify separately', async () => {
    for (const [data, status, kind] of [['<html>login</html>', 200, 'auth'], [{ code: 1 }, 429, 'rate'], ['{', 200, 'schema']]) {
        const queue = new RequestQueue({ fetchImpl: async () => response(data, status) });
        await assert.rejects(queue.request(ENDPOINTS.details, {}, config(), () => true), { kind });
    }
});
test('a failed request does not poison the shared queue', async () => {
    let n = 0;
    const queue = new RequestQueue({ wait: async () => {}, fetchImpl: async () => {
        if (!n++) throw new Error('offline'); return response({ code: 0 });
    } });
    await assert.rejects(queue.request(ENDPOINTS.details, {}, config(), () => true), { kind: 'network' });
    assert.equal((await queue.request(ENDPOINTS.details, {}, config(), () => true)).code, 0);
});
