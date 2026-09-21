'use strict';
var path = require('path');
var http = require('http');
var fs = require('fs');
var { chromium } = require('playwright');

var PORT = 8793;
var ROOT = path.join(__dirname, '..', 'public');

var EXT_TYPES = {
  '.html': 'text/html', '.json': 'application/manifest+json', '.xml': 'application/xml',
  '.txt': 'text/plain', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.png': 'image/png'
};

function startServer() {
  // Mounted under /dzmaster/ to mirror the real GitHub Pages project-page
  // URL -- the pages use root-relative asset paths like /dzmaster/icons/...
  var server = http.createServer(function (req, res) {
    var urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath.indexOf('/dzmaster/') === 0) urlPath = urlPath.slice('/dzmaster'.length);
    if (urlPath === '' || urlPath === '/') urlPath = '/index.html'; // mirror GitHub Pages directory-index behavior
    var filePath = path.join(ROOT, urlPath);
    fs.readFile(filePath, function (err, data) {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      var ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': EXT_TYPES[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise(function (resolve) { server.listen(PORT, function () { resolve(server); }); });
}

var failures = 0, passes = 0;
function ok(cond, msg) { if (cond) { passes++; console.log('  PASS  ' + msg); } else { failures++; console.log('  FAIL  ' + msg); } }

(async function () {
  var server = await startServer();
  var browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true });

  for (var file of ['dzmaster-landing.html', 'dzmaster-landing-en.html', 'dzmaster-privacy.html', 'dzmaster-privacy-en.html']) {
    console.log('\n== ' + file + ' ==');
    var page = await browser.newPage();
    var errors = [];
    page.on('pageerror', function (e) { errors.push(e.message); });
    page.on('console', function (m) { if (m.type() === 'error') errors.push(m.text()); });

    // This sandboxed test environment has no route to the public internet,
    // so the real GoatCounter analytics script (gc.zgo.at, present on the
    // landing pages) can never load here -- stub it out rather than let an
    // environment limitation show up as a false console-error failure.
    await page.route('**://gc.zgo.at/**', function (route) {
      route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    });

    await page.goto('http://localhost:' + PORT + '/dzmaster/' + file, { waitUntil: 'load' });
    ok(true, 'loaded without throwing');

    // Every internal link should point at a file that actually exists in public/.
    var hrefs = await page.$$eval('a[href]', function (as) { return as.map(function (a) { return a.getAttribute('href'); }); });
    var internal = hrefs.filter(function (h) { return h && !h.startsWith('http') && !h.startsWith('#'); });
    var missing = internal.filter(function (h) {
      var clean = h.split('?')[0].split('#')[0];
      return !fs.existsSync(path.join(ROOT, clean));
    });
    ok(missing.length === 0, 'all internal links resolve to existing files' + (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''));

    await page.setViewportSize({ width: 375, height: 800 });
    await page.waitForTimeout(100);
    var overflow = await page.evaluate(function () { return document.documentElement.scrollWidth - document.documentElement.clientWidth; });
    ok(overflow <= 1, 'no horizontal overflow at 375px (' + overflow + 'px)');

    // Regression: the header nav used to cram brand text + nav links onto
    // one un-wrapping flex row, which never triggered horizontal page
    // overflow (the row just squeezed/overlapped instead) but looked
    // broken -- e.g. the "Spustit nástroj"/"Open DZMASTER" CTA pill's text
    // wrapped inside it into an oval blob. A wrapped CTA button is short
    // and wide when its text fits one line; it goes visibly TALLER when
    // the text wraps to two lines. Assert it stays single-line down to a
    // narrow 320px viewport too (smaller than the 375px baseline above).
    await page.setViewportSize({ width: 320, height: 800 });
    await page.waitForTimeout(100);
    var ctaBox = await page.evaluate(function () {
      var el = document.querySelector('nav.top-links a.cta');
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { height: r.height, width: r.width };
    });
    ok(ctaBox && ctaBox.height < 45, 'header CTA button stays single-line (not wrapped) at 320px width (' + (ctaBox ? ctaBox.height.toFixed(1) + 'px tall' : 'not found') + ')');
    var overflow320 = await page.evaluate(function () { return document.documentElement.scrollWidth - document.documentElement.clientWidth; });
    ok(overflow320 <= 1, 'no horizontal overflow at 320px either (' + overflow320 + 'px)');

    // Regression: the footer used to be plain inline text + "· <a>" links
    // with no wrap control, so at narrow widths the browser would break
    // lines in the middle of a link's text (e.g. "O" / "nástroji" split
    // across two rows) or leave an orphaned "·" dangling at a line break.
    // Each logical segment is now its own ".fitem" flex item with
    // white-space:nowrap, so wrapping can only happen BETWEEN items, never
    // inside one. Assert every .fitem stays single-line at 320px. (The
    // footer no longer has a donate/coffee-link pill -- it was removed in
    // favor of the preset-unlock model -- so there's nothing to exclude
    // here any more.)
    var fitemHeights = await page.evaluate(function () {
      return Array.prototype.map.call(document.querySelectorAll('footer .fitem'), function (el) {
        return el.getBoundingClientRect().height;
      });
    });
    ok(fitemHeights.length > 0, 'footer has plain .fitem segments (' + fitemHeights.length + ' found)');
    var wrappedFitems = fitemHeights.filter(function (h) { return h > 22; });
    ok(wrappedFitems.length === 0, 'no footer segment wraps internally at 320px (heights: ' + fitemHeights.map(function (h) { return h.toFixed(1); }).join(', ') + ')');

    var footerHasDonate = await page.evaluate(function () { return !!document.querySelector('footer .fitem.donate, footer .donate'); });
    ok(footerHasDonate === false, 'the old donate/coffee link no longer exists in the footer');

    var footerOverflow320 = await page.evaluate(function () { return document.documentElement.scrollWidth - document.documentElement.clientWidth; });
    ok(footerOverflow320 <= 1, 'no horizontal overflow from footer at 320px (' + footerOverflow320 + 'px)');
    await page.setViewportSize({ width: 375, height: 800 });

    ok(errors.length === 0, 'no console errors' + (errors.length ? (':\n    ' + errors.join('\n    ')) : ''));
    await page.close();
  }

  console.log('\n== index.html redirect ==');
  var redirectPage = await browser.newPage();
  await redirectPage.goto('http://localhost:' + PORT + '/dzmaster/', { waitUntil: 'load' });
  await redirectPage.waitForTimeout(200);
  var landedUrl = redirectPage.url();
  ok(landedUrl.indexOf('dzmaster-landing.html') !== -1, 'GET /dzmaster/ (root) redirects to dzmaster-landing.html (landed on ' + landedUrl + ')');
  var visibleH1 = await redirectPage.textContent('.hero h1').catch(function () { return null; });
  ok(!!visibleH1, 'after redirect, the actual landing page content is visible, not stuck on the redirect stub');
  await redirectPage.close();

  await browser.close();
  server.close();
  console.log('\n' + '='.repeat(50));
  console.log(passes + ' passed, ' + failures + ' failed');
  process.exit(failures > 0 ? 1 : 0);
})().catch(function (e) { console.error('CRASH', e); process.exit(1); });
