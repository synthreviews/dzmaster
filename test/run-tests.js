/* DZMASTER engine test suite (Node). Run with: node test/run-tests.js */
'use strict';
var path = require('path');
var Engine = require(path.join(__dirname, '..', 'engine', 'dzmaster-engine.js'));

var failures = 0;
var passes = 0;

function ok(cond, msg) {
  if (cond) {
    passes++;
    console.log('  PASS  ' + msg);
  } else {
    failures++;
    console.log('  FAIL  ' + msg);
  }
}

function section(name) {
  console.log('\n== ' + name + ' ==');
}

function approx(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

function makeSine(freqHz, amp, seconds, sampleRate, numChannels) {
  var n = Math.round(seconds * sampleRate);
  var chans = [];
  for (var c = 0; c < numChannels; c++) chans.push(new Float32Array(n));
  for (var i = 0; i < n; i++) {
    var v = amp * Math.sin(2 * Math.PI * freqHz * i / sampleRate);
    for (var c2 = 0; c2 < numChannels; c2++) chans[c2][i] = v;
  }
  return { sampleRate: sampleRate, numChannels: numChannels, frameCount: n, channels: chans };
}

function makeSilence(seconds, sampleRate, numChannels) {
  var n = Math.round(seconds * sampleRate);
  var chans = [];
  for (var c = 0; c < numChannels; c++) chans.push(new Float32Array(n));
  return { sampleRate: sampleRate, numChannels: numChannels, frameCount: n, channels: chans };
}

function scanForBadSamples(channels) {
  var bad = 0;
  var overOne = 0;
  for (var c = 0; c < channels.length; c++) {
    var chan = channels[c];
    for (var i = 0; i < chan.length; i++) {
      var v = chan[i];
      if (!isFinite(v)) bad++;
      if (Math.abs(v) > 1.0000001) overOne++;
    }
  }
  return { bad: bad, overOne: overOne };
}

// ---------------------------------------------------------------------
section('WAV encode/decode round-trip');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  var src = makeSine(1000, 0.5, 0.5, sr, 2);
  [16, 24].forEach(function (bits) {
    var buf = Engine.encodeWav(src.channels, sr, bits);
    var decoded = Engine.parseWav(buf);
    ok(decoded.sampleRate === sr, bits + '-bit: sample rate preserved');
    ok(decoded.numChannels === 2, bits + '-bit: channel count preserved');
    ok(decoded.frameCount === src.frameCount, bits + '-bit: frame count preserved (' + decoded.frameCount + ' vs ' + src.frameCount + ')');
    var tol = bits === 16 ? 1 / 32000 : 1 / 8000000;
    var maxErr = 0;
    for (var c = 0; c < 2; c++) {
      for (var i = 0; i < src.frameCount; i++) {
        var err = Math.abs(decoded.channels[c][i] - src.channels[c][i]);
        if (err > maxErr) maxErr = err;
      }
    }
    ok(maxErr < tol, bits + '-bit: round-trip quantization error within tolerance (max err ' + maxErr.toFixed(8) + ')');
  });
})();

// ---------------------------------------------------------------------
section('Malformed / edge-case WAV headers');
// ---------------------------------------------------------------------
(function () {
  var threw = false;
  try { Engine.parseWav(new ArrayBuffer(10)); } catch (e) { threw = true; }
  ok(threw, 'tiny buffer throws instead of crashing with an unhandled exception type');

  // data chunk size lies (claims more bytes than actually present) --
  // must clamp instead of reading out of bounds.
  var sr = 44100;
  var good = Engine.encodeWav(makeSine(440, 0.3, 0.05, sr, 1).channels, sr, 16);
  var view = new DataView(good);
  view.setUint32(40, 0xFFFFFF, true); // lie about data chunk size
  var decoded2 = null, threw2 = false;
  try { decoded2 = Engine.parseWav(good); } catch (e) { threw2 = true; }
  ok(!threw2 && decoded2 && decoded2.frameCount > 0, 'oversized data-chunk-size header is clamped, not crashed on');
})();

// ---------------------------------------------------------------------
section('Loudness measurement sanity (sine tones)');
// ---------------------------------------------------------------------
(function () {
  var sr = 48000;
  // A full-scale 1kHz sine has a known relationship to LUFS: roughly
  // -3.0 LUFS relative to dBFS peak for a pure tone through K-weighting
  // (K-weighting has ~+4dB shelf boost around 1-2kHz then rolls in RMS
  // math) -- we don't assert an exact absolute number (that would bake in
  // a "trust me" constant); instead assert monotonic, sane relative
  // behavior, which is what actually matters for the product.
  var quiet = makeSine(1000, 0.1, 2, sr, 2); // -20 dBFS
  var loud = makeSine(1000, 0.5, 2, sr, 2); // -6 dBFS
  var quietLUFS = Engine._internal.integratedLoudness(quiet.channels, sr);
  var loudLUFS = Engine._internal.integratedLoudness(loud.channels, sr);
  ok(isFinite(quietLUFS) && isFinite(loudLUFS), 'integrated loudness is finite for real signals');
  ok(loudLUFS > quietLUFS, 'louder signal measures higher LUFS (' + loudLUFS.toFixed(2) + ' > ' + quietLUFS.toFixed(2) + ')');
  // Doubling amplitude (+6.02dB) should raise measured LUFS by ~6dB.
  ok(approx(loudLUFS - quietLUFS, 20 * Math.log10(5), 0.5),
    'amplitude ratio maps to loudness delta within 0.5dB (delta=' + (loudLUFS - quietLUFS).toFixed(2) + ', expected ~' + (20 * Math.log10(5)).toFixed(2) + ')');

  var silence = makeSilence(2, sr, 2);
  var silLUFS = Engine._internal.integratedLoudness(silence.channels, sr);
  ok(silLUFS === -Infinity, 'digital silence measures as -Infinity LUFS, not NaN (' + silLUFS + ')');
})();

