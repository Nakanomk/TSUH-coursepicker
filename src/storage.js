'use strict';
const { fail, isObject } = require('./core');
const { KEYS } = require('./config');
const { validatePending, legacyPending } = require('./domain');
class Store {
    constructor(storage) { this.storage = storage; }
    get(key) {
        try { return this.storage.getItem(key); } catch { fail('safety', '无法读取本地存储，禁止提交'); }
    }
    write(key, value) {
        const encoded = JSON.stringify(value);
        try {
            this.storage.setItem(key, encoded);
            if (this.storage.getItem(key) !== encoded) throw new Error('not persisted');
        } catch { fail('safety', '本地持久化失败，禁止提交'); }
        return encoded;
    }
    settings() {
        const raw = this.get(KEYS.settings);
        if (raw === null) return null;
        let value;
        try { value = JSON.parse(raw); } catch { fail('config', '已保存的设置损坏，请修复本地设置'); }
        if (!isObject(value) || value.version !== 2) fail('config', '不支持的设置版本');
        return value;
    }
    saveSettings(config) { this.write(KEYS.settings, config); }
    pending() {
        const current = this.get(KEYS.pending), legacy = this.get(KEYS.legacyPending);
        if (current !== null && legacy !== null) fail('safety', '新旧脚本同时存在待确认记录，请分别人工核对，不能自动覆盖');
        const raw = current ?? legacy;
        if (raw === null) return null;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { fail('safety', '待确认记录损坏，请人工核对；不会自动清除'); }
        const sourceKey = current !== null ? KEYS.pending : KEYS.legacyPending;
        const record = sourceKey === KEYS.pending ? validatePending(parsed) : legacyPending(parsed);
        return { record, sourceKey, raw };
    }
    savePending(record) {
        if (this.pending()) fail('safety', '已有待确认提交，不能覆盖记录');
        const validated = validatePending(record);
        const raw = this.write(KEYS.pending, validated);
        return { record: validated, sourceKey: KEYS.pending, raw };
    }
    clearPending(handle) {
        if (!handle || ![KEYS.pending, KEYS.legacyPending].includes(handle.sourceKey)
            || this.get(handle.sourceKey) !== handle.raw) fail('safety', '待确认记录已变化，禁止清除');
        try {
            this.storage.removeItem(handle.sourceKey);
            if (this.storage.getItem(handle.sourceKey) !== null) throw new Error('not removed');
        } catch { fail('safety', '无法清除已核对记录，保持停止状态'); }
    }
}
module.exports = { Store };
