/**
 * Regression probe for ChatGPT's 2026 virtualized / rollout DOM.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const USERSCRIPT = fs.readFileSync(path.join(ROOT, 'ai-conversation-navigator.user.js'), 'utf8');
const CONVO_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_CONVO_ID = '22222222-2222-4222-8222-222222222222';
const TOTAL = 24;
const WINDOW = 4;
const html = "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<title>ChatGPT virtualized timeline probe</title>\n<style>\nhtml,body{margin:0;height:100%;background:#212121;color:#eee}\n#timeline{height:620px;overflow-y:auto;display:flex;flex-direction:column-reverse;border:1px solid #444}\n#spacer{height:2880px;flex:0 0 auto;position:relative;width:100%}\nsection[data-testid^=\"conversation-turn-\"]{position:absolute;left:0;right:0;min-height:116px;padding:8px;box-sizing:border-box}\n[data-chatgpt-search-unit-key]{min-height:40px}\n</style>\n</head>\n<body>\n<main><div data-app-action-timeline-scroll id=\"timeline\"><div id=\"spacer\"></div></div></main>\n<script>\n(function(){\n  var TOTAL=24, WINDOW=4, ROW=120;\n  var PREFIX='', ID_PREFIX='msg-user-';\n  var scroller=document.getElementById('timeline');\n  var spacer=document.getElementById('spacer');\n  var shells=[];\n  function makeShell(q){\n    var section=document.createElement('section');\n    var turnNo=q*2-1;\n    section.setAttribute('data-testid','conversation-turn-'+turnNo);\n    section.setAttribute('data-turn','user');\n    section.setAttribute('data-turn-id','msg-user-'+q);\n    section.style.top=((q-1)*ROW)+'px';\n    section.dataset.q=String(q);\n    spacer.appendChild(section);\n    return section;\n  }\n  for(var q=1;q<=TOTAL;q++) shells.push(makeShell(q));\n  function mountedBody(q){\n    var msg=document.createElement('div');\n    msg.setAttribute('data-chatgpt-search-unit-key','probe:'+ID_PREFIX+q+':user');\n    msg.setAttribute('data-chatgpt-search-message-ids',JSON.stringify([ID_PREFIX+q]));\n    msg.textContent=PREFIX+'Question number '+q+' about virtual scrolling';\n    return msg;\n  }\n  function render(){\n    var max=Math.max(1,scroller.scrollHeight-scroller.clientHeight);\n    var frac=Math.min(1,Math.abs(scroller.scrollTop)/max);\n    var newestStart=TOTAL-WINDOW;\n    var start=Math.round(newestStart*(1-frac));\n    start=Math.max(0,Math.min(newestStart,start));\n    for(var i=0;i<shells.length;i++){\n      var shell=shells[i], q=i+1;\n      var shouldMount=q>=start+1&&q<=start+WINDOW;\n      var body=shell.querySelector('[data-chatgpt-search-unit-key]');\n      if(shouldMount&&!body) shell.appendChild(mountedBody(q));\n      if(!shouldMount&&body) body.remove();\n    }\n    document.body.setAttribute('data-probe-window',String(start+1)+'-'+String(start+WINDOW));\n  }\n  scroller.addEventListener('scroll',render,{passive:true});\n  window.__probe={\n    render:render,\n    nativePushState:history.pushState.bind(history),\n    switchConversation:function(prefix,idPrefix){\n      PREFIX=prefix||'';\n      ID_PREFIX=idPrefix||'msg-user-';\n      for(var i=0;i<shells.length;i++){\n        var body=shells[i].querySelector('[data-chatgpt-search-unit-key]');\n        if(body) body.remove();\n      }\n      render();\n    },\n    mounted:function(){\n      return Array.from(document.querySelectorAll('[data-chatgpt-search-unit-key$=\":user\"]'))\n        .map(function(el){return el.textContent.trim()});\n    }\n  };\n  render();\n})();\n</script>\n</body>\n</html>";

function conversationPayload(prefix = '', idPrefix = 'msg-user-', nodePrefix = 'node-user-') {
  const mapping = {};
  let parent = null;
  for (let i = 1; i <= TOTAL; i++) {
    const nodeId = nodePrefix + i;
    mapping[nodeId] = {
      id: nodeId,
      parent,
      children: i < TOTAL ? [nodePrefix + (i + 1)] : [],
      message: {
        id: idPrefix + i,
        author: { role: 'user' },
        recipient: 'all',
        metadata: {},
        content: {
          content_type: 'text',
          parts: [prefix + 'Question number ' + i + ' about virtual scrolling']
        }
      }
    };
    parent = nodeId;
  }
  return { current_node: nodePrefix + TOTAL, mapping };
}

function fail(msg, detail) {
  console.error('FAIL:', msg, detail || '');
  process.exitCode = 1;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.addInitScript(() => {
    window.GM_getValue = function (_k, d) { return d; };
    window.GM_setValue = function () {};
    window.GM_addStyle = function (css) {
      var st = document.createElement('style');
      st.textContent = css;
      (document.head || document.documentElement).appendChild(st);
      return st;
    };
    window.GM_xmlhttpRequest = undefined;
  });

  await page.route('https://chatgpt.com/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ accessToken: 'probe-token' })
      });
    }
    if (url.pathname === '/backend-api/conversation/' + CONVO_ID ||
        url.pathname === '/backend-api/conversation/' + SECOND_CONVO_ID) {
      const auth = route.request().headers()['authorization'];
      if (auth !== 'Bearer probe-token') {
        return route.fulfill({ status: 401, body: '{}' });
      }
      const second = url.pathname.endsWith('/' + SECOND_CONVO_ID);
      if (second) await new Promise(resolve => setTimeout(resolve, 1200));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(second
          ? conversationPayload('Second conversation: ', 'msg-second-', 'node-second-')
          : conversationPayload())
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: html
    });
  });

  await page.goto('https://chatgpt.com/c/' + CONVO_ID, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: USERSCRIPT });

  await page.waitForSelector('[data-acn-role="nav-trigger"]', { timeout: 10000 });
  await page.click('[data-acn-role="nav-trigger"]');
  await page.waitForSelector('[data-acn-role="nav-panel"][data-acn-open="true"]', { timeout: 5000 });

  await page.waitForFunction(total => {
    var stat = document.querySelector('[data-acn-role="nav-stat"]');
    return stat && Number(stat.getAttribute('data-acn-count')) === total &&
      /full conversation/.test(stat.textContent || '');
  }, TOTAL, { timeout: 10000 });

  const initial = await page.evaluate(() => ({
    count: Number(document.querySelector('[data-acn-role="nav-stat"]').getAttribute('data-acn-count')),
    text: document.querySelector('[data-acn-role="nav-stat"]').textContent,
    mounted: window.__probe.mounted()
  }));

  if (initial.count !== TOTAL) fail('full API index should expose 24 prompts', JSON.stringify(initial));
  if (initial.mounted.length !== WINDOW) fail('mock must keep only 4 prompt bodies mounted', JSON.stringify(initial));
  if (initial.mounted.some(t => /Question number 1\b/.test(t))) {
    fail('Q1 must start unmounted', JSON.stringify(initial));
  }

  const clicked = await page.evaluate(() => {
    var items = Array.from(document.querySelectorAll('[data-acn-role="nav-item"]'));
    var q1 = items.find(function (item) {
      var t = item.querySelector('[data-acn-role="nav-item-text"]');
      return t && /Question number 1\b/.test(t.textContent);
    });
    if (!q1) return false;
    q1.click();
    return true;
  });
  if (!clicked) fail('Q1 nav row missing from full API index');

  await page.waitForFunction(() => {
    var el = document.querySelector('[data-acn-jump-target="true"]');
    return el &&
      el.matches('[data-chatgpt-search-unit-key$=":user"]') &&
      /Question number 1\b/.test(el.textContent || '');
  }, null, { timeout: 12000 });

  const result = await page.evaluate(() => {
    var el = document.querySelector('[data-acn-jump-target="true"]');
    var stat = document.querySelector('[data-acn-role="nav-stat"]');
    var scroller = document.querySelector('[data-app-action-timeline-scroll]');
    return {
      resolvedText: el ? el.textContent.trim() : null,
      resolvedRolloutKey: el ? el.getAttribute('data-chatgpt-search-unit-key') : null,
      count: stat ? Number(stat.getAttribute('data-acn-count')) : null,
      scrollTop: scroller ? scroller.scrollTop : null,
      window: document.body.getAttribute('data-probe-window')
    };
  });

  if (!result.resolvedText || !/Question number 1\b/.test(result.resolvedText)) {
    fail('jump resolved the wrong recycled node', JSON.stringify(result));
  }
  if (result.count !== TOTAL) fail('jump must retain the full API index', JSON.stringify(result));

  // SPA route switch regression: bypass ACN's patched history methods by using the
  // native pushState captured by the mock before the userscript was injected.
  await page.evaluate(secondId => {
    window.__probe.nativePushState({}, '', '/c/' + secondId);
    window.__probe.switchConversation('Second conversation: ', 'msg-second-');
  }, SECOND_CONVO_ID);

  await page.waitForFunction(() => {
    var panel = document.querySelector('[data-acn-role="nav-panel"]');
    return location.pathname.indexOf('22222222-2222-4222-8222-222222222222') !== -1 &&
      (!panel || panel.getAttribute('data-acn-open') !== 'true');
  }, null, { timeout: 3000 });

  // Reopen while B's full-history request is intentionally delayed. The old A index
  // must already be gone; only B's mounted window may appear during this interval.
  await page.click('[data-acn-role="nav-trigger"]');
  await page.waitForSelector('[data-acn-role="nav-panel"][data-acn-open="true"]', { timeout: 3000 });

  const transition = await page.evaluate(() => {
    var items = Array.from(document.querySelectorAll('[data-acn-role="nav-item-text"]'))
      .map(function(el){ return (el.textContent || '').trim(); });
    var stat = document.querySelector('[data-acn-role="nav-stat"]');
    return {
      items,
      count: stat ? Number(stat.getAttribute('data-acn-count')) : null,
      path: location.pathname
    };
  });

  if (transition.items.some(t => /^Question number \d+ about virtual scrolling$/.test(t))) {
    fail('old conversation A leaked into B during route transition', JSON.stringify(transition));
  }

  await page.waitForFunction(total => {
    var stat = document.querySelector('[data-acn-role="nav-stat"]');
    var items = Array.from(document.querySelectorAll('[data-acn-role="nav-item-text"]'));
    return stat && Number(stat.getAttribute('data-acn-count')) === total &&
      items.length === total &&
      items.every(function(el){
        return (el.textContent || '').indexOf('Second conversation: Question number ') === 0;
      });
  }, TOTAL, { timeout: 10000 });

  const switched = await page.evaluate(() => ({
    count: Number(document.querySelector('[data-acn-role="nav-stat"]').getAttribute('data-acn-count')),
    first: (document.querySelector('[data-acn-role="nav-item-text"]') || {}).textContent || '',
    path: location.pathname
  }));

  if (switched.count !== TOTAL) fail('conversation B should expose its own full API index', JSON.stringify(switched));
  if (!switched.first.startsWith('Second conversation: ')) {
    fail('conversation B navigator should contain only B prompts', JSON.stringify(switched));
  }

  if (!process.exitCode) {
    console.log('PASS: ChatGPT rollout + virtualized full-history navigator + SPA route reset');
    console.log(JSON.stringify({ initial: result, transition, switched }));
  }

  await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
