/* Headless-browser end-to-end test of dzmaster.html using Playwright/Chromium.
 * Verifies the ACTUAL page (worker construction, DOM wiring, i18n, download
 * link) works in a real browser engine, not just that the engine module
 * passes its own Node unit tests.
 */
'use strict';
var path = require('path');
var http = require('http');
var fs = require('fs');
var { chromium } = require('playwright');

var PORT = 8791;
var ROOT = path.join(__dirname, '..', 'public');

var EXT_TYPES = {
  '.html': 'text/html', '.json': 'application/manifest+json', '.xml': 'application/xml',
  '.txt': 'text/plain', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.png': 'image/png'
};

function startServer() {
  // Mounted under /dzmaster/ to mirror the real GitHub Pages project-page
  // URL (https://synthreviews.github.io/dzmaster/...) -- the page uses
  // root-relative asset paths like /dzmaster/icons/... that only resolve
  // correctly with this prefix in place, same as production.
  var server = http.createServer(function (req, res) {
    var urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath.indexOf('/dzmaster/') === 0) urlPath = urlPath.slice('/dzmaster'.length);
    var filePath = path.join(ROOT, urlPath);
    fs.readFile(filePath, function (err, data) {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      var ext = path.extname(filePath);
      var type = EXT_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    });
  });
  return new Promise(function (resolve) {
    server.listen(PORT, function () { resolve(server); });
  });
}

var failures = 0, passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}