// ---------------------------------------------------------------------
section('Full mastering chain: per-preset LUFS/true-peak targets are met');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  ['streaming', 'apple', 'club', 'broadcast', 'podcast', 'bandcamp', 'vinyl', 'social', 'classical'].forEach(function (presetId) {
    // Moderately dynamic program-like material: mix of two sines to avoid
    // a degenerate single-tone edge case, at a middling starting level.
    var n = Math.round(3 * sr);
    var chans = [new Float32Array(n), new Float32Array(n)];
    for (var i = 0; i < n; i++) {
      var v = 0.2 * Math.sin(2 * Math.PI * 220 * i / sr) + 0.1 * Math.sin(2 * Math.PI * 4400 * i / sr);
      chans[0][i] = v;
      chans[1][i] = v * 0.95;
    }
    var decoded = { sampleRate: sr, numChannels: 2, frameCount: n, channels: chans };
    var result = Engine.master(decoded, presetId);
    var target = Engine._internal.resolvePreset(presetId, result.input.crestFactorDb);

    ok(approx(result.output.lufs, target.targetLUFS, 0.6),
      presetId + ': output LUFS ' + result.output.lufs.toFixed(2) + ' within 0.6dB of target ' + target.targetLUFS);
    ok(result.output.truePeakDb <= target.ceilingDbTP + 0.05,
      presetId + ': output true peak ' + result.output.truePeakDb.toFixed(2) + 'dBTP does not exceed ceiling ' + target.ceilingDbTP + 'dBTP');

    var scan = scanForBadSamples(result.channels);
    ok(scan.bad === 0, presetId + ': no NaN/Infinity samples in mastered output');
    ok(scan.overOne === 0, presetId + ': no sample exceeds full scale (would clip on WAV encode)');
  });
})();

// ---------------------------------------------------------------------
section('Smart Auto preset picks a sensible target from crest factor');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  // Dense/already-loud-ish signal -> low crest factor -> should NOT land at -16.
  var n = Math.round(2 * sr);
  var loud = [new Float32Array(n)];
  for (var i = 0; i < n; i++) loud[0][i] = 0.35 * Math.sin(2 * Math.PI * 100 * i / sr) + 0.1 * (Math.random() - 0.5);
  var resLoud = Engine.master({ sampleRate: sr, numChannels: 1, frameCount: n, channels: loud }, 'smart');
  ok(resLoud.preset.targetLUFS >= -14, 'smart preset on dense material does not choose the most conservative -16 target (chose ' + resLoud.preset.targetLUFS + ')');

  var scanS = scanForBadSamples(resLoud.channels);
  ok(scanS.bad === 0 && scanS.overOne === 0, 'smart preset output is clean (no NaN/overs)');
})();

// ---------------------------------------------------------------------
section('Already hot / clipped input is tamed, not made worse');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  var n = Math.round(2 * sr);
  var hot = [new Float32Array(n), new Float32Array(n)];
  for (var i = 0; i < n; i++) {
    var v = 0.98 * Math.sin(2 * Math.PI * 300 * i / sr);
    // Clip it artificially to simulate an already-brickwalled loud master.
    if (v > 0.9) v = 0.9;
    if (v < -0.9) v = -0.9;
    hot[0][i] = v;
    hot[1][i] = v;
  }
  var result = Engine.master({ sampleRate: sr, numChannels: 2, frameCount: n, channels: hot }, 'streaming');
  ok(result.output.truePeakDb <= -1 + 0.05, 'hot input still ends up under the -1dBTP streaming ceiling (' + result.output.truePeakDb.toFixed(2) + ')');
  var scan = scanForBadSamples(result.channels);
  ok(scan.bad === 0 && scan.overOne === 0, 'hot input produces clean output (no NaN/overs)');
})();

// ---------------------------------------------------------------------
section('Silence and near-silence input does not crash or blow up gain');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  var silence = makeSilence(2, sr, 2);
  var result = Engine.master(silence, 'streaming');
  var scan = scanForBadSamples(result.channels);
  ok(scan.bad === 0, 'pure silence: mastering does not introduce NaN/Infinity');
  ok(scan.overOne === 0, 'pure silence: mastering does not introduce out-of-range samples');
  ok(approx(result.appliedGainDb, 0, 0.01), 'pure silence: engine does not try to apply massive makeup gain (gain=' + result.appliedGainDb + 'dB)');

  var verySoft = makeSine(500, 0.0001, 2, sr, 2); // ~ -80 dBFS
  var result2 = Engine.master(verySoft, 'streaming');
  var scan2 = scanForBadSamples(result2.channels);
  ok(scan2.bad === 0 && scan2.overOne === 0, 'near-silent input: clean output, no runaway gain artifacts');
})();

// ---------------------------------------------------------------------
section('Very short file (shorter than one 400ms gating block)');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  var tiny = makeSine(1000, 0.3, 0.1, sr, 1); // 100ms, one channel
  var threw = false, result = null;
  try { result = Engine.master(tiny, 'streaming'); } catch (e) { threw = true; console.log('    threw:', e.message); }
  ok(!threw, 'sub-block-length file does not throw');
  if (result) {
    var scan = scanForBadSamples(result.channels);
    ok(scan.bad === 0 && scan.overOne === 0, 'sub-block-length file produces clean output');
  }
})();

// ---------------------------------------------------------------------
section('Mono input stays mono, stereo linkage preserves balance');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  var mono = makeSine(300, 0.2, 1, sr, 1);
  var result = Engine.master(mono, 'streaming');
  ok(result.channels.length === 1, 'mono input produces mono output (channel count preserved)');

  var n = Math.round(1.5 * sr);
  var stereo = [new Float32Array(n), new Float32Array(n)];
  for (var i = 0; i < n; i++) {
    var v = 0.3 * Math.sin(2 * Math.PI * 300 * i / sr);
    stereo[0][i] = v;
    stereo[1][i] = v; // identical L/R (mono content in a stereo file)
  }
  var res2 = Engine.master({ sampleRate: sr, numChannels: 2, frameCount: n, channels: stereo }, 'streaming');
  var maxDiff = 0;
  for (var j = 0; j < n; j++) {
    var d = Math.abs(res2.channels[0][j] - res2.channels[1][j]);
    if (d > maxDiff) maxDiff = d;
  }
  ok(maxDiff < 1e-6, 'identical L/R input stays identical L/R after mastering (linked processing, no channel drift), maxDiff=' + maxDiff);
})();

