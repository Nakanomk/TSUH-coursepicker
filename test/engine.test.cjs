'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, config, course, row, memoryStorage } = require('./helpers.cjs');
const { PickerError } = require('../src/core');
const { Engine } = require('../src/engine');
const { KEYS } = require('../src/config');
const { Store } = require('../src/storage');
const status = f => f.engine.state.statuses[f.cfg.targets[0].key].text;

test('unique name+teacher enrolls once and verifies actual server state', async () => {
    const f = fixture(); await f.engine.tick();
    assert.equal(f.writes().length, 1); assert.equal(f.engine.state.completed, true);
    assert.equal(f.store.pending(), null); await f.engine.tick(); assert.equal(f.writes().length, 1);
});
test('preview reads the target but never calls enrollment or writes a pending record', async () => {
    const f = fixture({ readOnly: true }); await f.engine.tick();
    assert.equal(f.writes().length, 0); assert.equal(f.store.pending(), null); assert.match(status(f), /只读.*未提交/);
});
test('existing desired selection completes without write, other teacher blocks', async () => {
    for (const [teacher, complete] of [['何云峰', true], ['张三', false]]) {
        const f = fixture({ rows: [row({ TYPE: '1', XM: teacher })] }); await f.engine.tick();
        assert.equal(f.writes().length, 0); assert.equal(f.engine.state.completed, complete);
    }
});
test('same teacher in two classes is ambiguous even when one is full', async () => {
    const f = fixture({ rows: [row({ KTBH: 'T1', KTRS: 80 }), row({ KTBH: 'T2' })] });
    await f.engine.tick(); assert.equal(f.writes().length, 0); assert.match(status(f), /匹配到 2/);
});
test('an explicit class pin resolves ambiguity', async () => {
    const f = fixture({ config: config({ targets: [{ name: '计算机图形学', teacher: '何云峰', classId: 'T2' }] }),
        rows: [row(), row({ KTBH: 'T2' })] });
    await f.engine.tick(); assert.equal(f.writes()[0][1].ktbh, 'T2'); assert.equal(f.engine.state.completed, true);
});
test('teacher disambiguates two same-name course plans', async () => {
    const rows1 = [row({ XM: '张三' })], rows2 = [row({ KTBH: 'T2' })];
    const f = fixture({ courses: [course(), course({ ID: 'P2', FZID: 'G2' })],
        rowsFor: c => c.ID === 'P1' ? rows1 : rows2,
        enroll: () => { rows2[0].TYPE = '1'; return { code: 0 }; } });
    await f.engine.tick(); assert.equal(f.writes().length, 1); assert.equal(f.writes()[0][1].faid, 'P2');
});
test('a selected class in another plan is not hidden by target pins', async () => {
    const f = fixture({ config: config({ targets: [{ name: '计算机图形学', teacher: '何云峰', planId: 'P2' }] }),
        courses: [course(), course({ ID: 'P2', FZID: 'G2' })],
        rowsFor: c => c.ID === 'P1' ? [row({ TYPE: '1', XM: '张三' })] : [row({ KTBH: 'T2' })] });
    await f.engine.tick(); assert.equal(f.writes().length, 0); assert.match(status(f), /不会自动退课/);
});
test('a full class is waited for, then submitted when capacity becomes available', async () => {
    const f = fixture({ rows: [row({ KTRS: 80 })] });
    await f.engine.tick(); assert.equal(f.writes().length, 0);
    f.rows[0].KTRS = 79; await f.engine.tick(); assert.equal(f.writes().length, 1);
});
test('accepted response without selected state remains pending and never repeats', async () => {
    const f = fixture({ enroll: () => ({ code: 0 }) });
    await f.engine.tick(); assert.ok(f.store.pending()); assert.equal(f.engine.state.completed, false);
    await f.engine.tick(); await f.engine.tick(); assert.equal(f.writes().length, 1);
    f.rows[0].TYPE = '1'; await f.engine.tick(); assert.equal(f.store.pending(), null); assert.equal(f.engine.state.completed, true);
});
test('network timeout after guard persists journal and switches to read-only reconciliation', async () => {
    const f = fixture({ enroll: () => { throw new PickerError('network', 'timeout'); } });
    await f.engine.tick(); assert.ok(f.store.pending()); assert.equal(f.engine.state.errors, 1);
    assert.equal(f.engine.delay(), 6000);
    await f.engine.tick(); await f.engine.tick(); assert.equal(f.writes().length, 1);
});
test('refresh with changed teacher or term still checks the original pending snapshot first', async () => {
    const f = fixture({ enroll: () => ({ code: 0 }) }); await f.engine.tick();
    const changed = new Engine({ api: f.api, journal: f.store,
        config: config({ term: '20262', targets: [{ name: '另一门课', teacher: '李四' }] }), readOnly: false });
    await changed.tick(); assert.equal(f.writes().length, 1); assert.ok(changed.state.pending);
    f.rows[0].TYPE = '1'; await changed.tick(); assert.equal(f.store.pending(), null);
    assert.equal(changed.state.completed, false); assert.equal(f.writes().length, 1);
});
test('one uncertain write prevents all later targets from being submitted', async () => {
    const f = fixture({ config: config({ targets: [{ name: '计算机图形学', teacher: '何云峰' }, { name: '操作系统', teacher: '李四' }] }),
        courses: [course(), course({ KCMC: '操作系统', KCBH: 'C2' })], enroll: () => ({ code: 0 }) });
    await f.engine.tick(); await f.engine.tick(); assert.equal(f.writes().length, 1);
});
test('an explicit nonzero business rejection clears pending and obeys cooldown', async () => {
    let now = 1000;
    const f = fixture({ now: () => now, enroll: () => ({ code: 1, msg: '课堂容量已满' }) });
    await f.engine.tick(); assert.equal(f.store.pending(), null); assert.equal(f.writes().length, 1);
    now = 15999; await f.engine.tick(); assert.equal(f.writes().length, 1);
    now = 16000; await f.engine.tick(); assert.equal(f.writes().length, 2);
});
test('malformed enrollment response never clears pending', async () => {
    const f = fixture({ enroll: () => ({ nope: true }) }); await f.engine.tick();
    assert.ok(f.store.pending()); assert.equal(f.engine.state.paused, true);
});
test('pause after a write does not pretend that the write was cancelled', async () => {
    const f = fixture({ enroll: () => { f.engine.pause(); return { code: 0 }; } });
    await f.engine.tick(); assert.equal(f.writes().length, 1); assert.ok(f.store.pending());
    await f.engine.tick(); assert.equal(f.writes().length, 1);
});
test('pause during a read prevents the later submission', async () => {
    const f = fixture(); const original = f.api.classes;
    f.api.classes = async c => { const rows = await original(c); f.engine.pause(); return rows; };
    await f.engine.tick(); assert.equal(f.writes().length, 0); assert.equal(f.store.pending(), null);
});
test('journal failure before send blocks the outgoing write', async () => {
    const storage = memoryStorage(); storage.setItem = () => { throw new Error('quota'); };
    const f = fixture({ storage }); await f.engine.tick();
    assert.equal(f.writes().length, 0); assert.equal(f.engine.state.paused, true);
});
test('legacy journal is verified and removed only after server confirmation', async () => {
    const storage = memoryStorage();
    storage.setItem(KEYS.legacyPending, JSON.stringify({ version: 1, name: '计算机图形学', course: course(), ktbh: 'T1', at: 100 }));
    const f = fixture({ storage, rows: [row({ TYPE: '1' })] });
    await f.engine.tick(); assert.equal(f.writes().length, 0); assert.equal(f.store.pending(), null);
    assert.equal(storage.getItem(KEYS.legacyPending), null);
});
test('corrupt pending is not discarded, and competing pending records block', () => {
    const storage = memoryStorage(), store = new Store(storage);
    storage.setItem(KEYS.pending, '{'); assert.throws(() => store.pending(), /损坏/);
    storage.setItem(KEYS.legacyPending, '{}'); assert.throws(() => store.pending(), /同时存在/);
});
test('compare-before-clear prevents removing a newer pending record', async () => {
    const f = fixture({ enroll: () => ({ code: 0 }) }); await f.engine.tick();
    const handle = f.store.pending(); f.storage.setItem(KEYS.pending, handle.raw + ' ');
    assert.throws(() => f.store.clearPending(handle), /已变化/); assert.ok(f.storage.getItem(KEYS.pending));
});
test('unknown TYPE aborts the round without a submission', async () => {
    const f = fixture({ rows: [row({ TYPE: '3' })] }); await f.engine.tick();
    assert.equal(f.writes().length, 0); assert.equal(f.engine.state.paused, true);
});
test('simultaneous tick calls cannot overlap', async () => {
    const f = fixture(); await Promise.all([f.engine.tick(), f.engine.tick(), f.engine.tick()]);
    assert.equal(f.writes().length, 1); assert.equal(f.engine.state.round, 1);
});
