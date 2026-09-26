'use strict';
const { fail } = require('./core');
const { LOCK_NAMES, makeConfig } = require('./config');
const { Engine } = require('./engine');

async function withLocks(locks, action, names = LOCK_NAMES, index = 0) {
    if (!locks || typeof locks.request !== 'function') fail('safety', '浏览器不支持 Web Locks，未启动请求');
    if (index === names.length) return action();
    return locks.request(names[index], { ifAvailable: true }, lock => {
        if (!lock) fail('lock', '另一标签页或旧脚本正在运行；先暂停它，再从本页启动');
        return withLocks(locks, action, names, index + 1);
    });
}
class Session {
    constructor({ locks, store, apiFactory, onChange = () => {}, onLog = () => {}, onBusy = () => {} }) {
        this.locks = locks; this.store = store; this.apiFactory = apiFactory;
        this.onChange = onChange; this.onLog = onLog; this.onBusy = onBusy;
        this.running = false; this.disposed = false; this.stopRequested = false; this.engine = null; this.wake = null;
    }
    async exclusive(action) {
        if (this.disposed) fail('safety', '页面已离开或由缓存恢复，请刷新页面');
        if (this.running) fail('stopped', '当前操作尚未结束');
        this.running = true; this.stopRequested = false; this.onBusy(true);
        try { return await withLocks(this.locks, () => {
            if (this.disposed) fail('stopped', '页面已离开，停止操作');
            return action();
        }); }
        finally { this.running = false; this.onBusy(false); }
    }
    async save(raw) {
        const config = makeConfig(raw);
        await this.exclusive(() => this.store.saveSettings(config));
        this.onLog('配置已保存在当前浏览器；刷新后不会自动启动');
        return config;
    }
    async run(raw, mode = 'preview') {
        if (!['preview', 'auto'].includes(mode)) fail('config', '未知运行模式');
        const config = makeConfig(raw);
        return this.exclusive(async () => {
            if (this.stopRequested) return;
            this.store.saveSettings(config);
            const api = this.apiFactory(config, () => !this.disposed && !this.stopRequested && !this.engine?.state.paused);
            this.engine = new Engine({ api, journal: this.store, config, readOnly: mode === 'preview',
                onChange: this.onChange, onLog: this.onLog });
            do {
                await this.engine.tick();
                if (mode === 'preview' || this.engine.state.paused || this.engine.state.completed || this.disposed || this.stopRequested) break;
                await this.wait(this.engine.delay());
            } while (!this.disposed && !this.stopRequested && !this.engine.state.paused);
        });
    }
    wait(ms) {
        return new Promise(resolve => {
            const finish = () => { clearTimeout(timer); if (this.wake === finish) this.wake = null; resolve(); };
            const timer = setTimeout(finish, ms); this.wake = finish;
        });
    }
    pause() { this.stopRequested = true; this.engine?.pause(); this.wake?.(); }
    dispose() { this.disposed = true; this.pause(); }
    async acknowledgePending(expectedRaw) {
        await this.exclusive(() => {
            const current = this.store.pending();
            if (!current) return;
            if (current.raw !== expectedRaw) fail('safety', '待确认记录已变化，请重新人工核对');
            this.store.clearPending(current);
            this.onLog('用户已人工核对并解除待确认记录；下一次自动模式可以再次提交');
        });
    }
}
module.exports = { withLocks, Session };