// ---------------------------------------------------------------------
section('Impulse (single full-scale spike in silence) is caught by the limiter');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  var n = sr; // 1 second
  var chans = [new Float32Array(n), new Float32Array(n)];
  chans[0][Math.floor(n / 2)] = 1.0;
  chans[1][Math.floor(n / 2)] = 1.0;
  var threw = false, result = null;
  try { result = Engine.master({ sampleRate: sr, numChannels: 2, frameCount: n, channels: chans }, 'club'); } catch (e) { threw = true; }
  ok(!threw, 'single-sample impulse in silence does not crash the engine');
  if (result) {
    var scan = scanForBadSamples(result.channels);
    ok(scan.bad === 0 && scan.overOne === 0, 'impulse case: clean output, no NaN/overs');
  }
})();

// ---------------------------------------------------------------------
section('Glue compressor soft-knee is continuous across both knee boundaries (regression)');
// ---------------------------------------------------------------------
(function () {
  // Bug found via real-world testing (a real piano recording): the
  // soft-knee formula had (1/ratio - 1) instead of (1 - 1/ratio). Sign
  // error -- with ratio > 1 that flips the knee region from an actual
  // gain *reduction* into a slight gain *increase*, so right at
  // over === kneeDb/2 the knee branch and the linear ("above knee")
  // branch disagreed by a large, audible jump (~2.7dB for the default
  // ratio/knee) even though the input level barely moved. Real program
  // material spends plenty of time with its envelope sitting right
  // around that boundary, so the discontinuity fired constantly and was
  // audible as clicking/crackling throughout a track, not just on hard
  // peaks -- exactly matching what surfaced on a real piano recording.
  // This test drives glueCompress with a signal whose envelope sweeps
  // slowly and continuously through both knee boundaries and asserts the
  // resulting gain curve has no single-sample jump beyond what such a
  // slow sweep could legitimately produce.
  var sr = 44100;
  var seconds = 3;
  var n = Math.round(seconds * sr);
  var ch = new Float32Array(n);
  // A slow linear amplitude ramp from well below to well above the
  // threshold/knee (default threshold -24dB, knee 6dB -> knee spans
  // roughly -27dB to -21dB), riding a fixed-frequency tone so the
  // detector's input changes smoothly sample-to-sample.
  var ampStart = 0.01, ampEnd = 0.5; // ~ -40dBFS to ~ -6dBFS
  for (var i = 0; i < n; i++) {
    var amp = ampStart + (ampEnd - ampStart) * (i / n);
    ch[i] = amp * Math.sin(2 * Math.PI * 300 * i / sr);
  }
  var out = Engine._internal.glueCompress([ch, ch], sr, { thresholdDb: -24, ratio: 1.8, kneeDb: 6, attackMs: 15, releaseMs: 250 });

  // Reconstruct the applied gain per sample (out/in) and find the largest
  // single-sample step in it -- a smoothly swept envelope through a
  // CONTINUOUS knee should only ever produce a smooth, gradual gain
  // curve, never a sudden multi-dB jump.
  var maxStepDb = 0, maxStepIdx = -1;
  var prevGainDb = null;
  for (var j = 0; j < n; j++) {
    var inp = ch[j];
    if (Math.abs(inp) < 1e-6) continue; // skip nearly-silent samples (gain ratio is ill-defined there)
    var g = out[0][j] / inp;
    var gDb = 20 * Math.log10(Math.abs(g));
    if (prevGainDb !== null) {
      var stepDb = Math.abs(gDb - prevGainDb);
      if (stepDb > maxStepDb) { maxStepDb = stepDb; maxStepIdx = j; }
    }
    prevGainDb = gDb;
  }
  ok(maxStepDb < 0.05, 'glue compressor gain curve has no single-sample jump greater than 0.05dB while sweeping through the knee (worst=' + maxStepDb.toFixed(4) + 'dB at sample ' + maxStepIdx + ')');

  // Directly pin down the two knee-boundary formulas agreeing with their
  // neighbors, independent of any specific audio material.
  var thresholdDb = -24, ratio = 1.8, kneeDb = 6;
  function kneeBranch(overDb) {
    var kneeX = overDb + kneeDb / 2;
    return (1 - 1 / ratio) * (kneeX * kneeX) / (2 * kneeDb);
  }
  function linearBranch(overDb) { return overDb - overDb / ratio; }
  var atUpperBoundary = kneeDb / 2;
  ok(approx(kneeBranch(atUpperBoundary), linearBranch(atUpperBoundary), 1e-9),
    'knee-branch formula agrees with the linear (above-knee) branch exactly at over=+kneeDb/2 (knee=' + kneeBranch(atUpperBoundary).toFixed(6) + ', linear=' + linearBranch(atUpperBoundary).toFixed(6) + ')');
  var atLowerBoundary = -kneeDb / 2;
  ok(approx(kneeBranch(atLowerBoundary), 0, 1e-9),
    'knee-branch formula agrees with the "no reduction" region exactly at over=-kneeDb/2 (knee=' + kneeBranch(atLowerBoundary).toFixed(6) + ')');
})();

