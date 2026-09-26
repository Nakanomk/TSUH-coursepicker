'use strict';
const { fail, id, message, validResponse, errorKind } = require('./core');
const { makeConfig } = require('./config');
const { assertCourse, assertDetails, groupClasses, selected, matchesTeacher, appearsFull,
    classKey, actualClassKey, matchesPins, matchingCourses, snapshotCourse, describeOption } = require('./domain');

class Engine {
    constructor({ api, journal, config, readOnly = true, now = Date.now, onChange = () => {}, onLog = () => {} }) {
        this.api = api; this.journal = journal; this.config = makeConfig(config); this.readOnly = readOnly;
        this.now = now; this.onChange = onChange; this.onLog = onLog;
        this.done = new Set(); this.retries = new Map(); this.pendingHandle = null;
        this.state = { busy: false, paused: false, completed: false, round: 0, errors: 0,
            readOnly, headline: readOnly ? '准备只读检查' : '准备自动选课', pending: null,
            statuses: Object.fromEntries(this.config.targets.map(t => [t.key, { text: '等待检查', options: [] }])) };
    }
    emit() { this.state.pending = this.pendingHandle?.record ?? null; this.onChange(this.state); }
    log(text) { this.onLog(message(text)); }
    active() { if (this.state.paused) fail('stopped', '已暂停；不再发送新请求'); }
    status(target, text, options) {
        if (!this.state.statuses[target.key]) return;
        this.state.statuses[target.key] = { text, options: options ?? this.state.statuses[target.key].options };
        this.emit();
    }
    finish(target, course, group) {
        this.done.add(target.key);
        this.status(target, `已确认选中：${target.teacher} · 课堂 ${group.id}`, [describeOption(course, group)]);
        this.log(`${target.name}：已从服务器课堂状态确认选中`);
    }
    async readGroups(course, target, config = this.config) {
        this.active(); assertCourse(course, target, config);
        assertDetails(await this.api.details(course), course, target, config);
        this.active();
        const rows = await this.api.classes(course);
        this.active();
        return groupClasses(rows, course);
    }
    async reconcile() {
        const handle = this.pendingHandle;
        if (!handle) return true;
        const record = handle.record, target = record.target;
        // A pending write must be checked against its OWN immutable snapshot, not edited settings.
        // Exclusions do not block read-only verification of an earlier request.
        const readConfig = { term: record.term, denyKeywords: [], denyCodes: [] };
        const groups = await this.readGroups(record.course, target, readConfig);
        const group = groups.find(item => item.id === record.ktbh);
        if (group && selected(group) && matchesTeacher(group, target) && matchesPins(record.course, group, target)) {
            this.journal.clearPending(handle);
            this.pendingHandle = null;
            const current = this.config.targets.find(t => t.key === target.key);
            if (current && this.config.term === record.term) this.finish(current, record.course, group);
            else this.log(`已核对旧提交：${target.name} / ${target.teacher} / ${record.term} / ${group.id}`);
            this.state.headline = '上一笔提交已确认；未重复提交';
            this.emit(); return true;
        }
        this.state.headline = `提交待确认：${target.name} / ${target.teacher} / ${record.term} / ${record.ktbh}。仅查询，不提交任何课程`;
        this.status(target, '等待服务器确认；未选中或查不到都不等于原请求一定失败');
        this.emit(); return false;
    }
    async submit(course, group, target) {
        this.active();
        this.status(target, `正在提交课堂 ${group.id}`);
        const params = { ktbh: group.id, xqh: group.term, kcbh: id(course.KCBH),
            fzid: id(course.FZID), faid: id(course.ID), sfid: '' };
        let result;
        try {
            result = await this.api.enroll(params, () => {
                this.active(); assertCourse(course, target, this.config);
                if (this.readOnly || this.pendingHandle || this.journal.pending()) fail('safety', '只读模式或已有待确认提交');
                if (group.type !== '0' || !matchesTeacher(group, target) || !matchesPins(course, group, target)
                    || group.term !== this.config.term) fail('safety', '提交前课堂校验未通过');
                // Persist first. If storage fails, the API must not send the request.
                this.pendingHandle = this.journal.savePending({ version: 2, term: this.config.term,
                    target, course: snapshotCourse(course), ktbh: group.id, at: this.now() });
                // No UI callback here: keep the last guard small and synchronous.
            });
        } catch (error) {
            if (this.pendingHandle) {
                this.state.headline = '提交结果不明，已保留记录；只允许查询确认';
                this.log(`${target.name}：${error.message}，不会盲目重试`);
                this.emit();
            }
            throw error;
        }
        if (!this.pendingHandle) fail('safety', '提交接口未执行持久化检查');
        if (!validResponse(result)) fail('schema', '提交响应结构异常，已保留待确认记录');
        if (id(result.code) === '0') {
            this.log(`${target.name}：服务器接受提交，继续核对课堂状态`);
            await this.reconcile();
            return;
        }
        // Preserve the old adapter's contract: a valid nonzero code is an explicit rejection.
        // HTTP errors, malformed responses, timeouts, and redirects never take this branch.
        this.journal.clearPending(this.pendingHandle); this.pendingHandle = null;
        this.retries.set(classKey(course, group), this.now() + this.config.submitCooldownMs);
        const text = message(result.msg || result.message || `code=${result.code}`);
        this.status(target, `服务器拒绝：${text}`); this.log(`${target.name}：${text}`);
        const kind = errorKind(text);
        if (kind === 'auth' || kind === 'rate') fail(kind, text);
    }
    async processTarget(target, courses) {
        const candidates = matchingCourses(courses, target, this.config);
        if (!candidates.length) { this.status(target, '本学期可选列表中尚未找到该课程', []); return; }
        const entries = [];
        // Inspect all same-name variants before choosing; a teacher can disambiguate plans.
        // An existing selection in another returned plan must not be ignored by a pin.
        for (const course of candidates) {
            for (const group of await this.readGroups(course, target)) entries.push({ course, group });
        }
        const options = entries.map(({ course, group }) => describeOption(course, group));
        const chosen = entries.filter(e => selected(e.group));
        if (chosen.length) {
            const unique = new Set(chosen.map(e => actualClassKey(e.course, e.group)));
            const matching = chosen.filter(e => matchesTeacher(e.group, target) && matchesPins(e.course, e.group, target));
            if (unique.size === 1 && matching.length && chosen.every(e => matchesTeacher(e.group, target))) {
                this.finish(target, matching[0].course, matching[0].group);
            } else this.status(target, '已有其他教师/课堂或多个已选课堂；不会自动退课或换班', options);
            return;
        }
        const matching = entries.filter(e => matchesTeacher(e.group, target) && matchesPins(e.course, e.group, target));
        if (!matching.length) { this.status(target, '未找到精确匹配教师及编号限定的课堂', options); return; }
        if (matching.length > 1) {
            this.status(target, `匹配到 ${matching.length} 个课堂/方案；请查看候选并指定，不自动猜选`, options); return;
        }
        const { course, group } = matching[0];
        if (appearsFull(group)) { this.status(target, '目标课堂暂满；自动模式下会继续检查', options); return; }
        if (this.readOnly) { this.status(target, `只读：唯一匹配课堂 ${group.id}，未提交`, options); return; }
        if (this.now() < (this.retries.get(classKey(course, group)) || 0)) {
            this.status(target, '上次提交被明确拒绝，等待重试间隔', options); return;
        }
        this.status(target, `唯一匹配课堂 ${group.id}，准备提交`, options);
        await this.submit(course, group, target);
    }
    async tick() {
        if (this.state.busy || this.state.paused || this.state.completed) return;
        this.state.busy = true; this.state.round++; this.emit();
        try {
            this.pendingHandle = this.journal.pending();
            if (this.pendingHandle) {
                // This entire round is reconciliation only, even when confirmation succeeds.
                await this.reconcile(); this.state.errors = 0;
                if (this.done.size === this.config.targets.length) this.state.completed = true;
                return;
            }
            this.active();
            this.state.headline = this.readOnly ? '只读检查中：不会提交' : '自动检查中'; this.emit();
            const courses = await this.api.courses(); this.active();
            for (const target of this.config.targets) {
                this.active();
                if (!this.done.has(target.key)) await this.processTarget(target, courses);
                if (this.pendingHandle) return;
            }
            this.state.errors = 0;
            if (this.done.size === this.config.targets.length) {
                this.state.completed = true; this.state.headline = '全部目标已确认选中，自动停止';
            } else this.state.headline = this.readOnly ? '只读检查结束；未发送选课请求' : '本轮结束，等待下一轮';
        } catch (error) {
            if (error?.kind !== 'stopped') {
                this.state.errors++;
                const fatal = ['auth', 'safety', 'schema', 'config'].includes(error?.kind) || !error?.kind;
                this.state.headline = `${message(error?.message || error)}${this.pendingHandle ? '；存在待确认提交，禁止重发' : ''}`;
                this.log(this.state.headline);
                if (fatal) { this.state.paused = true; this.state.headline += '；已停止，请核对后重新检查'; }
            }
        } finally { this.state.busy = false; this.emit(); }
    }
    pause() {
        this.state.paused = true;
        this.state.headline = '已要求暂停；等待当前请求结束，已发送的提交仍可能生效'; this.emit();
    }
    delay() { return Math.min(this.config.maxBackoffMs, this.config.scanIntervalMs * 2 ** Math.min(this.state.errors, 6)); }
}
module.exports = { Engine };
