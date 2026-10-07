/**
 * Regression probe for ChatGPT SPA routing + virtualized conversation navigation.
 *
 * Contract:
 * 1) DOM is immediately usable and does not wait for the full-history API.
 * 2) Full-history API is lazy: no request until Navigate/Search is opened.
 * 3) A -> B cannot retain A messages while React is recycling the DOM.
 * 4) API failure must never make the current conversation unusable.
 * 5) A -> B -> A rejects stale click closures from the first A lifecycle.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const USERSCRIPT = fs.readFileSync(path.join(ROOT, 'ai-conversation-navigator.user.js'), 'utf8');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const TOTAL = 24;
const WINDOW = 4;

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>ChatGPT SPA probe</title>
<style>
html,body{margin:0;height:100%;background:#212121;color:#eee}
#timeline{height:620px;overflow-y:auto;display:flex;flex-direction:column-reverse;border:1px solid #444}
#spacer{height:2880px;flex:0 0 auto;position:relative;width:100%}
section[data-testid^="conversation-turn-"]{position:absolute;left:0;right:0;min-height:116px;padding:8px;box-sizing:border-box}
[data-chatgpt-search-unit-key]{min-height:40px}
</style>
</head>
<body>
<main><div data-app-action-timeline-scroll id="timeline"><div id="spacer"></div></div></main>
<script>
(function(){
  var TOTAL=24, WINDOW=4, ROW=120;
  var PREFIX='', ID_PREFIX='msg-a-';
  var scroller=document.getElementById('timeline');
  var spacer=document.getElementById('spacer');
  var shells=[];

  function makeShell(q){
    var section=document.createElement('section');
    var turnNo=q*2-1;
    section.setAttribute('data-testid','conversation-turn-'+turnNo);
    section.setAttribute('data-turn','user');
    section.style.top=((q-1)*ROW)+'px';
    section.dataset.q=String(q);
    spacer.appendChild(section);
    return section;
  }

  for(var q=1;q<=TOTAL;q++) shells.push(makeShell(q));

  function mountedBody(q){
    var msg=document.createElement('div');
    msg.setAttribute('data-chatgpt-search-unit-key','probe:'+ID_PREFIX+q+':user');
    msg.setAttribute('data-chatgpt-search-message-ids',JSON.stringify([ID_PREFIX+q]));
    msg.textContent=PREFIX+'Question number '+q+' about virtual scrolling';
    return msg;
  }

  function render(){
    var max=Math.max(1,scroller.scrollHeight-scroller.clientHeight);
    var frac=Math.min(1,Math.abs(scroller.scrollTop)/max);
    var newestStart=TOTAL-WINDOW;
    var start=Math.round(newestStart*(1-frac));
    start=Math.max(0,Math.min(newestStart,start));

    for(var i=0;i<shells.length;i++){
      var shell=shells[i], q=i+1;
      var shouldMount=q>=start+1&&q<=start+WINDOW;
      var body=shell.querySelector('[data-chatgpt-search-unit-key]');
      if(shouldMount&&!body) shell.appendChild(mountedBody(q));
      if(!shouldMount&&body) body.remove();
    }
    document.body.setAttribute('data-probe-window',String(start+1)+'-'+String(start+WINDOW));
  }

  function switchConversation(prefix,idPrefix){
    PREFIX=prefix||'';
    ID_PREFIX=idPrefix||'msg-a-';
    for(var i=0;i<shells.length;i++){
      var body=shells[i].querySelector('[data-chatgpt-search-unit-key]');
      if(body) body.remove();
    }
    render();
  }

  scroller.addEventListener('scroll',render,{passive:true});
  window.__probe={
    render:render,
    nativePushState:history.pushState.bind(history),
    switchConversation:switchConversation,
    mutateOne:function(prefix,idPrefix){
      var els=Array.from(document.querySelectorAll('[data-chatgpt-search-unit-key$=":user"]'));
      var el=els[0];
      if(!el) return;
      var shell=el.closest('section');
      var q=shell&&shell.dataset?shell.dataset.q:'1';
      el.setAttribute('data-chatgpt-search-unit-key','probe:'+idPrefix+q+':user');
      el.setAttribute('data-chatgpt-search-message-ids',JSON.stringify([idPrefix+q]));
      el.textContent=prefix+'Question number '+q+' about virtual scrolling';
    },
    mounted:function(){
      return Array.from(document.querySelectorAll('[data-chatgpt-search-unit-key$=":user"]'))
        .map(function(el){return el.textContent.trim()});
    }
  };
  render();
})();
</script>
</body>
</html>`;

function conversationPayload(prefix, idPrefix, nodePrefix) {
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
  let apiRequests = 0;

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

    if (url.pathname.startsWith('/backend-api/conversation/')) {
      apiRequests++;
      const auth = route.request().headers()['authorization'];
      if (auth !== 'Bearer probe-token') {
        return route.fulfill({ status: 401, body: '{}' });
      }

      if (url.pathname.endsWith('/' + C)) {
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'forced probe failure' })
        });
      }

      // Deliberately slow. DOM must remain useful during this wait.
      await new Promise(resolve => setTimeout(resolve, 1200));

      const second = url.pathname.endsWith('/' + B);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(second
          ? conversationPayload('Second conversation: ', 'msg-b-', 'node-b-')
          : conversationPayload('', 'msg-a-', 'node-a-'))
      });
    }

    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: html
    });
  });

  await page.goto('https://chatgpt.com/c/' + A, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: USERSCRIPT });

  await page.waitForSelector('[data-acn-role="nav-trigger"]', { timeout: 10000 });

  // API must be lazy. Initial page scan should not fetch the full conversation.
  await page.waitForTimeout(500);
  if (apiRequests !== 0) fail('full-history API must not run before Navigate/Search opens', String(apiRequests));

  // Open Navigate: the 4 mounted DOM prompts must appear BEFORE the delayed API.
  await page.click('[data-acn-role="nav-trigger"]');
  await page.waitForSelector('[data-acn-role="nav-panel"][data-acn-open="true"]', { timeout: 3000 });

  await page.waitForFunction(win => {
    var stat=document.querySelector('[data-acn-role="nav-stat"]');
    return stat && Number(stat.getAttribute('data-acn-count'))===win &&
      /visible/.test(stat.textContent||'');
  }, WINDOW, { timeout: 700 });

  const fastA = await page.evaluate(() => ({
    count:Number(document.querySelector('[data-acn-role="nav-stat"]').getAttribute('data-acn-count')),
    items:Array.from(document.querySelectorAll('[data-acn-role="nav-item-text"]'))
      .map(el => (el.textContent||'').trim())
  }));
  if (fastA.count !== WINDOW) fail('A must be immediately usable from DOM', JSON.stringify(fastA));

  // Optional enrichment may later expand to all 24.
  await page.waitForFunction(total => {
    var stat=document.querySelector('[data-acn-role="nav-stat"]');
    return stat && Number(stat.getAttribute('data-acn-count'))===total &&
      /full conversation/.test(stat.textContent||'');
  }, TOTAL, { timeout: 10000 });

  const fullA = await page.evaluate(() => ({
    count:Number(document.querySelector('[data-acn-role="nav-stat"]').getAttribute('data-acn-count')),
    first:(document.querySelector('[data-acn-role="nav-item-text"]')||{}).textContent||''
  }));
  if (fullA.count !== TOTAL) fail('A enrichment should expose full history', JSON.stringify(fullA));

  // Capture an A-epoch click closure for the A -> B -> A generation test.
  await page.evaluate(() => {
    window.__oldANavItem=document.querySelector('[data-acn-role="nav-item"]');
  });

  // A -> B through native pushState (bypasses patched history). Mutate only one row
  // first: MutationObserver detects the new URL, but old A ids are still present.
  await page.evaluate(secondId => {
    window.__probe.nativePushState({}, '', '/c/' + secondId);
    window.__probe.mutateOne('Second conversation: ', 'msg-b-');
  }, B);

  await page.waitForFunction(() => {
    var stat=document.querySelector('[data-acn-role="nav-stat"]');
    return location.pathname.indexOf('22222222-2222-4222-8222-222222222222')!==-1 &&
      stat && Number(stat.getAttribute('data-acn-count'))===0;
  }, null, { timeout: 3000 });

  const mixed = await page.evaluate(() => ({
    mounted:window.__probe.mounted(),
    items:Array.from(document.querySelectorAll('[data-acn-role="nav-item-text"]'))
      .map(el => (el.textContent||'').trim())
  }));
  if (mixed.items.length) fail('mixed A+B DOM must not populate B', JSON.stringify(mixed));

  // Complete B DOM turnover. B must become usable with 4 DOM prompts before the
  // delayed B API returns.
  await page.evaluate(() => {
    window.__probe.switchConversation('Second conversation: ', 'msg-b-');
  });

  await page.waitForFunction(win => {
    var stat=document.querySelector('[data-acn-role="nav-stat"]');
    var items=Array.from(document.querySelectorAll('[data-acn-role="nav-item-text"]'));
    return stat && Number(stat.getAttribute('data-acn-count'))===win &&
      items.length===win &&
      items.every(el => (el.textContent||'').indexOf('Second conversation: ')===0);
  }, WINDOW, { timeout: 2500 });

  const fastB = await page.evaluate(() => ({
    count:Number(document.querySelector('[data-acn-role="nav-stat"]').getAttribute('data-acn-count')),
    items:Array.from(document.querySelectorAll('[data-acn-role="nav-item-text"]'))
      .map(el => (el.textContent||'').trim())
  }));
  if (fastB.items.some(t => /^Question number /.test(t))) {
    fail('A leaked into B', JSON.stringify(fastB));
  }

  await page.waitForFunction(total => {
    var stat=document.querySelector('[data-acn-role="nav-stat"]');
    var items=Array.from(document.querySelectorAll('[data-acn-role="nav-item-text"]'));
    return stat && Number(stat.getAttribute('data-acn-count'))===total &&
      items.length===total &&
      items.every(el => (el.textContent||'').indexOf('Second conversation: ')===0);
  }, TOTAL, { timeout: 10000 });

  // B -> C: switch URL and DOM completely. C's API is forced to 503, but C must
  // remain immediately usable from DOM and stay usable after the failure.
  await page.evaluate(thirdId => {
    window.__probe.nativePushState({}, '', '/c/' + thirdId);
    window.__probe.switchConversation('Third conversation: ', 'msg-c-');
  }, C);

  await page.waitForFunction(win => {
    var stat=document.querySelector('[data-acn-role="nav-stat"]');
    var items=Array.from(document.querySelectorAll('[data-acn-role="nav-item-text"]'));
    return stat && Number(stat.getAttribute('data-acn-count'))===win &&
      items.length===win &&
      items.every(el => (el.textContent||'').indexOf('Third conversation: ')===0);
  }, WINDOW, { timeout: 2500 });

  await page.waitForTimeout(1200);
  const failedC = await page.evaluate(() => ({
    count:Number(document.querySelector('[data-acn-role="nav-stat"]').getAttribute('data-acn-count')),
    items:Array.from(document.querySelectorAll('[data-acn-role="nav-item-text"]'))
      .map(el => (el.textContent||'').trim()),
    banners:Array.from(document.querySelectorAll('[data-acn-index-status]'))
      .map(el => el.getAttribute('data-acn-index-status'))
  }));

  if (failedC.count !== WINDOW ||
      failedC.items.some(t => t.indexOf('Third conversation: ')!==0)) {
    fail('C must stay usable when full-history API fails', JSON.stringify(failedC));
  }

  // C -> A. Clicking the detached nav row captured from the FIRST A lifecycle must
  // be rejected even though the URL id is A again.
  await page.evaluate(firstId => {
    window.__probe.nativePushState({}, '', '/c/' + firstId);
    window.__probe.switchConversation('', 'msg-a-');
  }, A);

  await page.waitForFunction(win => {
    var stat=document.querySelector('[data-acn-role="nav-stat"]');
    return stat && Number(stat.getAttribute('data-acn-count'))===win;
  }, WINDOW, { timeout: 2500 });

  await page.evaluate(() => {
    if (window.__oldANavItem) window.__oldANavItem.click();
  });

  await page.waitForTimeout(100);
  const aba = await page.evaluate(() => {
    var toast=document.getElementById('acn-toast');
    return toast ? (toast.textContent||'').trim() : '';
  });
  if (aba.indexOf('Conversation changed')===-1) {
    fail('old A lifecycle click closure must be rejected after returning to A', aba);
  }

  if (!process.exitCode) {
    console.log('PASS: ChatGPT DOM-first SPA routing, lazy API enrichment, and failure resilience');
    console.log(JSON.stringify({ fastA, fullA, mixed, fastB, failedC, apiRequests }));
  }

  await browser.close();
})().catch(async err => {
  console.error(err);
  process.exitCode=1;
});