// ---------------------------------------------------------------------
section('True-peak estimate catches inter-sample overshoot on steep transients (regression)');
// ---------------------------------------------------------------------
(function () {
  // Bug found via real-world testing: a plain 4x LINEAR-interpolation
  // true-peak estimate can never exceed max(sample[i], sample[i+1]) --
  // mathematically, a straight line between two points never overshoots
  // past either endpoint. A real DAC / streaming decoder's bandlimited
  // reconstruction filter can and does overshoot on steep,
  // high-frequency-rich transients (piano hammer attacks, drum hits),
  // producing a real inter-sample peak *above* every raw sample. The old
  // linear estimate silently missed this, so the limiter/safety-trim
  // thought there was more headroom than there really was, and shipped
  // files that clip on real playback despite every raw sample being
  // <= full scale -- reported as intermittent crackling on percussive
  // material. Cubic (Catmull-Rom) interpolation, unlike linear, CAN
  // overshoot and catches this. This test constructs exactly that steep,
  // alternating-sign transient shape and asserts the estimate now reads
  // meaningfully above the raw sample peak.
  var ch = new Float32Array(64);
  var center = 32;
  ch[center - 1] = 0.3;
  ch[center] = 0.97;
  ch[center + 1] = -0.85;
  ch[center + 2] = 0.6;
  ch[center + 3] = -0.3;
  ch[center + 4] = 0.12;
  var rawPeak = 0.97;
  var est = Engine._internal.estimateTruePeakLinear([ch]);
  ok(est > rawPeak + 0.01, 'true-peak estimate on a steep transient exceeds the raw sample peak (est=' + est.toFixed(4) + ' vs rawPeak=' + rawPeak + '), catching inter-sample overshoot');

  // A gentle, slowly-varying signal (no steep transients) should NOT see
  // artificially inflated peaks from the switch to cubic interpolation --
  // guards against the fix overcorrecting into false positives.
  var gentle = makeSine(200, 0.4, 0.05, 44100, 1);
  var gentleEst = Engine._internal.estimateTruePeakLinear(gentle.channels);
  ok(gentleEst < 0.41, 'cubic true-peak estimate stays close to the actual peak for smooth, slowly-varying material (est=' + gentleEst.toFixed(4) + ')');

  // Full-chain regression: a sparse, piano-like track (quiet decaying
  // notes + a couple of loud chord hits) must end up with a REPORTED true
  // peak that is itself accurate enough to respect the preset ceiling --
  // this is the actual end-to-end guarantee that matters for the user.
  var sr = 44100;
  var seconds = 6;
  var n = Math.round(seconds * sr);
  var L = new Float32Array(n), R = new Float32Array(n);
  function addNote(startSec, freq, amp, decaySec) {
    var startSample = Math.round(startSec * sr);
    var lenSamples = Math.min(Math.round(decaySec * sr), n - startSample);
    for (var i = 0; i < lenSamples; i++) {
      var t = i / sr;
      var env = Math.exp(-t / (decaySec * 0.3));
      var v = amp * env * (Math.sin(2 * Math.PI * freq * t) + 0.3 * Math.sin(2 * Math.PI * freq * 2 * t));
      L[startSample + i] += v;
      R[startSample + i] += v;
    }
  }
  for (var k = 0; k < 18; k++) addNote(k * 0.3, 220 + (k % 7) * 40, 0.15, 0.6);
  addNote(3.0, 130, 0.95, 1.2);
  addNote(3.0, 260, 0.9, 1.2);
  addNote(3.0, 390, 0.85, 1.2);
  for (var i = 0; i < n; i++) {
    if (L[i] > 1) L[i] = 1; if (L[i] < -1) L[i] = -1;
    if (R[i] > 1) R[i] = 1; if (R[i] < -1) R[i] = -1;
  }
  var pianoResult = Engine.master({ sampleRate: sr, numChannels: 2, frameCount: n, channels: [L, R] }, 'streaming');
  ok(pianoResult.output.truePeakDb <= -1 + 0.05, 'sparse piano-like transient material still respects the -1dBTP streaming ceiling (' + pianoResult.output.truePeakDb.toFixed(2) + ')');
  var pianoScan = scanForBadSamples(pianoResult.channels);
  ok(pianoScan.bad === 0 && pianoScan.overOne === 0, 'sparse piano-like transient material produces clean output (no NaN/overs)');
})();

// ---------------------------------------------------------------------
section('Advanced: tone EQ (bass/mid/treble) is a true no-op at 0dB, audible otherwise');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  var src = makeSine(300, 0.3, 1, sr, 2);

  // All-zero opts (and omitted opts) must return the exact input reference
  // untouched -- this is what makes it safe to always pass opts.eq from the
  // UI without changing behavior for anyone who leaves the sliders at 0.
  var zeroOut = Engine._internal.applyToneEQ(src.channels, sr, { bassDb: 0, midDb: 0, trebleDb: 0 });
  ok(zeroOut === src.channels, 'applyToneEQ with all-zero gains returns the same array reference (no-op)');
  var omittedOut = Engine._internal.applyToneEQ(src.channels, sr, {});
  ok(omittedOut === src.channels, 'applyToneEQ with empty opts returns the same array reference (no-op)');

  // A boosted band should measurably change the signal.
  var boosted = Engine._internal.applyToneEQ(src.channels, sr, { bassDb: 6 });
  var changed = false;
  for (var i = 0; i < src.channels[0].length; i++) {
    if (Math.abs(boosted[0][i] - src.channels[0][i]) > 1e-6) { changed = true; break; }
  }
  ok(changed, 'applyToneEQ with +6dB bass actually alters the signal');

  var scan = scanForBadSamples(boosted);
  ok(scan.bad === 0, 'boosted EQ output has no NaN/Infinity');

  // Extreme gain requests are clamped to +-12dB rather than trusted verbatim.
  var extreme = Engine._internal.applyToneEQ(src.channels, sr, { trebleDb: 999 });
  var normal = Engine._internal.applyToneEQ(src.channels, sr, { trebleDb: 12 });
  var identicalToClamp = true;
  for (var j = 0; j < src.channels[0].length; j++) {
    if (Math.abs(extreme[0][j] - normal[0][j]) > 1e-9) { identicalToClamp = false; break; }
  }
  ok(identicalToClamp, 'applyToneEQ clamps absurd gain requests to +-12dB instead of applying them verbatim');
})();

// ---------------------------------------------------------------------
section('Advanced: stereo width control');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  var n = Math.round(0.5 * sr);
  var L = new Float32Array(n), R = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    L[i] = 0.3 * Math.sin(2 * Math.PI * 300 * i / sr);
    R[i] = 0.3 * Math.sin(2 * Math.PI * 450 * i / sr); // different content -> real stereo image
  }
  var stereo = [L, R];

  var at100 = Engine._internal.applyStereoWidth(stereo, 100);
  ok(at100 === stereo, 'applyStereoWidth(100) returns the same array reference (no-op)');
  var atDefault = Engine._internal.applyStereoWidth(stereo, null);
  ok(atDefault === stereo, 'applyStereoWidth(null) defaults to 100% and is a no-op');

  var atZero = Engine._internal.applyStereoWidth(stereo, 0);
  var maxDiff = 0;
  for (var j = 0; j < n; j++) maxDiff = Math.max(maxDiff, Math.abs(atZero[0][j] - atZero[1][j]));
  ok(maxDiff < 1e-6, 'applyStereoWidth(0) collapses L/R to identical mono-summed signal, maxDiff=' + maxDiff);

  var wide = Engine._internal.applyStereoWidth(stereo, 200);
  // Side content should be larger at 200% than at 100% for this decorrelated signal.
  var sideOrig = 0, sideWide = 0;
  for (var k = 0; k < n; k++) {
    sideOrig += Math.abs(stereo[0][k] - stereo[1][k]);
    sideWide += Math.abs(wide[0][k] - wide[1][k]);
  }
  ok(sideWide > sideOrig, 'applyStereoWidth(200) increases the L/R difference (wider image)');

  var mono = [new Float32Array(10)];
  var monoOut = Engine._internal.applyStereoWidth(mono, 50);
  ok(monoOut === mono, 'applyStereoWidth on mono input is a no-op regardless of the requested width');
})();

