'use strict';
const { message } = require('./core');
const { DEFAULTS, emptyTarget, makeConfig } = require('./config');

// DOM only. This module knows neither endpoint URLs nor enrollment state transitions.
// All user/server strings go through textContent or input.value, never innerHTML.
function mountPanel(doc, initial) {
    const host = doc.createElement('div'); host.id = 'hust-course-picker-panel-v2';
    const root = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = `
:host{all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;width:min(440px,calc(100vw - 24px));font:13px/1.5 system-ui,-apple-system,sans-serif;color:#222;color-scheme:light}
*{box-sizing:border-box}.panel{background:#fff;border:1px solid #d6d6d6;border-radius:12px;box-shadow:0 5px 26px #0002;overflow:hidden}
header{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid #e6e6e6}h2{font-size:15px;margin:0;font-weight:650}.body{padding:14px 16px;max-height:calc(100vh - 100px);overflow:auto}
p{margin:6px 0}.muted{font-size:12px;color:#666}.headline{background:#f5f5f5;border-radius:6px;padding:9px 10px;margin:0 0 12px;overflow-wrap:anywhere}
label{display:block;font-size:12px;color:#555;margin:5px 0}input,textarea{display:block;width:100%;border:1px solid #ccc;border-radius:5px;background:#fff;color:#222;padding:7px 8px;font-family:inherit;font-size:13px;line-height:1.4;margin-top:3px}
input:focus,textarea:focus{outline:2px solid #888;outline-offset:1px}textarea{resize:vertical}button{padding:6px 10px;border:1px solid #bbb;border-radius:5px;background:#fafafa;color:#222;font:12px/1.4 system-ui,sans-serif;cursor:pointer}button:hover{background:#eee}button.primary{background:#222;color:#fff;border-color:#222}button:disabled,input:disabled,textarea:disabled{opacity:.5;cursor:default}.actions{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0 5px}
.row{border-top:1px solid #e4e4e4;padding:10px 0}.rowhead{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:#666}.fields{display:grid;grid-template-columns:1.4fr 1fr;gap:8px}.pins{display:grid;grid-template-columns:1fr 1fr;gap:8px}.target-status{font-size:12px;overflow-wrap:anywhere;margin:7px 0 0}.options{font-size:12px;margin-top:6px}.option{border-left:2px solid #ddd;padding:5px 0 5px 8px;margin:6px 0;overflow-wrap:anywhere}.option button{margin-top:4px}summary{cursor:pointer;font-size:12px;color:#555;padding:5px 0}details{margin:3px 0}.alert{border:1px solid #c5a99c;background:#faf5f1;padding:9px;border-radius:6px;font-size:12px;overflow-wrap:anywhere}.alert button{margin-top:8px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto;font:11px/1.55 ui-monospace,monospace;background:#f7f7f7;padding:8px;border-radius:5px}.meta{font-size:11px;color:#777;margin-top:8px}[hidden]{display:none!important}
`;
    root.append(style);
    const make = (tag, parent, text = '', cls = '') => {
        const node = doc.createElement(tag); if (text) node.textContent = text;
        if (cls) node.className = cls; parent.append(node); return node;
    };
    const panel = make('section', root, '', 'panel');
    const header = make('header', panel); make('h2', header, '华科 · 通用选课助手');
    const fold = make('button', header, '收起'); fold.type = 'button';
    const body = make('div', panel, '', 'body');
    fold.onclick = () => { body.hidden = !body.hidden; fold.textContent = body.hidden ? '展开' : '收起'; };
    const headline = make('div', body, '尚未启动 · 建议先做一次只读检查', 'headline'); headline.setAttribute('aria-live', 'polite');
    make('p', body, '仅支持原脚本的先排后选流程。课程、教师均精确匹配；不退课、不自动换老师。', 'muted');
    const controls = new Set();
    const field = (parent, label, value = '', placeholder = '') => {
        const wrap = make('label', parent, label), input = make('input', wrap);
        input.value = value; input.placeholder = placeholder; input.autocomplete = 'off'; controls.add(input); return input;
    };
    const term = field(body, '学期编号（必填，请从学校系统核对）', initial.term || '', '例如：20261；不要把示例当作当前学期');
    const list = make('div', body);
    const rows = [];
    let busy = false, fatal = false, handlers = {}, hasPending = false;
    const refreshNumbering = () => rows.forEach((row, i) => { row.title.textContent = `课程 ${i + 1}`; });
    function appendTarget(value = emptyTarget()) {
        const element = make('div', list, '', 'row'), head = make('div', element, '', 'rowhead');
        const title = make('span', head), remove = make('button', head, '移除'); controls.add(remove);
        const fields = make('div', element, '', 'fields');
        const name = field(fields, '课程名称', value.name || '', '课程完整名称');
        const teacher = field(fields, '教师姓名', value.teacher || '', '教师全名');
        const advanced = make('details', element); make('summary', advanced, '可选：限定课程号 / 课堂号 / 方案');
        const pins = make('div', advanced, '', 'pins');
        const courseId = field(pins, '课程号 KCBH', value.courseId || '');
        const classId = field(pins, '课堂号 KTBH', value.classId || '');
        const planId = field(pins, '方案号 FAID', value.planId || '');
        const groupId = field(pins, '分组号 FZID', value.groupId || '');
        if ([value.courseId, value.classId, value.planId, value.groupId].some(Boolean)) advanced.open = true;
        const status = make('div', element, '等待检查', 'target-status');
        const options = make('details', element, '', 'options'); options.hidden = true;
        const summary = make('summary', options, '服务器返回的候选课堂');
        const optionList = make('div', options);
        const row = { element, title, name, teacher, courseId, classId, planId, groupId, status, options, summary, optionList, advanced,
            optionSignature: '', optionButtons: [], remove };
        rows.push(row); refreshNumbering();
        remove.onclick = () => {
            if (busy || fatal || hasPending) return;
            [name, teacher, courseId, classId, planId, groupId, remove].forEach(c => controls.delete(c));
            rows.splice(rows.indexOf(row), 1); element.remove(); refreshNumbering();
        };
    }
    (initial.targets?.length ? initial.targets : [emptyTarget()]).forEach(appendTarget);
    const add = make('button', body, '+ 添加课程'); controls.add(add);
    add.onclick = () => { if (!busy && !fatal && !hasPending && rows.length < 20) appendTarget(); };
    const advanced = make('details', body); make('summary', advanced, '高级设置 · 扫描间隔与禁选名单');
    const interval = field(advanced, '每轮结束后的等待时间（秒）', String((initial.scanIntervalMs ?? DEFAULTS.scanIntervalMs) / 1000));
    interval.type = 'number'; interval.min = '1.5'; interval.max = '300'; interval.step = '.5';
    const gap = field(advanced, '请求之间的最小间隔（毫秒）', String(initial.minRequestGapMs ?? DEFAULTS.minRequestGapMs));
    gap.type = 'number'; gap.min = '250'; gap.step = '50';
    const cooldown = field(advanced, '明确拒绝后的重试间隔（秒）', String((initial.submitCooldownMs ?? DEFAULTS.submitCooldownMs) / 1000));
    cooldown.type = 'number'; cooldown.min = '5';
    const denyKeywords = field(advanced, '禁选关键词（逗号分隔；默认保留原脚本限制，可修改）', (initial.denyKeywords ?? DEFAULTS.denyKeywords).join(', '));
    const denyCodes = field(advanced, '禁选课程号（逗号分隔）', (initial.denyCodes ?? DEFAULTS.denyCodes).join(', '));
    make('p', advanced, '设置只保存到本站的浏览器本地存储。不保存密码，不提供验证码或权限绕过。', 'muted');
    const actions = make('div', body, '', 'actions');
    const save = make('button', actions, '保存配置'), preview = make('button', actions, '只读检查');
    const auto = make('button', actions, '开始自动选课', 'primary'), pause = make('button', actions, '暂停');
    const pendingBox = make('div', body, '', 'alert'); pendingBox.hidden = true;
    const pendingText = make('div', pendingBox), clear = make('button', pendingBox, '已人工核对，解除待确认');
    make('p', body, '先停用旧脚本并刷新页面。刷新后需要重新点击启动；运行时保持登录，不要切换账号或同时手动提交。', 'muted');
    const meta = make('div', body, '未发送请求', 'meta');
    const logs = make('details', body); make('summary', logs, '运行日志'); const logText = make('pre', logs);
    const logLines = [];
    function setEnabled() {
        controls.forEach(input => { input.disabled = busy || fatal || hasPending; });
        save.disabled = busy || fatal || hasPending; preview.disabled = busy || fatal;
        auto.disabled = busy || fatal; pause.disabled = !busy || fatal;
        clear.disabled = busy || fatal;
        rows.forEach(row => row.optionButtons.forEach(button => { button.disabled = busy || fatal || hasPending; }));
    }
    function read() {
        const split = input => input.value.split(/[,，;；\n]+/u).map(s => s.trim()).filter(Boolean);
        return { ...DEFAULTS, ...initial, term: term.value.trim(),
            targets: rows.map(row => Object.fromEntries(['name', 'teacher', 'courseId', 'classId', 'planId', 'groupId'].map(key => [key, row[key].value]))),
            scanIntervalMs: Number(interval.value) * 1000, minRequestGapMs: Number(gap.value),
            submitCooldownMs: Number(cooldown.value) * 1000, denyKeywords: split(denyKeywords), denyCodes: split(denyCodes) };
    }
    function log(text) {
        logLines.push(`${new Date().toLocaleTimeString()}  ${message(text)}`);
        if (logLines.length > 80) logLines.shift(); logText.textContent = logLines.join('\n');
    }
    function showError(error) { headline.textContent = message(error?.message || error); log(headline.textContent); }
    function invoke(fn) { Promise.resolve().then(fn).catch(showError); }
    save.onclick = () => invoke(async () => { await handlers.save(read()); headline.textContent = '配置已保存；未启动选课'; });
    preview.onclick = () => invoke(() => handlers.run(read(), 'preview'));
    auto.onclick = () => invoke(async () => {
        const config = makeConfig(read());
        const text = config.targets.map(t => `${t.name} · ${t.teacher}${t.classId ? ` · 课堂 ${t.classId}` : ''}`).join('\n');
        if (doc.defaultView.confirm(`即将自动提交选课。\n学期：${config.term}\n${text}\n\n请先核对只读检查结果，并停用旧脚本。确定启动？`)) await handlers.run(config, 'auto');
    });
    pause.onclick = () => handlers.pause();
    clear.onclick = () => invoke(() => handlers.clear());
    function renderOptions(row, options) {
        const signature = JSON.stringify(options);
        if (row.optionSignature === signature) return;
        row.optionSignature = signature; row.optionList.replaceChildren(); row.optionButtons = [];
        row.options.hidden = !options.length; row.summary.textContent = `服务器返回的候选课堂（${options.length}）`;
        options.forEach(option => {
            const div = make('div', row.optionList, '', 'option');
            make('div', div, `${option.teachers.join('、') || '教师字段为空'} · 人数 ${option.seats} · ${['1', '2'].includes(option.type) ? '已选' : '未选'}`);
            make('div', div, `课程 ${option.courseId} / 课堂 ${option.classId}`);
            make('div', div, `方案 ${option.planId} / 分组 ${option.groupId}`, 'muted');
            const button = make('button', div, '限定为这个课堂'); row.optionButtons.push(button);
            button.onclick = () => {
                if (busy || fatal || hasPending) return;
                for (const key of ['courseId', 'classId', 'planId', 'groupId']) row[key].value = option[key];
                row.advanced.open = true; row.status.textContent = '已填入课堂限定；请再次只读检查，教师姓名不会自动改变';
            };
        });
    }
    function setPending(record) {
        hasPending = Boolean(record); pendingBox.hidden = !record;
        pendingText.textContent = record ? `待确认：${record.target.name} · ${record.target.teacher} · 学期 ${record.term} · 课堂 ${record.ktbh}。原提交可能已经生效。在确认或人工解除前，只会查询，不会再次提交。` : '';
        setEnabled();
    }
    function render(state) {
        headline.textContent = state.headline;
        let config;
        try { config = makeConfig(read()); } catch { config = null; }
        config?.targets.forEach((target, i) => {
            const status = state.statuses[target.key]; if (!status || !rows[i]) return;
            rows[i].status.textContent = status.text; renderOptions(rows[i], status.options);
        });
        setPending(state.pending);
        meta.textContent = `第 ${state.round} 轮 · ${state.readOnly ? '只读检查' : '自动模式'} · ${state.busy ? '请求处理中' : '本轮已结束'}${doc.hidden ? ' · 后台标签可能延迟执行' : ''}`;
    }
    setEnabled(); doc.documentElement.append(host);
    return { host, read, log, render, showError, setPending,
        notice(text) { headline.textContent = text; },
        bind(value) { handlers = value; },
        setBusy(value) { busy = value; setEnabled(); },
        fatal(text) { fatal = true; headline.textContent = text; log(text); setEnabled(); },
    };
}
module.exports = { mountPanel };
