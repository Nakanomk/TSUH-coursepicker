'use strict';
const { fail, isObject, id, validId, normalize, stableJSON } = require('./core');
const { makeTarget } = require('./config');
const safety = text => fail('safety', text);

function assertCourse(course, target, config) {
    if (!isObject(course) || normalize(course.KCMC) !== target.name) safety('课程名称未精确匹配');
    if (config.denyKeywords.some(word => normalize(course.KCMC).includes(word) || normalize(course.FAMC).includes(word))
        || config.denyCodes.includes(id(course.KCBH).toLowerCase())) safety('命中禁选名单');
    for (const key of ['KCBH', 'FZID', 'ID', 'XQH']) {
        if (!validId(course[key])) safety(`课程缺少有效的 ${key}，不会猜测编号`);
    }
    if (id(course.XQH) !== config.term) safety('课程学期不一致');
    if (id(course.XKGZ) !== '1') safety('仅支持原脚本使用的“先排后选”流程（XKGZ=1）');
    return course;
}
function assertDetails(result, course, target, config) {
    assertCourse(course, target, config);
    const group = result.fafzXx, detail = result.fzKcs;
    if (!isObject(group) || !isObject(detail)) safety('课程详情结构变化');
    if (normalize(detail.KCMC) !== target.name || id(detail.KCBH) !== id(course.KCBH)) safety('列表与详情的课程名称/课程号不一致');
    for (const [key, expected] of [['FAID', course.ID], ['FZID', course.FZID], ['XQH', course.XQH], ['XKGZ', '1']]) {
        if (id(group[key]) !== id(expected)) safety(`课程详情 ${key} 不一致`);
    }
    if (config.denyKeywords.some(word => normalize(group.FAMC).includes(word))) safety('课程方案命中禁选名单');
}
function teacherNames(row) {
    return [row.XM, isObject(row.KTFZR) ? row.KTFZR.XM : '']
        .flatMap(v => String(v ?? '').normalize('NFKC').split(/[,、;\/&\s]+/u))
        .map(normalize).filter(Boolean);
}
function groupClasses(rows, course) {
    if (!Array.isArray(rows)) fail('schema', '课堂列表不是数组');
    const groups = new Map();
    for (const row of rows) {
        if (!isObject(row) || !validId(row.KTBH) || !validId(row.XQH)) safety('课堂缺少有效编号/学期');
        if (id(row.XQH) !== id(course.XQH)) safety('课堂学期与课程不一致');
        for (const [key, expected] of [['KCBH', course.KCBH], ['FZID', course.FZID], ['FAID', course.ID]]) {
            if (row[key] !== undefined && id(row[key]) !== id(expected)) safety(`课堂 ${key} 与课程不一致`);
        }
        if (row.KCMC !== undefined && normalize(row.KCMC) !== normalize(course.KCMC)) safety('课堂列表返回了另一门课程');
        if (!['0', '1', '2'].includes(id(row.TYPE))) safety('未知课堂 TYPE，不能猜测是否已选');
        const key = id(row.KTBH);
        if (!groups.has(key)) groups.set(key, { id: key, term: id(row.XQH), type: id(row.TYPE), rows: [], teachers: new Set() });
        const group = groups.get(key);
        if (group.type !== id(row.TYPE)) safety('同一课堂多行的选课状态不一致');
        group.rows.push(row); teacherNames(row).forEach(name => group.teachers.add(name));
    }
    return [...groups.values()];
}
const selected = group => ['1', '2'].includes(group.type);
const matchesTeacher = (group, target) => group.teachers.has(target.teacher);
const numeric = value => value === null || value === undefined || String(value).trim() === '' || typeof value === 'boolean'
    ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
const appearsFull = group => group.rows.some(row => {
    const capacity = numeric(row.KTRL), used = numeric(row.KTRS);
    return capacity !== null && capacity > 0 && used !== null && used >= capacity;
});
const courseKey = c => JSON.stringify([id(c.XQH), id(c.KCBH), id(c.ID), id(c.FZID)]);
const classKey = (c, g) => JSON.stringify([courseKey(c), g.id]);
const actualClassKey = (c, g) => JSON.stringify([id(c.XQH), id(c.KCBH), g.id]);
function matchesPins(course, group, target) {
    return (!target.courseId || target.courseId === id(course.KCBH))
        && (!target.planId || target.planId === id(course.ID))
        && (!target.groupId || target.groupId === id(course.FZID))
        && (!target.classId || target.classId === group.id);
}
function matchingCourses(rows, target, config) {
    if (!Array.isArray(rows)) fail('schema', '课程列表不是数组');
    const candidates = rows.filter(row => isObject(row) && normalize(row.KCMC) === target.name);
    // A same-name row without a term cannot safely be silently discarded.
    if (candidates.some(row => !validId(row.XQH))) safety('同名课程存在缺失学期的记录');
    const unique = new Map();
    for (const course of candidates.filter(row => id(row.XQH) === config.term)) {
        assertCourse(course, target, config);
        const key = courseKey(course);
        // Validate every duplicate, not just the last row kept by a Map.
        if (unique.has(key) && stableJSON(snapshotCourse(unique.get(key))) !== stableJSON(snapshotCourse(course))) {
            safety('同一课程标识对应的列表内容不一致');
        }
        unique.set(key, course);
    }
    if (unique.size > config.maxCourseVariants) safety('同名课程方案过多，请先在学校页面人工核对');
    return [...unique.values()];
}
function snapshotCourse(course) {
    return Object.fromEntries(['KCMC', 'KCBH', 'FZID', 'ID', 'XQH', 'XKGZ', 'FAMC'].map(key => [key, id(course[key])]));
}
function describeOption(course, group) {
    const row = group.rows.find(r => numeric(r.KTRL) !== null) || group.rows[0];
    const cap = numeric(row?.KTRL), used = numeric(row?.KTRS);
    return {
        courseId: id(course.KCBH), classId: group.id, planId: id(course.ID), groupId: id(course.FZID),
        teachers: [...group.teachers], type: group.type,
        seats: cap !== null && cap > 0 && used !== null ? `${used}/${cap}` : '人数未知',
    };
}
function validatePending(record) {
    if (!isObject(record) || record.version !== 2 || !validId(record.term) || !validId(record.ktbh)
        || typeof record.at !== 'number' || !Number.isFinite(record.at) || record.at < 0) safety('待确认记录结构不完整');
    const target = makeTarget(record.target);
    const config = { term: record.term, denyKeywords: [], denyCodes: [] };
    assertCourse(record.course, target, config);
    if (!matchesPins(record.course, { id: record.ktbh }, target)) safety('待确认记录与课堂限定不一致');
    return { ...record, target };
}
function legacyPending(record) {
    // The only legacy format supported is the exact script supplied by the user.
    if (!isObject(record) || record.version !== 1 || normalize(record.name) !== '计算机图形学'
        || id(record.course?.XQH) !== '20261') safety('未知的旧版待确认记录，请人工核对，不能猜测教师');
    return validatePending({ version: 2, term: '20261', target: { name: record.name, teacher: '何云峰' },
        course: record.course, ktbh: record.ktbh, at: record.at });
}
module.exports = { assertCourse, assertDetails, teacherNames, groupClasses, selected, matchesTeacher,
    appearsFull, courseKey, classKey, actualClassKey, matchesPins, matchingCourses, snapshotCourse,
    describeOption, validatePending, legacyPending };
