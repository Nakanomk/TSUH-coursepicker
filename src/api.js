'use strict';
const { PickerError, fail, id, sleep, validResponse, checkJSON, stableJSON } = require('./core');
const { ORIGIN } = require('./config');
const ENDPOINTS = Object.freeze({
    courses: '/zyxxk/Stuxk/getXsFaFZkc', classes: '/zyxxk/Stuxk/getFzkt',
    details: '/zyxxk/Stuxk/getXqhxKcktAll', enroll: '/zyxxk/Stuxk/addStuxkIsxphx',
});
const METHODS = new Map([[ENDPOINTS.courses, 'POST'], [ENDPOINTS.classes, 'POST'], [ENDPOINTS.details, 'GET'], [ENDPOINTS.enroll, 'GET']]);
const classParams = c => ({ fzid: id(c.FZID), kcbh: id(c.KCBH), faid: id(c.ID), id: id(c.ID), sfid: '' });

// Shared by sessions on one page: both the queue and last request time survive preview -> auto.
class RequestQueue {
    constructor({ fetchImpl, origin = ORIGIN, now = Date.now, wait = sleep }) {
        if (origin !== ORIGIN) fail('safety', '请求只能发送至原脚本中的选课站点');
        this.fetch = fetchImpl; this.origin = origin; this.now = now; this.wait = wait;
        this.tail = Promise.resolve(); this.lastRequestAt = -Infinity;
    }
    request(path, params, config, active, beforeSend) {
        const work = () => this.send(path, params, config, active, beforeSend);
        const result = this.tail.then(work);
        this.tail = result.catch(() => {}); // One failed request must not poison the queue.
        return result;
    }
    async send(path, params, config, active, beforeSend) {
        if (!METHODS.has(path)) fail('safety', '接口不在白名单中');
        if (path === ENDPOINTS.enroll && typeof beforeSend !== 'function') fail('safety', '提交缺少最后一道安全检查');
        const delay = config.minRequestGapMs - (this.now() - this.lastRequestAt);
        if (delay > 0) await this.wait(delay);
        if (!active()) fail('stopped', '已暂停，不发送新请求');
        const url = new URL(path, this.origin), form = new URLSearchParams(params), method = METHODS.get(path);
        if (method === 'GET') {
            for (const [key, value] of form) url.searchParams.set(key, value);
            url.searchParams.set('_', String(this.now()));
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs);
        try {
            // No await between the synchronous journal guard and sending the write request.
            if (beforeSend) beforeSend();
            this.lastRequestAt = this.now();
            const response = await this.fetch(url.href, {
                method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
                headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest',
                    ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}) },
                ...(method === 'POST' ? { body: form.toString() } : {}), signal: controller.signal,
            });
            if ([401, 403].includes(response.status)) fail('auth', '登录或访问权限失效，请在学校页面重新登录');
            if (response.status === 429) fail('rate', '服务器限流，降低频率后再检查');
            if (!response.ok) fail('network', `HTTP ${response.status}`);
            const text = await response.text();
            if (/^\s*</.test(text)) fail('auth', '接口返回网页而非数据，请核对登录状态');
            let data;
            try { data = JSON.parse(text); } catch { fail('schema', '接口返回的内容不是有效 JSON'); }
            if (!validResponse(data)) fail('schema', '接口响应缺少有效 code');
            return data;
        } catch (error) {
            if (error instanceof PickerError) throw error;
            throw new PickerError('network', error?.name === 'AbortError' ? '请求超时' : '网络中断或登录跳转');
        } finally { clearTimeout(timer); }
    }
}
class HustAPI {
    constructor({ queue, config, active = () => true }) { this.queue = queue; this.config = config; this.active = active; }
    request(path, params, guard) { return this.queue.request(path, params, this.config, this.active, guard); }
    async allRows(path, params) {
        const rows = [], signatures = new Set();
        let declaredCount = null;
        for (let page = 1; page <= this.config.maxPages; page++) {
            const result = checkJSON(await this.request(path, { ...params, page, limit: this.config.pageSize }));
            if (!Array.isArray(result.data)) fail('schema', '列表响应缺少 data 数组');
            const batch = result.data;
            const signature = JSON.stringify(batch.map(stableJSON).sort());
            if (batch.length && signatures.has(signature)) fail('schema', '分页重复，不能确认读取完整');
            if (batch.length) signatures.add(signature);
            let count = null;
            if (result.count !== undefined && result.count !== null) {
                if (!/^\d+$/.test(id(result.count)) || !Number.isSafeInteger(Number(result.count))) fail('schema', '列表总数异常');
                count = Number(result.count);
            }
            // The old script observed count=0 with nonempty data. Treat 0 as unknown,
            // not proof that a full page is the entire list; continue when the page is full.
            if (count === 0 && (batch.length || rows.length)) count = null;
            if (count !== null) {
                if (declaredCount !== null && declaredCount !== count) fail('schema', '分页期间总数变化，请重新检查');
                declaredCount = count;
            }
            rows.push(...batch);
            if (declaredCount !== null) {
                if (rows.length > declaredCount) fail('schema', '列表行数超过声明总数');
                if (rows.length === declaredCount) return rows;
                if (!batch.length) fail('schema', '分页提前结束');
            } else if (batch.length < this.config.pageSize) return rows;
        }
        fail('schema', '分页超过安全上限，未使用不完整列表');
    }
    courses() { return this.allRows(ENDPOINTS.courses, { fzxkfs: '', xkgz: '1' }); }
    classes(course) { return this.allRows(ENDPOINTS.classes, classParams(course)); }
    async details(course) { return checkJSON(await this.request(ENDPOINTS.details, { fzid: id(course.FZID), kcbh: id(course.KCBH) })); }
    enroll(params, guard) { return this.request(ENDPOINTS.enroll, params, guard); }
}
module.exports = { ENDPOINTS, RequestQueue, HustAPI };