// ---------------------------------------------------------------------
section('Advanced: silence trim + fade');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  var silentLeadSec = 0.3, loudSec = 0.5, silentTailSec = 0.4;
  var n = Math.round((silentLeadSec + loudSec + silentTailSec) * sr);
  var L = new Float32Array(n), R = new Float32Array(n);
  var loudStart = Math.round(silentLeadSec * sr);
  var loudEnd = Math.round((silentLeadSec + loudSec) * sr);
  for (var i = loudStart; i < loudEnd; i++) {
    var v = 0.5 * Math.sin(2 * Math.PI * 300 * i / sr);
    L[i] = v; R[i] = v;
  }
  var withSilence = [L, R];

  var trimmed = Engine._internal.trimSilenceAndFade(withSilence, sr, {});
  ok(trimmed.trimmedStartSamples > 0, 'trims leading silence (' + trimmed.trimmedStartSamples + ' samples)');
  ok(trimmed.trimmedEndSamples > 0, 'trims trailing silence (' + trimmed.trimmedEndSamples + ' samples)');
  ok(trimmed.channels[0].length < n, 'trimmed output is shorter than the original');
  ok(trimmed.channels[0].length === n - trimmed.trimmedStartSamples - trimmed.trimmedEndSamples,
    'trimmed length matches original minus start/end trims exactly');
  // The very first and last samples of the trimmed result should now be at
  // (or very near) zero thanks to the fade, never an abrupt jump to full level.
  ok(Math.abs(trimmed.channels[0][0]) < 1e-6, 'trimmed output starts at silence (faded in), not a click');
  var lastIdx = trimmed.channels[0].length - 1;
  ok(Math.abs(trimmed.channels[0][lastIdx]) < 1e-6, 'trimmed output ends at silence (faded out), not a click');

  // Original buffers must never be mutated by this call.
  ok(L[loudStart] !== 0 && withSilence[0] === L, 'trimSilenceAndFade never mutates the caller\'s original buffers');

  // A signal that is already loud at both edges is returned untouched (same
  // reference, no copy, no fade) -- true no-op. Uses cosine (not sine) so
  // the very first and last samples are near peak amplitude rather than at
  // a zero-crossing -- a plain sine over an exact number of cycles starts
  // and ends at literal 0, which the threshold gate correctly treats as
  // genuine silence and trims (verified separately; that's not a bug).
  var allLoudN = Math.round(0.3 * sr);
  var allLoudL = new Float32Array(allLoudN), allLoudR = new Float32Array(allLoudN);
  for (var al = 0; al < allLoudN; al++) {
    var alv = 0.4 * Math.cos(2 * Math.PI * 300 * al / sr);
    allLoudL[al] = alv; allLoudR[al] = alv;
  }
  var allLoud = { channels: [allLoudL, allLoudR] };
  var notTrimmed = Engine._internal.trimSilenceAndFade(allLoud.channels, sr, {});
  ok(notTrimmed.channels === allLoud.channels, 'already-loud-at-both-edges signal is returned as the same reference (no-op)');
  ok(notTrimmed.trimmedStartSamples === 0 && notTrimmed.trimmedEndSamples === 0, 'no-op case reports zero trimmed samples');

  // A fully silent signal must not be trimmed away to nothing.
  var allSilent = makeSilence(0.5, sr, 2);
  var stillSilent = Engine._internal.trimSilenceAndFade(allSilent.channels, sr, {});
  ok(stillSilent.channels === allSilent.channels, 'fully silent input is left untouched rather than trimmed to zero length');
})();

// ---------------------------------------------------------------------
section('Advanced: opt-in TPDF dithering on WAV encode');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  var src = makeSine(1000, 0.3, 0.2, sr, 1);

  // Default (opts omitted) must be byte-identical to dither explicitly off.
  var plain = Engine.encodeWav(src.channels, sr, 16);
  var explicitOff = Engine.encodeWav(src.channels, sr, 16, { dither: false });
  ok(Buffer.compare(Buffer.from(plain), Buffer.from(explicitOff)) === 0,
    'encodeWav with opts omitted is byte-identical to {dither:false}');

  // A deterministic fake rng makes the dithered output reproducible for testing.
  var calls = 0;
  function fakeRng() { calls++; return (calls % 2 === 0) ? 0.9 : 0.1; }
  var dithered = Engine.encodeWav(src.channels, sr, 16, { dither: true, rng: fakeRng });
  var isDifferent = !(Buffer.compare(Buffer.from(plain), Buffer.from(dithered)) === 0);
  ok(isDifferent, 'dithered output differs from non-dithered output with a non-trivial rng');
  ok(dithered.byteLength === plain.byteLength, 'dithered output has the same byte length as non-dithered output');

  var decodedDithered = Engine.parseWav(dithered);
  var maxErr = 0;
  for (var i = 0; i < src.channels[0].length; i++) {
    maxErr = Math.max(maxErr, Math.abs(decodedDithered.channels[0][i] - src.channels[0][i]));
  }
  ok(maxErr < 2 / 32000, 'dithered round-trip error stays within a couple LSB (max err ' + maxErr.toFixed(8) + ')');
})();

