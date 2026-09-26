'use strict';
const { ORIGIN, DEFAULTS } = require('./config');
const { Store } = require('./storage');
const { RequestQueue, HustAPI } = require('./api');
const { Session } = require('./session');
const { mountPanel } = require('./ui');

function boot(win, doc) {
    if (win.top !== win.self || win.location.origin !== ORIGIN || !win.location.pathname.startsWith('/zyxxk/')) return;
    if (doc.getElementById('hust-course-picker-panel-v2')) return;
    let store, initial = DEFAULTS, pending = null, startupError = null;
    try {
        store = new Store(win.localStorage); initial = store.settings() || DEFAULTS; pending = store.pending();
        // Make an old pending record inspectable even on the first installation.
        if (pending && !initial.targets?.length) initial = { ...DEFAULTS, term: pending.record.term, targets: [pending.record.target] };
    } catch (error) { startupError = error; }
    const panel = mountPanel(doc, initial);
    if (startupError) { panel.fatal(`安全停止：${startupError.message}`); return; }
    if (doc.getElementById('hust-course-picker-panel')) { panel.fatal('检测到旧版面板：请停用旧脚本并刷新页面，再启动新版'); return; }
    if (!win.navigator.locks) { panel.fatal('浏览器不支持 Web Locks，未启动任何请求'); return; }
    panel.setPending(pending?.record);
    const queue = new RequestQueue({ fetchImpl: win.fetch.bind(win), origin: win.location.origin });
    const session = new Session({ locks: win.navigator.locks, store,
        apiFactory: (config, active) => new HustAPI({ queue, config, active }),
        onChange: panel.render, onLog: panel.log, onBusy: panel.setBusy });
    panel.bind({ save: config => session.save(config), run: (config, mode) => session.run(config, mode),
        pause: () => session.pause(),
        clear: async () => {
            const handle = store.pending(); if (!handle) { panel.setPending(null); return; }
            const r = handle.record;
            const answer = win.prompt(`请先在学校网站核对“已选课堂”，并确认此前提交不会再完成。\n${r.target.name} / ${r.target.teacher} / ${r.term} / ${r.ktbh}\n\n解除后可再次提交，输入“已核对”确认：`);
            if (answer !== '已核对') return;
            await session.acknowledgePending(handle.raw); panel.setPending(null);
            panel.notice('已人工解除待确认；当前未运行，下一次启动将允许再次提交');
        } });
    win.addEventListener('pagehide', () => session.dispose());
    win.addEventListener('pageshow', event => { if (event.persisted) panel.fatal('页面从缓存恢复，请刷新以重新取得安全锁'); });
    win.addEventListener('storage', event => {
        // No silent restart or config replacement. Another page's journal is only displayed.
        if (!session.running && event.key?.includes('pending')) {
            try { panel.setPending(store.pending()?.record); } catch (error) { panel.fatal(error.message); }
        }
    });
}
module.exports = { boot };
