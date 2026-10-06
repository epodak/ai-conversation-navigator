/**
 * Regression probe for ChatGPT's 2026 virtualized, column-reverse timeline.
 *
 * Gates three properties that the static ChatGPT fixture cannot exercise:
 *   1. the navigator accumulates prompts across recycled DOM windows;
 *   2. stable message identity prevents same-window recycling from corrupting entries;
 *   3. clicking an unmounted harvested prompt pages the virtualizer until it remounts.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const USERSCRIPT = fs.readFileSync(path.join(ROOT, 'ai-conversation-navigator.user.js'), 'utf8');

const html = String.raw\`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>ChatGPT virtualized timeline probe</title>
<style>
  html, body { margin: 0; height: 100%; background: #212121; color: #eee; }
  [data-app-action-timeline-scroll] {
    height: 620px;
    overflow-y: auto;
    display: flex;
    flex-direction: column-reverse;
    border: 1px solid #444;
  }
  #spacer { height: 7440px; flex: 0 0 auto; position: relative; }
  #mount { position: sticky; top: 0; min-height: 320px; }
  article { min-height: 60px; padding: 8px; }
</style>
</head>
<body>
<main>
  <div data-app-action-timeline-scroll id="timeline">
    <div id="spacer"><div id="mount"></div></div>
  </div>
</main>
<script>
(function () {
  var TOTAL = 24;
  var WINDOW = 4;
  var scroller = document.getElementById('timeline');
  var mount = document.getElementById('mount');

  // The probe tests ACN's virtualizer bridge, not browser geometry after arrival.
  // Keeping scrollIntoView inert preserves the resolved target marker for assertion.
  Element.prototype.scrollIntoView = function () {};

  function makeTurn(questionNo) {
    var article = document.createElement('article');
    var turnNo = questionNo * 2 - 1;
    article.setAttribute('data-testid', 'conversation-turn-' + turnNo);
    article.setAttribute('data-turn', 'user');
    article.setAttribute('data-turn-id', 'turn-user-' + questionNo);

    var msg = document.createElement('div');
    msg.setAttribute('data-message-author-role', 'user');
    msg.setAttribute('data-message-id', 'msg-user-' + questionNo);
    msg.textContent = 'Question number ' + questionNo + ' about virtual scrolling';
    article.appendChild(msg);
    return article;
  }

  function render() {
    var max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    var frac = Math.min(1, Math.abs(scroller.scrollTop) / max);
    // bottom => newest window; most-negative => oldest window
    var newestStart = TOTAL - WINDOW;
    var start = Math.round(newestStart * (1 - frac));
    start = Math.max(0, Math.min(newestStart, start));

    var frag = document.createDocumentFragment();
    for (var i = start + 1; i <= start + WINDOW; i++) {
      frag.appendChild(makeTurn(i));
    }
    mount.replaceChildren(frag);
    document.body.setAttribute('data-probe-window', String(start + 1) + '-' + String(start + WINDOW));
  }

  scroller.addEventListener('scroll', render, { passive: true });
  window.__probe = {
    total: TOTAL,
    render: render,
    mounted: function () {
      return Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
        .map(function (el) { return el.textContent.trim(); });
    }
  };
  render();
})();
</script>
</body>
</html>\`;

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

  await page.route('https://chatgpt.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: html
  }));

  await page.goto('https://chatgpt.com/c/virtual-probe', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: USERSCRIPT });

  await page.waitForSelector('[data-acn-role="nav-trigger"]', { timeout: 10000 });
  await page.click('[data-acn-role="nav-trigger"]');
  await page.waitForSelector('[data-acn-role="nav-panel"][data-acn-open="true"]', { timeout: 5000 });

  await page.waitForFunction(() => {
    var st = document.querySelector('[data-acn-role="nav-stat"]');
    return st && Number(st.getAttribute('data-acn-count')) >= 4;
  }, null, { timeout: 8000 });

  const initial = await page.getAttribute('[data-acn-role="nav-stat"]', 'data-acn-count');
  if (Number(initial) !== 4) fail('initial virtual window should expose exactly 4 prompts', initial);

  // Visit six evenly-spaced reverse-scroll windows. With a 4-turn mount window
  // over 24 turns this covers the full conversation without ever mounting it all.
  for (const frac of [0.2, 0.4, 0.6, 0.8, 1.0]) {
    await page.evaluate(f => {
      var s = document.querySelector('[data-app-action-timeline-scroll]');
      var max = s.scrollHeight - s.clientHeight;
      s.scrollTop = -max * f;
    }, frac);
    await page.waitForTimeout(750);
  }

  await page.waitForFunction(() => {
    var st = document.querySelector('[data-acn-role="nav-stat"]');
    return st && Number(st.getAttribute('data-acn-count')) >= 24;
  }, null, { timeout: 8000 });

  const harvested = await page.getAttribute('[data-acn-role="nav-stat"]', 'data-acn-count');
  if (Number(harvested) !== 24) fail('navigator should retain all harvested prompts', harvested);

  // Return to bottom so Q1 is definitely unmounted, then click its cached nav row.
  await page.evaluate(() => {
    document.querySelector('[data-app-action-timeline-scroll]').scrollTop = 0;
  });
  await page.waitForTimeout(700);

  const q1MountedBefore = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
      .some(el => /Question number 1\b/.test(el.textContent))
  );
  if (q1MountedBefore) fail('Q1 must be unmounted before jump');

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
  if (!clicked) fail('Q1 navigator item missing after harvesting');

  await page.waitForFunction(() => {
    var el = document.querySelector('[data-acn-jump-target="true"]');
    return el && /Question number 1\b/.test(el.textContent || '');
  }, null, { timeout: 12000 });

  const result = await page.evaluate(() => {
    var el = document.querySelector('[data-acn-jump-target="true"]');
    var stat = document.querySelector('[data-acn-role="nav-stat"]');
    var scroller = document.querySelector('[data-app-action-timeline-scroll]');
    return {
      resolvedText: el ? el.textContent.trim() : null,
      count: stat ? Number(stat.getAttribute('data-acn-count')) : null,
      scrollTop: scroller ? scroller.scrollTop : null,
      window: document.body.getAttribute('data-probe-window')
    };
  });

  if (!result.resolvedText || !/Question number 1\b/.test(result.resolvedText)) {
    fail('jump resolved the wrong recycled node', JSON.stringify(result));
  }
  if (result.count !== 24) fail('jump must not discard harvested history', JSON.stringify(result));
  if (!(result.scrollTop < 0)) fail('jump should page upward in reverse coordinates', JSON.stringify(result));

  if (!process.exitCode) {
    console.log('PASS: ChatGPT virtualized navigator retained 24 prompts and remounted Q1');
    console.log(JSON.stringify(result));
  }

  await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