// ---------------------------------------------------------------------
section('Advanced options wired into master(): opt-in, backward compatible, and effective');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  var n = Math.round(2 * sr);
  var L = new Float32Array(n), R = new Float32Array(n);
  // Cosine components (not sine) so the buffer doesn't start/end at a
  // literal zero-crossing -- keeps the trimSilence assertion below
  // ("trims nothing off wall-to-wall audio") meaningful; a sine starting
  // exactly at phase 0 has a genuinely-silent first sample, which the trim
  // step correctly (not buggily) removes.
  for (var i = 0; i < n; i++) {
    var v = 0.2 * Math.cos(2 * Math.PI * 220 * i / sr) + 0.1 * Math.cos(2 * Math.PI * 4400 * i / sr);
    L[i] = v; R[i] = v * 0.95;
  }
  var decoded = { sampleRate: sr, numChannels: 2, frameCount: n, channels: [L, R] };

  // Explicit all-neutral opts must reproduce the plain call's output exactly
  // -- the guarantee that shipping this feature never changes default output.
  var plain = Engine.master(decoded, 'streaming');
  var neutral = Engine.master(decoded, 'streaming', {
    trimSilence: false, eq: { bassDb: 0, midDb: 0, trebleDb: 0 }, stereoWidthPct: 100
  });
  ok(plain.channels[0].length === neutral.channels[0].length, 'neutral advanced opts preserve output length');
  var maxDiffPlainNeutral = 0;
  for (var j = 0; j < plain.channels[0].length; j++) {
    maxDiffPlainNeutral = Math.max(maxDiffPlainNeutral, Math.abs(plain.channels[0][j] - neutral.channels[0][j]));
  }
  ok(maxDiffPlainNeutral < 1e-7, 'explicit neutral advanced opts produce (numerically) identical output to omitting opts entirely, maxDiff=' + maxDiffPlainNeutral);
  ok(plain.trimmedStartSamples === 0 && plain.trimmedEndSamples === 0, 'master() without trimSilence reports zero trimmed samples');

  // Combining all four advanced features at once must stay clean (no
  // NaN/overs) and must actually change the result vs. the plain call.
  var combined = Engine.master(decoded, 'streaming', {
    trimSilence: true,
    eq: { bassDb: 4, midDb: -2, trebleDb: 3 },
    stereoWidthPct: 140
  });
  var scan = scanForBadSamples(combined.channels);
  ok(scan.bad === 0, 'combined advanced opts: no NaN/Infinity in output');
  ok(scan.overOne === 0, 'combined advanced opts: no out-of-range samples');
  ok(combined.output.truePeakDb <= -1 + 0.05, 'combined advanced opts: still respects the streaming true-peak ceiling');
  ok(approx(combined.output.lufs, -14, 0.6), 'combined advanced opts: still lands near the streaming LUFS target');

  var differsFromPlain = combined.channels[0].length !== plain.channels[0].length;
  if (!differsFromPlain) {
    for (var k = 0; k < combined.channels[0].length; k++) {
      if (Math.abs(combined.channels[0][k] - plain.channels[0][k]) > 1e-4) { differsFromPlain = true; break; }
    }
  }
  ok(differsFromPlain, 'combined advanced opts measurably change the output vs. the plain (no-opts) call');

  // trimSilence on program material with no actual leading/trailing silence
  // (this synthetic tone runs full-length) should report zero trim, not
  // fabricate one.
  ok(combined.trimmedStartSamples === 0 && combined.trimmedEndSamples === 0,
    'trimSilence on wall-to-wall audio (no real silence) trims nothing');
})();

// ---------------------------------------------------------------------
section('Lowpass biquad filter sanity');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  var coef = Engine._internal.makeBiquad('lowpass', 500, Math.SQRT1_2, 0, sr);
  var lowTone = makeSine(50, 0.5, 0.3, sr, 1).channels[0];
  var highTone = makeSine(8000, 0.5, 0.3, sr, 1).channels[0];
  var lowOut = Engine._internal.applyBiquad(lowTone, coef);
  var highOut = Engine._internal.applyBiquad(highTone, coef);
  function peakOf(ch) { var m = 0; for (var i = 0; i < ch.length; i++) { var a = Math.abs(ch[i]); if (a > m) m = a; } return m; }
  var lowPeak = peakOf(lowOut.slice(Math.floor(lowOut.length / 2))); // settled region, skip filter startup
  var highPeak = peakOf(highOut.slice(Math.floor(highOut.length / 2)));
  ok(lowPeak > 0.45, 'lowpass @500Hz passes a 50Hz tone almost unattenuated (peak ' + lowPeak.toFixed(3) + ')');
  ok(highPeak < 0.1, 'lowpass @500Hz strongly attenuates an 8kHz tone (peak ' + highPeak.toFixed(3) + ')');
})();

// ---------------------------------------------------------------------
section('Advanced: bass-mono (sub-crossover stereo -> mono summing)');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  var n = Math.round(0.5 * sr);
  function rmsOfDiff(a, b) {
    var sum = 0;
    for (var i = 0; i < a.length; i++) { var d = a[i] - b[i]; sum += d * d; }
    return Math.sqrt(sum / a.length);
  }

  // No-op checks: disabled, or mono input -> exact same array references.
  var stereoSrc = [new Float32Array(n), new Float32Array(n)];
  var offOut = Engine._internal.applyBassMono(stereoSrc, sr, { enabled: false });
  ok(offOut === stereoSrc, 'bass-mono disabled returns the exact same channel array (true no-op)');
  var monoSrc = [new Float32Array(n)];
  var monoOut = Engine._internal.applyBassMono(monoSrc, sr, { enabled: true });
  ok(monoOut === monoSrc, 'bass-mono is a no-op on mono input (nothing to sum)');

  // Low-frequency content (well below the 120Hz default crossover) with a
  // clear amplitude difference between L/R should end up much closer
  // together after bass-mono.
  var lowL = makeSine(60, 0.4, 0.5, sr, 1).channels[0];
  var lowR = makeSine(60, 0.2, 0.5, sr, 1).channels[0];
  var lowDiffBefore = rmsOfDiff(lowL, lowR);
  var lowOut = Engine._internal.applyBassMono([lowL, lowR], sr, { enabled: true });
  var lowDiffAfter = rmsOfDiff(lowOut[0], lowOut[1]);
  ok(lowDiffAfter < lowDiffBefore * 0.3, 'a 60Hz L/R amplitude difference is largely summed to mono (before ' + lowDiffBefore.toFixed(4) + ', after ' + lowDiffAfter.toFixed(4) + ')');

  // High-frequency content (well above the crossover) with the same kind
  // of L/R amplitude difference should be left essentially untouched.
  var highL = makeSine(5000, 0.4, 0.5, sr, 1).channels[0];
  var highR = makeSine(5000, 0.2, 0.5, sr, 1).channels[0];
  var highDiffBefore = rmsOfDiff(highL, highR);
  var highOut = Engine._internal.applyBassMono([highL, highR], sr, { enabled: true });
  var highDiffAfter = rmsOfDiff(highOut[0], highOut[1]);
  ok(highDiffAfter > highDiffBefore * 0.9, 'a 5kHz L/R amplitude difference (stereo width) is preserved (before ' + highDiffBefore.toFixed(4) + ', after ' + highDiffAfter.toFixed(4) + ')');

  // Wired into master(): opt-in, and actually changes the result.
  var sr2 = 44100, n2 = Math.round(2 * sr2);
  var L2 = new Float32Array(n2), R2 = new Float32Array(n2);
  for (var i2 = 0; i2 < n2; i2++) {
    L2[i2] = 0.25 * Math.cos(2 * Math.PI * 70 * i2 / sr2) + 0.1 * Math.cos(2 * Math.PI * 3000 * i2 / sr2);
    R2[i2] = 0.15 * Math.cos(2 * Math.PI * 70 * i2 / sr2) + 0.1 * Math.cos(2 * Math.PI * 3000 * i2 / sr2 + 0.7);
  }
  var decoded2 = { sampleRate: sr2, numChannels: 2, frameCount: n2, channels: [L2, R2] };
  var plainM = Engine.master(decoded2, 'streaming');
  var bassMonoM = Engine.master(decoded2, 'streaming', { bassMono: true });
  var scanBM = scanForBadSamples(bassMonoM.channels);
  ok(scanBM.bad === 0 && scanBM.overOne === 0, 'master() with bassMono: no NaN/Infinity or out-of-range samples');
  ok(bassMonoM.output.truePeakDb <= -1 + 0.05, 'master() with bassMono: still respects the streaming true-peak ceiling');
  ok(approx(bassMonoM.output.lufs, -14, 0.6), 'master() with bassMono: still lands near the streaming LUFS target');
  var diffBM = false;
  for (var k2 = 0; k2 < plainM.channels[0].length; k2++) {
    if (Math.abs(plainM.channels[0][k2] - bassMonoM.channels[0][k2]) > 1e-4) { diffBM = true; break; }
  }
  ok(diffBM, 'master() with bassMono:true measurably changes the output vs. the plain call');
})();

