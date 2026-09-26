'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { config, course, row } = require('./helpers.cjs');
const { normalize } = require('../src/core');
const { makeConfig, makeTarget } = require('../src/config');
const { assertCourse, assertDetails, groupClasses, matchesTeacher, appearsFull, matchingCourses } = require('../src/domain');

test('both target and response normalization remove width, spaces, and zero-width differences', () => {
    assert.equal(normalize(' Ａ Ｂ\u200bＣ '), 'ABC');
    const t = makeTarget({ name: ' 计算机 图形学 ', teacher: '何\u200b云峰' });
    assert.equal(t.name, '计算机图形学'); assert.equal(t.teacher, '何云峰');
    assertCourse(course(), t, config());
});
test('teacher must be specified, duplicate course targets rejected, settings frozen', () => {
    assert.throws(() => makeTarget({ name: '计算机图形学', teacher: '' }), /教师/);
    assert.throws(() => config({ targets: [{ name: 'a', teacher: '甲' }, { name: ' a ', teacher: '乙' }] }), /只能配置一次/);
    const c = config(); assert.ok(Object.isFrozen(c.targets[0]));
    assert.throws(() => makeConfig({ term: '', targets: [{ name: 'a', teacher: '甲' }] }), /学期/);
});
test('legacy exclusions are editable, not hidden in matching logic', () => {
    assert.throws(() => config({ targets: [{ name: '接口技术', teacher: '张三' }] }), /禁选/);
    assert.equal(config({ targets: [{ name: '接口技术', teacher: '张三' }], denyKeywords: [], denyCodes: [] }).targets[0].name, '接口技术');
});
test('multi-row classes merge teachers, including KTFZR and full-width delimiters', () => {
    const g = groupClasses([row({ XM: '张三，李四' }), row({ XM: '', KTFZR: { XM: '何云峰' } })], course());
    assert.equal(g.length, 1); assert.deepEqual([...g[0].teachers], ['张三', '李四', '何云峰']);
    assert.ok(matchesTeacher(g[0], { teacher: '何云峰' }));
    assert.ok(!matchesTeacher(g[0], { teacher: '何云' }));
});
test('inconsistent multi-row TYPE and unknown TYPE stop safely', () => {
    assert.throws(() => groupClasses([row(), row({ TYPE: '1' })], course()), /不一致/);
    assert.throws(() => groupClasses([row({ TYPE: '9' })], course()), /未知/);
});
test('mismatched course ids, missing ids, and cross-term class rows rejected', () => {
    assert.throws(() => groupClasses([row({ KCBH: 'wrong' })], course()), /不一致/);
    assert.throws(() => groupClasses([row({ XQH: '20262' })], course()), /学期/);
    assert.throws(() => assertCourse(course({ ID: '' }), config().targets[0], config()), /编号/);
    assert.throws(() => assertCourse(course({ XKGZ: '2' }), config().targets[0], config()), /先排后选/);
});
test('courses in other terms do not create artificial same-name ambiguity', () => {
    const cfg = config();
    assert.equal(matchingCourses([course(), course({ XQH: '20262' })], cfg.targets[0], cfg).length, 1);
    assert.throws(() => matchingCourses([course({ XQH: '' })], cfg.targets[0], cfg), /缺失学期/);
});
test('full detection does not treat blank/null fields as known counts', () => {
    assert.ok(appearsFull(groupClasses([row({ KTRS: '80', KTRL: '80' })], course())[0]));
    assert.ok(!appearsFull(groupClasses([row({ KTRS: '', KTRL: 80 })], course())[0]));
    assert.ok(!appearsFull(groupClasses([row({ KTRS: null, KTRL: null })], course())[0]));
});
test('every duplicate course is checked before deduplication', () => {
    const cfg = config();
    assert.equal(matchingCourses([course(), course()], cfg.targets[0], cfg).length, 1);
    assert.throws(() => matchingCourses([course(), course({ FAMC: '另一个方案' })], cfg.targets[0], cfg), /内容不一致/);
    assert.throws(() => matchingCourses([course({ XKGZ: '2' }), course()], cfg.targets[0], cfg), /先排后选/);
});
test('detail must agree with the listed course and plan', () => {
    assert.throws(() => assertDetails({ fafzXx: {}, fzKcs: { KCMC: '别的课', KCBH: 'C101' } }, course(), config().targets[0], config()), /不一致/);
});