(async function main() {
  var server = await startServer();
  var browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true });
  var page = await browser.newPage();

  var consoleErrors = [];
  page.on('console', function (msg) { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', function (err) { consoleErrors.push('pageerror: ' + err.message); });

  // This sandboxed test environment has no route to the public internet,
  // so the real GoatCounter analytics script (gc.zgo.at) can never load
  // here -- that's an environment limitation, not a bug in the page. Stub
  // it out with an empty, successfully-loading script so the page behaves
  // exactly as it would for a real visitor whose ad-blocker or network
  // also happens to block analytics (something the page must already
  // tolerate gracefully), without polluting the console-error assertions
  // below with a network failure that has nothing to do with dzmaster.html
  // itself.
  await page.route('**://gc.zgo.at/**', function (route) {
    route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
  });

  console.log('\n== Loading page ==');
  await page.goto('http://localhost:' + PORT + '/dzmaster/dzmaster.html', { waitUntil: 'load' });
  ok(true, 'page loaded without throwing');

  var title = await page.title();
  ok(title.indexOf('DZMASTER') !== -1, 'page title set correctly (' + title + ')');

  console.log('\n== Language toggle ==');
  // NOTE: not asserting a specific *default* href here -- initLang() picks
  // the starting language from navigator.language when nothing else says
  // otherwise, and Playwright's default locale is en-US, so the "default"
  // language in this harness legitimately varies. What matters (and is
  // checked below) is that the home button always tracks whichever
  // language is actually active after an explicit switch.
  await page.click('#lang-en');
  var h1Text = await page.textContent('.hero h1');
  ok(h1Text.indexOf('browser') !== -1, 'switching to EN updates visible text (' + h1Text.trim() + ')');
  var homeHrefEn = await page.getAttribute('#home-link', 'href');
  ok(homeHrefEn === 'https://synthreviews.github.io/dzmaster/dzmaster-landing-en.html',
    'home button switches to the EN landing page in EN mode (' + homeHrefEn + ')');
  await page.click('#lang-cs');
  var h1Text2 = await page.textContent('.hero h1');
  ok(h1Text2.indexOf('prohlížeči') !== -1, 'switching back to CS updates visible text');
  var homeHrefCs = await page.getAttribute('#home-link', 'href');
  ok(homeHrefCs === 'https://synthreviews.github.io/dzmaster/dzmaster-landing.html',
    'home button switches back to the CZ landing page in CS mode (' + homeHrefCs + ')');

  console.log('\n== "How to prepare a track" guide section ==');
  var guideOpenInitially = await page.evaluate(function () { return document.getElementById('guide-details').open; });
  ok(!guideOpenInitially, 'guide section is collapsed by default (keeps the top of the page focused on uploading)');
  var guideSectionCountBefore = await page.$$eval('.guide-section', function (els) { return els.length; });
  ok(guideSectionCountBefore === 5, 'guide has all 5 sub-sections in the DOM even while collapsed (' + guideSectionCountBefore + ')');

  await page.click('#guide-details summary');
  var guideOpenAfterClick = await page.evaluate(function () { return document.getElementById('guide-details').open; });
  ok(guideOpenAfterClick, 'clicking the summary opens the guide section');
  var guideTextCs = await page.textContent('#guide-details .guide-body');
  ok(guideTextCs.indexOf('mastering') !== -1 || guideTextCs.indexOf('masteringem') !== -1,
    'guide shows real CZ content once opened');
  ok(guideTextCs.indexOf('−14 LUFS') === -1, 'guide is prose, not a re-statement of the raw preset numbers');

  await page.click('#lang-en');
  var guideTextEn = await page.textContent('#guide-details .guide-body');
  ok(guideTextEn.indexOf('mastering') !== -1, 'guide content is translated in EN mode');
  ok(guideTextEn !== guideTextCs, 'EN guide text actually differs from the CZ text (translation applied, not left stale)');
  await page.click('#lang-cs');

  console.log('\n== Synthetic WAV generation + upload via real <input type=file> ==');
  // Build a real WAV file INSIDE the browser context (independent of our
  // Node encodeWav implementation, so this is a true cross-check) and hand
  // it to the actual file input the way a user's OS file picker would.
  var wavBase64 = await page.evaluate(function () {
    function writeWav(sampleRate, seconds, freq) {
      var n = Math.floor(sampleRate * seconds);
      var buffer = new ArrayBuffer(44 + n * 2 * 2); // stereo 16-bit
      var view = new DataView(buffer);
      function ws(o, s) { for (var i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }
      ws(0, 'RIFF'); view.setUint32(4, 36 + n * 4, true); ws(8, 'WAVE');
      ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
      view.setUint16(22, 2, true); view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
      ws(36, 'data'); view.setUint32(40, n * 4, true);
      var off = 44;
      for (var i = 0; i < n; i++) {
        var v = 0.12 * Math.sin(2 * Math.PI * freq * i / sampleRate);
        var s = Math.max(-1, Math.min(1, v));
        var iv = Math.round(s * 32767);
        view.setInt16(off, iv, true); off += 2;
        view.setInt16(off, iv, true); off += 2;
      }
      return buffer;
    }
    var buf = writeWav(44100, 4, 440); // 4 seconds, 440Hz, -18ish dBFS
    var bytes = new Uint8Array(buf);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  });

  var wavPath = '/tmp/e2e-test-tone.wav';
  fs.writeFileSync(wavPath, Buffer.from(wavBase64, 'base64'));

  var fileInput = await page.$('#file-input');
  await fileInput.setInputFiles(wavPath);
  await page.waitForTimeout(300);

  var fileInfoVisible = await page.isVisible('#file-info');
  ok(fileInfoVisible, 'file-info panel shows after selecting a valid WAV');
  var fname = await page.textContent('#file-name');
  ok(fname.indexOf('e2e-test-tone.wav') !== -1, 'selected filename displayed correctly (' + fname + ')');

  var processDisabled = await page.getAttribute('#process-btn', 'disabled');
  ok(processDisabled === null, 'process button becomes enabled once a valid file is selected');

  console.log('\n== Free-tier usage limit (mocked backend) ==');
  // Exercises the REAL checkUsageAllowed() code path in dzmaster.html
  // against a mocked endpoint -- window.DZMASTER_USAGE_API_URL_OVERRIDE is
  // a test-only hook (see dzmaster.html) that is never set in production.
  var FAKE_USAGE_URL = 'https://fake-usage-api.dzmaster.test/check';
  var usageRouteMode = { value: 'allow' };
  await page.route(FAKE_USAGE_URL, function (route) {
    if (usageRouteMode.value === 'allow') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ allowed: true }) });
    } else if (usageRouteMode.value === 'deny') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ allowed: false }) });
    }
    // 'error' mode: deliberately never call fulfill/abort/continue, so the
    // request just hangs -- this exercises the client's own 6s
    // AbortController timeout (a realistic "backend is unreachable"
    // scenario) rather than an immediate network refusal, which would
    // also log an (expected, but noisy) console error unrelated to any
    // real bug in the page.
  });
  await page.addInitScript(function (url) {
    window.DZMASTER_USAGE_API_URL_OVERRIDE = url;
  }, FAKE_USAGE_URL);

  usageRouteMode.value = 'allow';
  await page.reload({ waitUntil: 'load' });
  var fileInputUsage1 = await page.$('#file-input');
  await fileInputUsage1.setInputFiles(wavPath);
  await page.waitForSelector('.file-info', { state: 'visible' });
  await page.click('#process-btn');
  await page.waitForSelector('#results.show', { timeout: 20000 });
  var usagePresetText = await page.textContent('#stat-preset');
  ok(usagePresetText.indexOf('Smart Auto') !== -1, 'usage check allowing the request lets the free Smart Auto master complete (' + usagePresetText + ')');

  usageRouteMode.value = 'deny';
  await page.reload({ waitUntil: 'load' });
  var fileInputUsage2 = await page.$('#file-input');
  await fileInputUsage2.setInputFiles(wavPath);
  await page.waitForSelector('.file-info', { state: 'visible' });
  await page.click('#process-btn');
  await page.waitForSelector('#usage-limit-box:not([hidden])', { timeout: 5000 });
  ok(true, 'monthly limit reached (mocked deny) shows the usage-limit message');
  var progressShownAfterDeny = await page.getAttribute('#progress', 'class');
  ok(progressShownAfterDeny.indexOf('show') === -1, 'processing does not start when the usage check denies it');
  var processBtnAfterDeny = await page.getAttribute('#process-btn', 'disabled');
  ok(processBtnAfterDeny === null, 'process button is re-enabled after a denied check so the visitor can unlock and retry');

  usageRouteMode.value = 'error';
  await page.reload({ waitUntil: 'load' });
  var fileInputUsage3 = await page.$('#file-input');
  await fileInputUsage3.setInputFiles(wavPath);
  await page.waitForSelector('.file-info', { state: 'visible' });
  await page.click('#process-btn');
  await page.waitForSelector('#results.show', { timeout: 20000 });
  ok(true, 'usage check failing open on a network error still lets a legitimate visitor master their track');

  await page.unroute(FAKE_USAGE_URL);

  console.log('\n== Preset lock / unlock ==');
  var lockedCountBefore = await page.$$eval('.preset.locked', function (els) { return els.length; });
  ok(lockedCountBefore === 9, 'all 9 non-Smart-Auto presets start locked (' + lockedCountBefore + ')');
  var smartLockedBefore = await page.getAttribute('.preset[data-preset="smart"]', 'class');
  ok(smartLockedBefore.indexOf('locked') === -1, 'Smart Auto itself is never locked');

  await page.click('.preset[data-preset="streaming"]');
  var streamingClassLocked = await page.getAttribute('.preset[data-preset="streaming"]', 'class');
  ok(streamingClassLocked.indexOf('selected') === -1, 'clicking a locked preset does not select it');
  var smartStillSelected = await page.getAttribute('.preset[data-preset="smart"]', 'class');
  ok(smartStillSelected.indexOf('selected') !== -1, 'Smart Auto stays selected after clicking a locked preset');

  var gumroadHref = await page.getAttribute('#unlock-gumroad-link', 'href');
  ok(gumroadHref === 'https://uklidnito.gumroad.com/l/dzmaster', 'unlock box links to the real Gumroad product (' + gumroadHref + ')');

  await page.fill('#unlock-input', 'totally-wrong-code');
  await page.click('#unlock-form button[type="submit"]');
  await page.waitForSelector('#unlock-error:not([hidden])', { timeout: 5000 });
  ok(true, 'wrong code shows an error message');
  var stillLockedAfterWrong = await page.$$eval('.preset.locked', function (els) { return els.length; });
  ok(stillLockedAfterWrong === 9, 'wrong code leaves all presets locked (' + stillLockedAfterWrong + ')');

  await page.fill('#unlock-input', 'dzmaster309@synthlucidamusic');
  await page.click('#unlock-form button[type="submit"]');
  await page.waitForSelector('#unlock-success:not([hidden])', { timeout: 5000 });
  ok(true, 'correct code shows a success message');
  var lockedCountAfter = await page.$$eval('.preset.locked', function (els) { return els.length; });
  ok(lockedCountAfter === 0, 'correct code unlocks every preset (' + lockedCountAfter + ' still locked)');
  var unlockBoxClass = await page.getAttribute('#unlock-box', 'class');
  ok(unlockBoxClass.indexOf('is-unlocked') !== -1, 'unlock box switches to its unlocked state');

  var persistedFlag = await page.evaluate(function () { return localStorage.getItem('dzmaster_unlocked'); });
  ok(persistedFlag === '1', 'unlock state is persisted to localStorage so it survives a reload (' + persistedFlag + ')');

  await page.reload({ waitUntil: 'load' });
  var lockedAfterReload = await page.$$eval('.preset.locked', function (els) { return els.length; });
  ok(lockedAfterReload === 0, 'presets stay unlocked after a page reload (' + lockedAfterReload + ')');

  // Re-select the file (a fresh page load resets the upload state) before
  // moving on to actually processing a track with a previously-locked preset.
  var fileInputAfterReload = await page.$('#file-input');
  await fileInputAfterReload.setInputFiles(wavPath);
  await page.waitForSelector('.file-info', { state: 'visible' });

  console.log('\n== Selecting Streaming preset and processing (now unlocked) ==');
  await page.click('.preset[data-preset="streaming"]');
  var selectedClass = await page.getAttribute('.preset[data-preset="streaming"]', 'class');
  ok(selectedClass.indexOf('selected') !== -1, 'Streaming preset visually selected on click once unlocked');

  await page.click('#process-btn');
  await page.waitForSelector('#results.show', { timeout: 20000 });
  ok(true, 'results panel appeared within timeout (worker round-trip completed)');

  var statusText = await page.textContent('#status-line');
  ok(statusText.indexOf('Hotovo') !== -1, 'status line shows completion message (' + statusText + ')');

  var lufsAfter = await page.textContent('#stat-lufs-after');
  ok(/-14\.\d LUFS/.test(lufsAfter), 'streaming preset hits -14 LUFS target in real-browser run (' + lufsAfter + ')');

  var peakAfter = await page.textContent('#stat-peak-after');
  var peakVal = parseFloat(peakAfter);
  ok(peakVal <= -0.9, 'true peak after mastering respects the -1dBTP ceiling in real-browser run (' + peakAfter + ')');

  var downloadHref = await page.getAttribute('#download-link', 'href');
  ok(downloadHref && downloadHref.indexOf('blob:') === 0, 'download link is a valid blob: URL (' + downloadHref + ')');

  var audioSrc = await page.getAttribute('#preview-audio', 'src');
  ok(audioSrc && audioSrc.indexOf('blob:') === 0, 'preview <audio> element got a playable blob source');

  // Verify the downloaded blob is actually a well-formed, non-trivial WAV.
  var blobInfo = await page.evaluate(async function (url) {
    var resp = await fetch(url);
    var buf = await resp.arrayBuffer();
    var view = new DataView(buf);
    var riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    return { byteLength: buf.byteLength, riff: riff };
  }, downloadHref);
  ok(blobInfo.riff === 'RIFF', 'downloaded blob has a valid RIFF header');
  ok(blobInfo.byteLength > 44 + 4 * 44100 * 4 * 0.9, 'downloaded WAV has plausible audio data size (' + blobInfo.byteLength + ' bytes)');

  console.log('\n== Before/After A/B preview toggle ==');
  var afterSelectedByDefault = await page.getAttribute('#ab-after', 'class');
  var beforeSelectedByDefault = await page.getAttribute('#ab-before', 'class');
  ok(afterSelectedByDefault.indexOf('selected') !== -1 && beforeSelectedByDefault.indexOf('selected') === -1,
    '"Mastered" is selected by default after processing');

  await page.click('#ab-before');
  await page.waitForTimeout(200);
  var srcBefore = await page.getAttribute('#preview-audio', 'src');
  ok(srcBefore && srcBefore.indexOf('blob:') === 0 && srcBefore !== audioSrc,
    'clicking "Original" swaps the audio source to a different blob: URL (' + srcBefore + ')');
  var beforeBtnClass = await page.getAttribute('#ab-before', 'class');
  var afterBtnClass = await page.getAttribute('#ab-after', 'class');
  ok(beforeBtnClass.indexOf('selected') !== -1 && afterBtnClass.indexOf('selected') === -1,
    '"Original" button becomes visually selected, "Mastered" is deselected');

  var originalBlobInfo = await page.evaluate(async function (url) {
    var resp = await fetch(url);
    var buf = await resp.arrayBuffer();
    var view = new DataView(buf);
    return String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  }, srcBefore);
  ok(originalBlobInfo === 'RIFF', '"Original" preview source is itself a valid, playable WAV (the untouched upload)');

  await page.click('#ab-after');
  await page.waitForTimeout(200);
  var srcAfterAgain = await page.getAttribute('#preview-audio', 'src');
  ok(srcAfterAgain === audioSrc, 'clicking "Mastered" switches back to the mastered blob URL');

  console.log('\n== Advanced (optional) mastering controls ==');
  // Verify the section starts closed and collapsed (hidden under a
  // disclosure), matching the chosen "keep the basic flow simple" design.
  var advOpenInitially = await page.evaluate(function () { return document.getElementById('advanced-details').open; });
  ok(!advOpenInitially, 'Advanced section is collapsed by default');

  await page.click('#advanced-details summary');
  var advOpenAfterClick = await page.evaluate(function () { return document.getElementById('advanced-details').open; });
  ok(advOpenAfterClick, 'clicking the summary opens the Advanced section');

  // Move the sliders and confirm the live value labels track them.
  await page.fill('#adv-bass', '6');
  await page.dispatchEvent('#adv-bass', 'input');
  var bassLabel = await page.textContent('#adv-bass-value');
  ok(bassLabel.indexOf('+6') !== -1, 'bass slider value label updates live (' + bassLabel + ')');

  await page.fill('#adv-width', '150');
  await page.dispatchEvent('#adv-width', 'input');
  var widthLabel = await page.textContent('#adv-width-value');
  ok(widthLabel.indexOf('150%') !== -1, 'stereo width slider value label updates live (' + widthLabel + ')');

  await page.fill('#adv-saturation', '70');
  await page.dispatchEvent('#adv-saturation', 'input');
  var saturationLabel = await page.textContent('#adv-saturation-value');
  ok(saturationLabel.indexOf('70%') !== -1, 'saturation slider value label updates live (' + saturationLabel + ')');

  var multibandInitiallyUnchecked = await page.evaluate(function () { return document.getElementById('adv-multiband').checked; });
  ok(!multibandInitiallyUnchecked, 'multiband checkbox starts unchecked');
  await page.check('#adv-multiband');
  var multibandChecked = await page.evaluate(function () { return document.getElementById('adv-multiband').checked; });
  ok(multibandChecked, 'multiband checkbox can be checked');

  var bassMonoInitiallyUnchecked = await page.evaluate(function () { return document.getElementById('adv-bassmono').checked; });
  ok(!bassMonoInitiallyUnchecked, 'bass-mono checkbox starts unchecked');
  await page.check('#adv-bassmono');
  var bassMonoChecked = await page.evaluate(function () { return document.getElementById('adv-bassmono').checked; });
  ok(bassMonoChecked, 'bass-mono checkbox can be checked');

  // Build a WAV with real silence padding at both ends so trimming has
  // something genuine to report -- otherwise "trims nothing" is trivially
  // true and proves nothing.
  var paddedWavBase64 = await page.evaluate(function () {
    function writeWav(sampleRate, silenceSec, toneSec, freq) {
      var n = Math.floor(sampleRate * (silenceSec * 2 + toneSec));
      var buffer = new ArrayBuffer(44 + n * 2 * 2);
      var view = new DataView(buffer);
      function ws(o, s) { for (var i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }
      ws(0, 'RIFF'); view.setUint32(4, 36 + n * 4, true); ws(8, 'WAVE');
      ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
      view.setUint16(22, 2, true); view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
      ws(36, 'data'); view.setUint32(40, n * 4, true);
      var off = 44;
      var toneStart = Math.floor(sampleRate * silenceSec);
      var toneEnd = toneStart + Math.floor(sampleRate * toneSec);
      for (var i = 0; i < n; i++) {
        var v = 0;
        if (i >= toneStart && i < toneEnd) v = 0.5 * Math.cos(2 * Math.PI * freq * i / sampleRate);
        var iv = Math.round(v * 32767);
        view.setInt16(off, iv, true); off += 2;
        view.setInt16(off, iv, true); off += 2;
      }
      return buffer;
    }
    var buf = writeWav(44100, 0.5, 2, 440); // 0.5s silence, 2s tone, 0.5s silence
    var bytes = new Uint8Array(buf);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  });
  var paddedWavPath = '/tmp/e2e-test-tone-padded.wav';
  fs.writeFileSync(paddedWavPath, Buffer.from(paddedWavBase64, 'base64'));

  await page.click('#file-clear');
  var fileInputPadded = await page.$('#file-input');
  await fileInputPadded.setInputFiles(paddedWavPath);
  await page.waitForTimeout(300);
  await page.check('#adv-trim');

  await page.click('#process-btn');
  await page.waitForSelector('#results.show', { timeout: 20000 });
  var techHtml = await page.innerHTML('#tech-details');
  var techHtmlLower = techHtml.toLowerCase();
  ok(techHtmlLower.indexOf('trim') !== -1 || techHtmlLower.indexOf('oříznuto') !== -1,
    'technical details report the silence that was trimmed (' + techHtml + ')');

  var consoleErrorsAfterAdvanced = consoleErrors.length;
  ok(consoleErrorsAfterAdvanced === 0, 'no console errors after using the Advanced controls (EQ + width + bass-mono + multiband + saturation + trim) together');

  await page.uncheck('#adv-trim');
  await page.click('#adv-reset');
  var resetBassLabel = await page.textContent('#adv-bass-value');
  var resetWidthLabel = await page.textContent('#adv-width-value');
  var resetSaturationLabel = await page.textContent('#adv-saturation-value');
  var resetTrimChecked = await page.evaluate(function () { return document.getElementById('adv-trim').checked; });
  var resetMultibandChecked = await page.evaluate(function () { return document.getElementById('adv-multiband').checked; });
  var resetBassMonoChecked = await page.evaluate(function () { return document.getElementById('adv-bassmono').checked; });
  ok(resetBassLabel.indexOf('0 dB') !== -1, '"Reset to defaults" restores the bass slider to 0dB (' + resetBassLabel + ')');
  ok(resetWidthLabel.indexOf('100%') !== -1, '"Reset to defaults" restores stereo width to 100% (' + resetWidthLabel + ')');
  ok(resetSaturationLabel.indexOf('0%') !== -1, '"Reset to defaults" restores the saturation slider to 0% (' + resetSaturationLabel + ')');
  ok(resetTrimChecked === false, '"Reset to defaults" leaves the trim-silence checkbox unchecked');
  ok(resetMultibandChecked === false, '"Reset to defaults" leaves the multiband checkbox unchecked');
  ok(resetBassMonoChecked === false, '"Reset to defaults" leaves the bass-mono checkbox unchecked');

  console.log('\n== Invalid file rejection ==');
  var badPath = '/tmp/e2e-not-a-wav.txt';
  fs.writeFileSync(badPath, 'this is definitely not a wav file');
  await page.click('#file-clear');
  var fileInput2 = await page.$('#file-input');
  await fileInput2.setInputFiles(badPath);
  await page.waitForTimeout(300);
  var errStatus = await page.textContent('#status-line');
  ok(errStatus.indexOf('nevypadá jako WAV') !== -1, 'non-WAV file is rejected with a friendly CZ error message (' + errStatus + ')');
  var stillDisabled = await page.getAttribute('#process-btn', 'disabled');
  ok(stillDisabled !== null, 'process button stays disabled after invalid file rejection');

  console.log('\n== RELAXPLAYER cross-promo banner ==');
  var promoHref = await page.getAttribute('#promo-banner .promo-cta', 'href');
  ok(promoHref === 'https://relaxplayer.eu', 'promo banner CTA links to relaxplayer.eu (' + promoHref + ')');
  var promoTarget = await page.getAttribute('#promo-banner .promo-cta', 'target');
  ok(promoTarget === '_blank', 'promo banner opens relaxplayer.eu in a new tab');
  var promoRel = await page.getAttribute('#promo-banner .promo-cta', 'rel');
  ok(promoRel && promoRel.indexOf('noopener') !== -1, 'promo banner link uses rel="noopener" (' + promoRel + ')');

  console.log('\n== Mobile responsiveness (375px viewport) ==');
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(150);
  var overflow = await page.evaluate(function () {
    return document.documentElement.scrollWidth - document.documentElement.clientWidth;
  });
  ok(overflow <= 1, 'no horizontal overflow at 375px width (scrollWidth - clientWidth = ' + overflow + 'px)');
  var presetGridCols = await page.evaluate(function () {
    return getComputedStyle(document.getElementById('presets')).gridTemplateColumns.split(' ').length;
  });
  ok(presetGridCols === 1, 'preset grid collapses to a single column on mobile (found ' + presetGridCols + ')');

  // Guide section stays overflow-safe when opened at a narrow width too --
  // it's mostly prose (long sentences, no fixed-width elements), which is
  // exactly the kind of content that silently causes horizontal overflow
  // if a long word or URL-like string forces the box wider than the
  // viewport.
  var guideWasOpen = await page.evaluate(function () { return document.getElementById('guide-details').open; });
  if (!guideWasOpen) await page.click('#guide-details summary');
  await page.waitForTimeout(100);
  var overflowWithGuideOpen = await page.evaluate(function () {
    return document.documentElement.scrollWidth - document.documentElement.clientWidth;
  });
  ok(overflowWithGuideOpen <= 1, 'no horizontal overflow at 375px with the guide section open (' + overflowWithGuideOpen + 'px)');

  // Regression: the footer used to be plain inline text + "· <a>" links with
  // no wrap control, so at narrow widths the browser would break lines in
  // the middle of a link's text or leave an orphaned "·" dangling at a line
  // break. Each logical segment is now its own ".fitem" flex item with
  // white-space:nowrap, so wrapping can only happen BETWEEN items.
  await page.setViewportSize({ width: 320, height: 800 });
  await page.waitForTimeout(150);
  var fitemHeights = await page.evaluate(function () {
    return Array.prototype.map.call(document.querySelectorAll('footer .fitem'), function (el) {
      return el.getBoundingClientRect().height;
    });
  });
  ok(fitemHeights.length > 0, 'footer has plain .fitem segments (' + fitemHeights.length + ' found)');
  var wrappedFitems = fitemHeights.filter(function (h) { return h > 22; });
  ok(wrappedFitems.length === 0, 'no footer segment wraps internally at 320px (heights: ' + fitemHeights.map(function (h) { return h.toFixed(1); }).join(', ') + ')');

  var footerHasDonate = await page.evaluate(function () { return !!document.querySelector('footer .fitem.donate'); });
  ok(footerHasDonate === false, 'the old donate/coffee link no longer exists in the footer');

  var footerOverflow320 = await page.evaluate(function () { return document.documentElement.scrollWidth - document.documentElement.clientWidth; });
  ok(footerOverflow320 <= 1, 'no horizontal overflow from footer at 320px (' + footerOverflow320 + 'px)');
  await page.setViewportSize({ width: 375, height: 800 });

  console.log('\n== Console error check ==');
  ok(consoleErrors.length === 0, 'no console errors/exceptions occurred during the whole run' + (consoleErrors.length ? (':\n    ' + consoleErrors.join('\n    ')) : ''));

  await browser.close();
  server.close();

  console.log('\n' + '='.repeat(50));
  console.log(passes + ' passed, ' + failures + ' failed');
  process.exit(failures > 0 ? 1 : 0);
})().catch(function (err) {
  console.error('E2E TEST CRASHED:', err);
  process.exit(1);
});