// ---------------------------------------------------------------------
section('Advanced: multiband glue compressor');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  var n = Math.round(1 * sr);

  // Bypass check: with every band's threshold set far above the signal
  // level, no band should ever engage gain reduction, so splitting into
  // 3 bands and summing back should closely reconstruct the original
  // (small deviation only from floating-point filter arithmetic).
  var L = new Float32Array(n), R = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var v = 0.1 * Math.sin(2 * Math.PI * 80 * i / sr) +
            0.1 * Math.sin(2 * Math.PI * 800 * i / sr) +
            0.1 * Math.sin(2 * Math.PI * 5000 * i / sr);
    L[i] = v; R[i] = v;
  }
  var noCompressOpts = { thresholdDb: 0, ratio: 1.8, kneeDb: 6, attackMs: 15, releaseMs: 250 };
  var bypassOut = Engine._internal.multibandCompress([L, R], sr, {
    low: noCompressOpts, mid: noCompressOpts, high: noCompressOpts
  });
  var maxDiffBypass = 0;
  for (var j = 0; j < n; j++) {
    maxDiffBypass = Math.max(maxDiffBypass, Math.abs(bypassOut[0][j] - L[j]));
  }
  ok(maxDiffBypass < 0.01, 'multiband split+recombine with thresholds far above signal level closely reconstructs the original (maxDiff=' + maxDiffBypass.toFixed(5) + ')');

  // Actual gain reduction: a loud low tone (well above the low band's
  // default -22dB threshold) summed with a quiet high tone (well below
  // the high band's default -26dB threshold) should come out with
  // visibly lower RMS than the input, because the low band gets
  // compressed while the high band doesn't. RMS is measured over the
  // second half of the signal only, well after the compressor's 30ms
  // attack has settled -- the very first cycle is compressed less than
  // steady-state (the envelope follower starts at -100dB and ramps up),
  // so including it would mix a brief, legitimate attack transient into
  // what should be a steady-state measurement and understate the effect.
  var loudLowAmp = 0.9, quietHighAmp = 0.02;
  var L2 = new Float32Array(n), R2 = new Float32Array(n);
  for (var i2 = 0; i2 < n; i2++) {
    var v2 = loudLowAmp * Math.sin(2 * Math.PI * 80 * i2 / sr) + quietHighAmp * Math.sin(2 * Math.PI * 5000 * i2 / sr);
    L2[i2] = v2; R2[i2] = v2;
  }
  function rmsOfSettled(chan) {
    var start = Math.floor(chan.length / 2);
    var sum = 0, count = 0;
    for (var k = start; k < chan.length; k++) { sum += chan[k] * chan[k]; count++; }
    return Math.sqrt(sum / count);
  }
  var inputRms = rmsOfSettled(L2);
  var compressedOut = Engine._internal.multibandCompress([L2, R2], sr, {});
  var outputRms = rmsOfSettled(compressedOut[0]);
  ok(outputRms < inputRms * 0.9, 'a loud low tone is measurably gain-reduced by the low band compressor, steady-state (input RMS ' + inputRms.toFixed(3) + ', output RMS ' + outputRms.toFixed(3) + ')');
  var scanMB = scanForBadSamples(compressedOut);
  ok(scanMB.bad === 0 && scanMB.overOne === 0, 'multibandCompress output has no NaN/Infinity or out-of-range samples');

  // Wired into master(): opt-in (default path untouched), and actually
  // changes the result when enabled.
  var n3 = Math.round(2 * sr);
  var L3 = new Float32Array(n3), R3 = new Float32Array(n3);
  for (var i3 = 0; i3 < n3; i3++) {
    var v3 = 0.3 * Math.cos(2 * Math.PI * 90 * i3 / sr) + 0.15 * Math.cos(2 * Math.PI * 2500 * i3 / sr);
    L3[i3] = v3; R3[i3] = v3 * 0.9;
  }
  var decoded3 = { sampleRate: sr, numChannels: 2, frameCount: n3, channels: [L3, R3] };
  var plainMB = Engine.master(decoded3, 'streaming');
  var multibandM = Engine.master(decoded3, 'streaming', { multiband: true });
  var scanMBM = scanForBadSamples(multibandM.channels);
  ok(scanMBM.bad === 0 && scanMBM.overOne === 0, 'master() with multiband: no NaN/Infinity or out-of-range samples');
  ok(multibandM.output.truePeakDb <= -1 + 0.05, 'master() with multiband: still respects the streaming true-peak ceiling');
  ok(approx(multibandM.output.lufs, -14, 0.6), 'master() with multiband: still lands near the streaming LUFS target');
  var diffMB = false;
  for (var k3 = 0; k3 < plainMB.channels[0].length; k3++) {
    if (Math.abs(plainMB.channels[0][k3] - multibandM.channels[0][k3]) > 1e-4) { diffMB = true; break; }
  }
  ok(diffMB, 'master() with multiband:true measurably changes the output vs. the plain (single-band) call');
})();

