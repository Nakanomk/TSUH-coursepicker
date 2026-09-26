"""Optional DOM smoke test in Chromium's about:blank, with no URL navigation.
Uses in-memory fetch/storage/lock fixtures injected into main.boot().
It does NOT prove live school compatibility or real cross-tab locking.
Requires Python playwright and Chromium, neither needed by the userscript.
"""
import json
import os
import shutil
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = (ROOT / 'dist/hust-course-picker.user.js').read_text().replace(
    "load('./main').boot(window, document);", "load('./main').boot(window.__testWin, document);")
HTML = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Offline mock</title><body><h1>离线模拟页面</h1><p>所有数据均为测试数据。未连接教务系统。</p></body></html>'
HARNESS = r"""(saved) => {
    const map = new Map(Object.entries(saved.storage || {}));
    window.__storage = map;
    const storage = { getItem: k => map.has(k) ? map.get(k) : null, setItem: (k,v) => map.set(k,String(v)), removeItem: k => map.delete(k) };
    const held = new Set(); window.__held = held;
    const locks = { async request(name, opts, callback) {
        if (held.has(name)) return callback(null);
        held.add(name); try { return await callback({name}); } finally { held.delete(name); }
    }};
    const course = {KCMC:'计算机图形学',KCBH:'C101',FZID:'G1',ID:'P1',XQH:'20261',XKGZ:'1',FAMC:'计算机类'};
    window.__state = saved.state || { rows: [
        {KTBH:'T1',XQH:'20261',TYPE:'0',XM:'何云峰',KTRL:80,KTRS:70},
        {KTBH:'T2',XQH:'20261',TYPE:'0',XM:'何云峰',KTRL:80,KTRS:80}], writes:0, uncertain:false, calls:[] };
    const fakeFetch = async (url, options) => {
        const parsed = new URL(url), path = parsed.pathname; const state = window.__state;
        state.calls.push(path); let data;
        if (path.endsWith('getXsFaFZkc')) data = {code:0,count:1,data:[course]};
        else if (path.endsWith('getXqhxKcktAll')) data = {code:0, fafzXx:{FAID:'P1',FZID:'G1',XQH:'20261',XKGZ:'1',FAMC:'计算机类'}, fzKcs:{KCMC:'计算机图形学',KCBH:'C101'}};
        else if (path.endsWith('getFzkt')) data = {code:0,count:0,data:state.rows};
        else if (path.endsWith('addStuxkIsxphx')) {
            state.writes++;
            if (!state.uncertain) state.rows.filter(r => r.KTBH === parsed.searchParams.get('ktbh')).forEach(r => r.TYPE='1');
            data={code:0};
        } else throw new Error('Unexpected URL '+url);
        return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
    };
    const win = { location:{origin:'https://wsxk.hust.edu.cn',pathname:'/zyxxk/offline'},localStorage:storage,
        navigator:{locks},fetch:fakeFetch,prompt:window.prompt.bind(window),
        addEventListener:window.addEventListener.bind(window) };
    win.top=win;win.self=win; window.__testWin=win;
}"""

