'use strict';

class PickerError extends Error {
    constructor(kind, text) { super(text); this.name = 'PickerError'; this.kind = kind; }
}
const fail = (kind, text) => { throw new PickerError(kind, text); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'number' || typeof value === 'string' ? String(value) : '';
const validId = value => /^[A-Za-z0-9_-]{1,80}$/.test(id(value));
const normalize = value => String(value ?? '').normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]/gu, '');
const message = value => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const validResponse = value => isObject(value) && /^-?\d+$/.test(id(value.code));
const stableJSON = value => JSON.stringify(value, function (key, item) {
    return isObject(item) ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item;
});
const errorKind = text => /登录|登陆|login|session|身份.*失效/i.test(text) ? 'auth'
    : /频繁|频率|限流|too many/i.test(text) ? 'rate' : 'server';
function checkJSON(data) {
    if (!validResponse(data)) fail('schema', '响应缺少有效的 code 字段');
    if (id(data.code) !== '0') {
        const text = message(data.msg || data.message || `服务器返回 code=${data.code}`);
        fail(errorKind(text), text);
    }
    return data;
}
function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value); Object.values(value).forEach(deepFreeze);
    }
    return value;
}
module.exports = { PickerError, fail, isObject, id, validId, normalize, message, sleep,
    validResponse, stableJSON, errorKind, checkJSON, deepFreeze };