// ---------------------------------------------------------------------
section('Advanced: saturation / exciter (harmonic warmth)');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  var src = makeSine(300, 0.6, 0.3, sr, 2).channels;

  var zeroOut = Engine._internal.applySaturation(src, { amount: 0 });
  ok(zeroOut === src, 'saturation amount:0 returns the exact same channel array (true no-op)');
  var omittedOut = Engine._internal.applySaturation(src, {});
  ok(omittedOut === src, 'saturation with amount omitted defaults to a no-op');

  var driven = Engine._internal.applySaturation(src, { amount: 60 });
  var scanSat = scanForBadSamples(driven);
  ok(scanSat.bad === 0, 'saturated output has no NaN/Infinity');
  ok(scanSat.overOne === 0, 'saturated output stays within +-1 (no blow-up from the drive stage)');
  var diffSat = false;
  for (var i = 0; i < src[0].length; i++) {
    if (Math.abs(driven[0][i] - src[0][i]) > 1e-4) { diffSat = true; break; }
  }
  ok(diffSat, 'saturation amount:60 audibly changes the signal vs. the dry input');

  // A full-scale sample should map back to very close to full scale (the
  // tanh curve is normalized by tanh(drive)), not get squashed or boosted.
  var fullScale = [new Float32Array([1, -1, 1, -1])];
  var fsOut = Engine._internal.applySaturation(fullScale, { amount: 100 });
  ok(Math.abs(Math.abs(fsOut[0][0]) - 1) < 0.05, 'a full-scale sample stays close to +-1 after saturation (' + fsOut[0][0].toFixed(4) + ')');

  // Wired into master(): opt-in, and actually changes the result.
  var n2 = Math.round(2 * sr);
  var L2 = new Float32Array(n2), R2 = new Float32Array(n2);
  for (var i2 = 0; i2 < n2; i2++) {
    var v2 = 0.25 * Math.cos(2 * Math.PI * 220 * i2 / sr) + 0.1 * Math.cos(2 * Math.PI * 3300 * i2 / sr);
    L2[i2] = v2; R2[i2] = v2 * 0.95;
  }
  var decoded2 = { sampleRate: sr, numChannels: 2, frameCount: n2, channels: [L2, R2] };
  var plainS = Engine.master(decoded2, 'streaming');
  var satM = Engine.master(decoded2, 'streaming', { saturation: { amount: 50 } });
  var scanSatM = scanForBadSamples(satM.channels);
  ok(scanSatM.bad === 0 && scanSatM.overOne === 0, 'master() with saturation: no NaN/Infinity or out-of-range samples');
  ok(satM.output.truePeakDb <= -1 + 0.05, 'master() with saturation: still respects the streaming true-peak ceiling');
  ok(approx(satM.output.lufs, -14, 0.6), 'master() with saturation: still lands near the streaming LUFS target');
  var diffSatM = false;
  for (var k2 = 0; k2 < plainS.channels[0].length; k2++) {
    if (Math.abs(plainS.channels[0][k2] - satM.channels[0][k2]) > 1e-4) { diffSatM = true; break; }
  }
  ok(diffSatM, 'master() with saturation.amount:50 measurably changes the output vs. the plain call');
})();

// ---------------------------------------------------------------------
section('Advanced: bassMono + multiband + saturation combined');
// ---------------------------------------------------------------------
(function () {
  var sr = 44100;
  var n = Math.round(2 * sr);
  var L = new Float32Array(n), R = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var v = 0.25 * Math.cos(2 * Math.PI * 75 * i / sr) + 0.12 * Math.cos(2 * Math.PI * 1200 * i / sr) + 0.08 * Math.cos(2 * Math.PI * 4000 * i / sr);
    L[i] = v; R[i] = v * 0.85;
  }
  var decoded = { sampleRate: sr, numChannels: 2, frameCount: n, channels: [L, R] };
  var plain = Engine.master(decoded, 'streaming');
  var combined = Engine.master(decoded, 'streaming', {
    bassMono: true,
    multiband: true,
    saturation: { amount: 40 }
  });
  var scan = scanForBadSamples(combined.channels);
  ok(scan.bad === 0, 'bassMono+multiband+saturation combined: no NaN/Infinity in output');
  ok(scan.overOne === 0, 'bassMono+multiband+saturation combined: no out-of-range samples');
  ok(combined.output.truePeakDb <= -1 + 0.05, 'bassMono+multiband+saturation combined: still respects the streaming true-peak ceiling');
  ok(approx(combined.output.lufs, -14, 0.6), 'bassMono+multiband+saturation combined: still lands near the streaming LUFS target');
  var differs = false;
  for (var k = 0; k < plain.channels[0].length; k++) {
    if (Math.abs(plain.channels[0][k] - combined.channels[0][k]) > 1e-4) { differs = true; break; }
  }
  ok(differs, 'bassMono+multiband+saturation combined measurably changes the output vs. the plain call');

  // And, crucially, none of the three new opts change anything when they
  // are all left at their default/off state -- same backward-compatibility
  // guarantee as the original four Advanced options.
  var explicitOff = Engine.master(decoded, 'streaming', {
    bassMono: false, multiband: false, saturation: { amount: 0 }
  });
  var maxDiffOff = 0;
  for (var k2 = 0; k2 < plain.channels[0].length; k2++) {
    maxDiffOff = Math.max(maxDiffOff, Math.abs(plain.channels[0][k2] - explicitOff.channels[0][k2]));
  }
  ok(maxDiffOff < 1e-7, 'explicitly-off bassMono/multiband/saturation opts stay byte-identical to omitting them, maxDiff=' + maxDiffOff);
})();

// ---------------------------------------------------------------------
console.log('\n' + '='.repeat(50));
console.log(passes + ' passed, ' + failures + ' failed');
if (failures > 0) process.exit(1);