def main():
    outcomes = []
    with sync_playwright() as p:
        executable = os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium') or shutil.which('chromium-browser') or shutil.which('google-chrome')
        browser = p.chromium.launch(executable_path=executable, headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1300, 'height': 1020})
        errors, network = [], []
        page.on('pageerror', lambda exc: errors.append(str(exc)))
        page.on('request', lambda req: network.append(req.url))
        page.on('dialog', lambda dialog: dialog.accept('已核对') if dialog.type == 'prompt' else dialog.accept())
        def mount(saved=None):
            page.set_content(HTML)
            page.evaluate(HARNESS, saved or {})
            page.evaluate(BUNDLE)
        def saved():
            return page.evaluate('({storage:Object.fromEntries(window.__storage),state:window.__state})')
        def wait_head(text):
            page.wait_for_function("text => document.querySelector('#hust-course-picker-panel-v2').shadowRoot.querySelector('.headline').textContent.includes(text)", arg=text)
        def wait_idle():
            page.wait_for_function("!document.querySelector('#hust-course-picker-panel-v2').shadowRoot.querySelector('button.primary').disabled")
        mount()
        host = page.locator('#hust-course-picker-panel-v2')
        assert host.count() == 1 and page.evaluate('__state.calls.length') == 0
        outcomes.append('boot mounts one panel and issues no API calls')
        host.get_by_label('学期编号（必填，请从学校系统核对）', exact=True).fill('20261')
        host.get_by_label('课程名称', exact=True).fill('计算机图形学')
        host.get_by_label('教师姓名', exact=True).fill('何云峰')
        host.get_by_role('button', name='只读检查', exact=True).click(); wait_head('只读检查结束')
        assert page.evaluate('__state.writes') == 0 and '匹配到 2' in host.locator('.target-status').inner_text()
        outcomes.append('preview displays ambiguity and never submits')
        host.locator('.options > summary').click()
        page.screenshot(path=str(ROOT / 'preview.png'), full_page=True)
        host.get_by_role('button', name='限定为这个课堂').first.click()
        assert host.get_by_label('课堂号 KTBH', exact=True).input_value() == 'T1'
        assert host.get_by_label('方案号 FAID', exact=True).input_value() == 'P1'
        assert host.get_by_label('教师姓名', exact=True).input_value() == '何云峰'
        outcomes.append('candidate button sets all identity pins without changing teacher')
        host.get_by_role('button', name='只读检查', exact=True).click(); wait_head('只读检查结束')
        assert '唯一匹配课堂 T1' in host.locator('.target-status').inner_text()
        host.get_by_role('button', name='开始自动选课', exact=True).click(); wait_head('全部目标已确认')
        assert page.evaluate('__state.writes') == 1
        assert page.evaluate("__storage.get('hust-course-picker:v2:pending') || null") is None
        outcomes.append('confirmation button submits exactly once and verifies mock server state')
        before = page.evaluate('__state.calls.length'); mount(saved())
        assert page.evaluate('__state.calls.length') == before
        assert host.get_by_label('教师姓名', exact=True).input_value() == '何云峰'
        assert host.get_by_label('课堂号 KTBH', exact=True).input_value() == 'T1'
        outcomes.append('recreated UI restores saved settings without automatic restart')
        page.evaluate("__held.add('hust-course-picker:exclusive')")
        host.get_by_role('button', name='只读检查', exact=True).click(); wait_head('另一标签页')
        assert page.evaluate('__state.calls.length') == before
        page.evaluate("__held.delete('hust-course-picker:exclusive')")
        outcomes.append('lock-conflict fixture produces visible error without API calls')
        page.evaluate("__state.rows[0].TYPE='0'; __state.uncertain=true")
        host.get_by_role('button', name='开始自动选课', exact=True).click(); wait_head('提交待确认')
        assert page.evaluate('__state.writes') == 2
        host.get_by_role('button', name='暂停', exact=True).click(); wait_idle()
        mount(saved())
        assert not host.locator('.alert').is_hidden()
        assert host.get_by_label('课程名称', exact=True).is_disabled()
        host.get_by_role('button', name='只读检查', exact=True).click(); wait_idle()
        assert page.evaluate('__state.writes') == 2
        assert page.evaluate("__storage.has('hust-course-picker:v2:pending')")
        outcomes.append('pending snapshot survives UI recreation and locks editor while reconciliation remains read-only')
        host.get_by_role('button', name='已人工核对，解除待确认', exact=True).click()
        page.wait_for_function("document.querySelector('#hust-course-picker-panel-v2').shadowRoot.querySelector('.alert').hidden")
        assert not page.evaluate("__storage.has('hust-course-picker:v2:pending')")
        outcomes.append('explicit acknowledgement clears exact pending record and unlocks form')
        assert errors == [], errors
        assert network == [], network
        outcomes.append('no uncaught browser exceptions and zero actual network requests')
        browser.close()
    result = {'passed': len(outcomes), 'checks': outcomes,
        'scope': 'Chromium about:blank DOM test with injected in-memory fetch/storage/lock fixtures; not live school or actual userscript-manager verification'}
    (ROOT / 'browser-test-results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
