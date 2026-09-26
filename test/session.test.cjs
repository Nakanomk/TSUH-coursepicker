'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { locks, fixture } = require('./helpers.cjs');
const { withLocks, Session } = require('../src/session');
const { LOCK_NAMES } = require('../src/config');

test('Web Lock remains held throughout async work and excludes a second instance', async () => {
    const manager = locks(); let release;
    const task = withLocks(manager, () => new Promise(resolve => { release = resolve; }));
    await Promise.resolve();
    assert.equal(manager.held.size, 2);
    await assert.rejects(withLocks(manager, () => {}), { kind: 'lock' });
    release(); await task; assert.equal(manager.held.size, 0);
});
test('old-script lock also prevents a new-script session, releasing the outer lock', async () => {
    const manager = locks(); manager.held.add(LOCK_NAMES[1]);
    await assert.rejects(withLocks(manager, () => {}), { kind: 'lock' });
    assert.ok(!manager.held.has(LOCK_NAMES[0]));
});
test('missing lock support fails closed', async () => {
    await assert.rejects(withLocks(null, () => {}), { kind: 'safety' });
});
test('constructing a session performs no network requests; preview releases locks', async () => {
    const f = fixture(), manager = locks();
    const session = new Session({ locks: manager, store: f.store, apiFactory: () => f.api });
    assert.equal(f.calls.length, 0);
    await session.run(f.cfg, 'preview'); assert.equal(f.writes().length, 0);
    assert.equal(session.running, false); assert.equal(manager.held.size, 0);
});
test('auto session keeps polling after an empty course list', async () => {
    const f = fixture(); let scans = 0;
    const readCourses = f.api.courses.bind(f.api);
    f.api.courses = async () => ++scans === 1 ? [] : readCourses();
    const session = new Session({ locks: locks(), store: f.store, apiFactory: () => f.api });
    session.wait = async () => {};
    await session.run(f.cfg, 'auto');
    assert.equal(scans, 2); assert.equal(f.writes().length, 1);
    assert.equal(session.engine.state.paused, false); assert.equal(session.engine.state.completed, true);
});
test('new run resets completed state instead of carrying previous targets into a new run', async () => {
    const f = fixture(), session = new Session({ locks: locks(), store: f.store, apiFactory: () => f.api });
    await session.run(f.cfg, 'auto'); assert.equal(session.engine.state.completed, true);
    f.rows[0].TYPE = '0'; await session.run(f.cfg, 'auto'); assert.equal(f.writes().length, 2);
});
test('pause while waiting for locks cannot be lost before engine creation', async () => {
    const f = fixture(); const manager = locks(); const base = manager.request.bind(manager); let release;
    manager.request = async (...args) => { if (!release) await new Promise(resolve => { release = resolve; }); return base(...args); };
    const session = new Session({ locks: manager, store: f.store, apiFactory: () => f.api });
    const running = session.run(f.cfg, 'auto'); session.pause(); release(); await running;
    assert.equal(f.calls.length, 0); assert.equal(session.running, false);
});
test('manual pending clear cannot run while an auto session still holds a request', async () => {
    const f = fixture(); let release;
    f.api.courses = () => new Promise(resolve => { release = () => resolve(f.courses); });
    const session = new Session({ locks: locks(), store: f.store, apiFactory: () => f.api });
    const running = session.run(f.cfg, 'auto');
    await Promise.resolve(); await assert.rejects(session.acknowledgePending('x'), { kind: 'stopped' });
    session.pause(); release(); await running; assert.equal(f.writes().length, 0);
});
test('disposed session cannot restart or clear records', async () => {
    const f = fixture(), session = new Session({ locks: locks(), store: f.store, apiFactory: () => f.api });
    session.dispose(); await assert.rejects(session.run(f.cfg), { kind: 'safety' });
    assert.equal(f.calls.length, 0);
});
