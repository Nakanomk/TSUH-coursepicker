'use strict';
const { fail, isObject, normalize, validId, id, deepFreeze } = require('./core');

const ORIGIN = 'https://wsxk.hust.edu.cn';
const KEYS = Object.freeze({
    settings: 'hust-course-picker:v2:settings', pending: 'hust-course-picker:v2:pending',
    legacyPending: 'hust-graphics-20261-v1:pending',
});
// A site-wide lock, NOT one lock per target/term. Also cooperate with the uploaded old script.
const LOCK_NAMES = Object.freeze(['hust-course-picker:exclusive', 'hust-graphics-20261-v1-exclusive']);
const DEFAULTS = deepFreeze({
    version: 2, term: '', targets: [], scanIntervalMs: 3000, minRequestGapMs: 500,
    submitCooldownMs: 15000, timeoutMs: 12000, maxBackoffMs: 60000, pageSize: 90, maxPages: 40,
    maxCourseVariants: 12,
    // Preserve the old script's exclusion, but make it visible and editable.
    denyKeywords: ['接口技术'], denyCodes: ['w121673'],
});
function emptyTarget() { return { name: '', teacher: '', courseId: '', classId: '', planId: '', groupId: '' }; }
function makeTarget(raw) {
    if (!isObject(raw)) fail('config', '课程配置必须是对象');
    const name = normalize(raw.name), teacher = normalize(raw.teacher);
    if (!name || name.length > 120) fail('config', '请填写完整课程名称（最多 120 字符）');
    if (!teacher || teacher.length > 80) fail('config', `${name}：请填写教师全名，不支持空教师自动任选`);
    const target = { name, teacher };
    for (const key of ['courseId', 'classId', 'planId', 'groupId']) {
        target[key] = id(raw[key] ?? '').trim();
        if (target[key] && !validId(target[key])) fail('config', `${name}：${key} 编号格式无效`);
    }
    target.key = JSON.stringify([name, teacher, target.courseId, target.classId, target.planId, target.groupId]);
    return deepFreeze(target);
}
function strings(value, label) {
    if (!Array.isArray(value) || value.some(x => typeof x !== 'string')) fail('config', `${label}必须是字符串数组`);
    return [...new Set(value.map(normalize).filter(Boolean))];
}
function makeConfig(raw) {
    if (!isObject(raw)) fail('config', '设置格式错误');
    const cfg = { ...DEFAULTS, ...raw, version: 2 };
    cfg.term = id(cfg.term).trim();
    if (!validId(cfg.term)) fail('config', '请填写并核对学期编号；程序不会根据当前日期猜测学期');
    if (!Array.isArray(raw.targets) || raw.targets.length < 1 || raw.targets.length > 20) fail('config', '请配置 1 至 20 门课程');
    cfg.targets = raw.targets.map(makeTarget);
    if (new Set(cfg.targets.map(t => t.name)).size !== cfg.targets.length) {
        fail('config', '同一课程名称只能配置一次；多个教师不要作为两门独立课程添加');
    }
    cfg.denyKeywords = strings(cfg.denyKeywords, '禁选关键词');
    cfg.denyCodes = strings(cfg.denyCodes, '禁选课程号').map(x => x.toLowerCase());
    for (const t of cfg.targets) {
        if (cfg.denyKeywords.some(word => t.name.includes(word)) || cfg.denyCodes.includes(t.courseId.toLowerCase())) {
            fail('config', `${t.name} 位于禁选名单；需要选这门课时，先明确修改高级设置中的禁选名单`);
        }
    }
    for (const [key, min, max] of [
        ['scanIntervalMs', 1500, 300000], ['minRequestGapMs', 250, 60000],
        ['submitCooldownMs', 5000, 600000], ['timeoutMs', 3000, 60000],
        ['maxBackoffMs', 10000, 600000], ['pageSize', 1, 200], ['maxPages', 1, 100],
        ['maxCourseVariants', 1, 30],
    ]) {
        if (typeof cfg[key] !== 'number' || !Number.isInteger(cfg[key]) || cfg[key] < min || cfg[key] > max) {
            fail('config', `${key} 必须是 ${min} 至 ${max} 的整数`);
        }
    }
    if (cfg.maxBackoffMs < cfg.scanIntervalMs) fail('config', '最大退避间隔不得小于正常扫描间隔');
    return deepFreeze(cfg);
}
module.exports = { ORIGIN, KEYS, LOCK_NAMES, DEFAULTS, emptyTarget, makeTarget, makeConfig };
