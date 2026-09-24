
/*!
 * DZMASTER Engine v1.1
 * Client-side automatic mastering DSP core.
 * Pure JS, no DOM / Web Audio dependency -> runs identically in Node (for
 * testing) and in the browser.
 *
 * Pipeline:
 *   decode WAV -> analyze (integrated LUFS, true peak, crest factor)
 *   -> DC removal -> 20Hz rumble high-pass -> reference-level pre-gain
 *   -> optional EQ / width / mono bass / saturation
 *   -> gentle glue compressor (single- or multiband)
 *   -> loudness normalization to preset target through a true-peak
 *      limiter, iterated until the LIMITED result lands on the target
 *   -> final true-peak verification -> encode WAV
 *
 * Loudness measurement follows ITU-R BS.1770-4 (K-weighting + gated
 * integration). True peak is measured with 4x polyphase windowed-sinc
 * oversampling (the method BS.1770-4 Annex 2 describes), and the limiter
 * detects on that same oversampled signal, so the published ceiling holds
 * for inter-sample peaks too -- not just for the raw samples.
 *
 * v1.1 changes (all verified against ffmpeg's ebur128 meter):
 *  - true-peak ceiling is now actually honored (v1.0's cubic estimate
 *    under-read heavily limited material by up to ~2 dB)
 *  - limited output now lands on the preset's LUFS target (v1.0 could miss
 *    by 1.5-3 dB on Club/Bandcamp, because limiting lowers loudness after
 *    the normalization gain had already been chosen)
 *  - limiter attack is a smooth ramp instead of an instant gain step
 *  - compression/saturation no longer depend on how loud the user
 *    happened to export the mix (fixed reference level before dynamics)
 *  - WAVE_FORMAT_EXTENSIBLE (e.g. 32-bit float from many DAWs) decodes
 *  - in-place processing: ~3x lower peak memory on long tracks
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DZMasterEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Presets
  // ---------------------------------------------------------------------
  // Sources (checked 2026-09): Spotify & YouTube normalize to -14 LUFS;
  // Apple Music targets -16 LUFS; -1 dBTP ceiling is the common safe
  // true-peak limit recommended across platforms to avoid inter-sample
  // clipping after lossy encoding. Broadcast target follows EBU R128
  // (-23 LUFS, mandatory across EU television/radio). Podcast/audiobook
  // target follows the ACX submission spec (RMS -23 to -18 dB, peak <=
  // -3 dBTP) -- landing in the middle of that window. Bandcamp/direct-
  // download is louder on purpose: unlike streaming platforms, Bandcamp
  // does not renormalize playback, so extra loudness here is not thrown
  // away. Vinyl leaves extra true-peak headroom for the cutting process.
  // Social/short-form follows the same -14-ish family most short-video
  // platforms normalize to. Classical/acoustic uses the widest-dynamics
  // target of the set.
  var PRESETS = {
    streaming: { id: 'streaming', targetLUFS: -14, ceilingDbTP: -1.0 },
    apple: { id: 'apple', targetLUFS: -16, ceilingDbTP: -1.0 },
    club: { id: 'club', targetLUFS: -9, ceilingDbTP: -1.0 },
    broadcast: { id: 'broadcast', targetLUFS: -23, ceilingDbTP: -1.0 },
    podcast: { id: 'podcast', targetLUFS: -19, ceilingDbTP: -3.0 },
    bandcamp: { id: 'bandcamp', targetLUFS: -11, ceilingDbTP: -1.0 },
    vinyl: { id: 'vinyl', targetLUFS: -14, ceilingDbTP: -1.5 },
    social: { id: 'social', targetLUFS: -13, ceilingDbTP: -1.0 },
    classical: { id: 'classical', targetLUFS: -18, ceilingDbTP: -1.0 },
    // 'smart' has no fixed target -- resolved per-track by pickSmartTarget()
    smart: { id: 'smart', targetLUFS: null, ceilingDbTP: -1.0 }
  };

  // Level the dynamics stages (saturation, glue/multiband compressor) are
  // tuned for. The mix is brought here before them and taken to the preset
  // target after them, so the SAME mix exported at -3 dBFS or at -12 dBFS
  // peak now gets the same compression. -20 LUFS is roughly where a mix
  // prepared per the in-app guide (peaks around -6..-3 dBFS) already sits,
  // i.e. the compressor behaves exactly as tuned for well-prepared mixes.
  var REFERENCE_LUFS = -20;
  // Internal safety margin under the published ceiling for the limiter.
  var LIMITER_MARGIN_DB = 0.5;
  // How far past the plain normalization gain the loudness loop may push
  // into the limiter to reach the target. Beyond this a very dynamic track
  // would be crushed; the result then reports the loudness it really has.
  var MAX_LIMITER_PUSH_DB = 6;
  var LOUDNESS_TOLERANCE_DB = 0.1;
  var LOUDNESS_MAX_ITERATIONS = 6;

  function pickSmartTarget(crestFactorDb) {
    // Crest factor = peak/RMS in dB. Low crest factor => already dense /
    // loud material (EDM, club, hyper-compressed pop) => don't push it
    // further, land closer to -11. High crest factor => dynamic, acoustic,
    // classical-leaning material => preserve dynamics, land at -16.
    // Everything in between gets the -14 streaming-safe default.
    if (crestFactorDb <= 8) return -11;
    if (crestFactorDb >= 18) return -16;
    return -14;
  }

  function resolvePreset(presetId, crestFactorDb) {
    var p = PRESETS[presetId];
    if (!p) throw new Error('Unknown preset: ' + presetId);
    var targetLUFS = p.targetLUFS;
    if (presetId === 'smart') {
      targetLUFS = pickSmartTarget(crestFactorDb);
    }
    return { id: p.id, targetLUFS: targetLUFS, ceilingDbTP: p.ceilingDbTP };
  }

  // ---------------------------------------------------------------------
  // WAV decode / encode
  // ---------------------------------------------------------------------
  var WAVE_FORMAT_PCM = 1;
  var WAVE_FORMAT_IEEE_FLOAT = 3;
  var WAVE_FORMAT_EXTENSIBLE = 0xFFFE;

  function wavError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function fourCC(view, offset) {
    return String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1),
      view.getUint8(offset + 2), view.getUint8(offset + 3)
    );
  }

  function looksLikeChunkId(view, offset) {
    if (offset + 4 > view.byteLength) return false;
    for (var i = 0; i < 4; i++) {
      var b = view.getUint8(offset + i);
      if (b < 0x20 || b > 0x7e) return false;
    }
    return true;
  }

  // Resolves the effective sample format. WAVE_FORMAT_EXTENSIBLE (0xFFFE)
  // stores the real format code in the first two bytes of the SubFormat
  // GUID at byte 24 of the fmt chunk -- many DAWs write 24/32-bit and float
  // files this way, so it has to be understood, not rejected.
  function readFmtChunk(view, chunkStart, chunkSize) {
    if (chunkSize < 16 || chunkStart + 16 > view.byteLength) {
      throw wavError('BAD_FMT', 'WAV fmt chunk is too short.');
    }
    var fmt = {
      audioFormat: view.getUint16(chunkStart, true),
      numChannels: view.getUint16(chunkStart + 2, true),
      sampleRate: view.getUint32(chunkStart + 4, true),
      bitsPerSample: view.getUint16(chunkStart + 14, true)
    };
    fmt.formatCode = fmt.audioFormat;
    if (fmt.audioFormat === WAVE_FORMAT_EXTENSIBLE) {
      if (chunkSize >= 26 && chunkStart + 26 <= view.byteLength) {
        fmt.formatCode = view.getUint16(chunkStart + 24, true);
      } else {
        fmt.formatCode = WAVE_FORMAT_PCM; // truncated extension: PCM is by far the most likely
      }
    }
    return fmt;
  }

  function checkFormatSupported(fmt) {
    var bits = fmt.bitsPerSample;
    var ok = (fmt.formatCode === WAVE_FORMAT_PCM && (bits === 8 || bits === 16 || bits === 24 || bits === 32)) ||
      (fmt.formatCode === WAVE_FORMAT_IEEE_FLOAT && (bits === 32 || bits === 64));
    if (!ok) {
      throw wavError('UNSUPPORTED_FORMAT', 'Unsupported WAV encoding: ' + bits + '-bit, format code ' + fmt.formatCode + '.');
    }
    if (fmt.numChannels < 1 || fmt.numChannels > 32) {
      throw wavError('UNSUPPORTED_CHANNELS', 'Unsupported channel count: ' + fmt.numChannels);
    }
    if (!(fmt.sampleRate >= 8000 && fmt.sampleRate <= 768000)) {
      throw wavError('UNSUPPORTED_RATE', 'Unsupported sample rate: ' + fmt.sampleRate + ' Hz');
    }
  }

  function parseWav(arrayBuffer) {
    var view = new DataView(arrayBuffer);
    if (arrayBuffer.byteLength < 12) throw wavError('NOT_WAV', 'File too small to be a valid WAV file.');
    if (fourCC(view, 0) !== 'RIFF') throw wavError('NOT_WAV', 'Not a RIFF/WAV file.');
    if (fourCC(view, 8) !== 'WAVE') throw wavError('NOT_WAV', 'Not a WAVE file.');

    var offset = 12;
    var fmt = null;
    var dataOffset = -1;
    var dataLength = 0;

    while (offset + 8 <= view.byteLength) {
      var chunkId = fourCC(view, offset);
      var chunkSize = view.getUint32(offset + 4, true);
      var chunkStart = offset + 8;

      if (chunkId === 'fmt ') {
        fmt = readFmtChunk(view, chunkStart, chunkSize);
      } else if (chunkId === 'data') {
        dataOffset = chunkStart;
        var remaining = view.byteLength - chunkStart;
        // 0 / 0xFFFFFFFF = size never finalized (interrupted recording,
        // streamed/piped export) and a size past EOF = truncated file:
        // take whatever audio is actually there instead of failing.
        dataLength = (chunkSize === 0 || chunkSize === 0xFFFFFFFF || chunkSize > remaining) ? remaining : chunkSize;
        if (fmt) break; // everything needed is known; skip trailing metadata
      }

      // Chunks are word (2-byte) aligned. Some writers forget the pad byte
      // after an odd-sized chunk -- tolerate that instead of misreading
      // every chunk after it. A zero-size chunk is legal (still advances).
      var next = chunkStart + chunkSize + (chunkSize % 2);
      if ((chunkSize % 2) && !looksLikeChunkId(view, next) && looksLikeChunkId(view, next - 1)) next -= 1;
      offset = next;
    }

    if (!fmt) throw wavError('NO_FMT', 'WAV file has no fmt chunk.');
    if (dataOffset < 0) throw wavError('NO_DATA', 'WAV file has no data chunk.');
    checkFormatSupported(fmt);

    var numChannels = fmt.numChannels;
    var bitsPerSample = fmt.bitsPerSample;
    var bytesPerSample = bitsPerSample / 8;
    var frameCount = Math.floor(dataLength / (bytesPerSample * numChannels));

    var channels = [];
    for (var c = 0; c < numChannels; c++) channels.push(new Float32Array(frameCount));

    var readSample;
    var isFloat = fmt.formatCode === WAVE_FORMAT_IEEE_FLOAT;
    if (isFloat && bitsPerSample === 32) {
      readSample = function (o) { return view.getFloat32(o, true); };
    } else if (isFloat && bitsPerSample === 64) {
      readSample = function (o) { return view.getFloat64(o, true); };
    } else if (bitsPerSample === 16) {
      readSample = function (o) { return view.getInt16(o, true) / 32768; };
    } else if (bitsPerSample === 24) {
      readSample = function (o) {
        var b0 = view.getUint8(o), b1 = view.getUint8(o + 1), b2 = view.getUint8(o + 2);
        var val = b0 | (b1 << 8) | (b2 << 16);
        if (val & 0x800000) val -= 0x1000000;
        return val / 8388608;
      };
    } else if (bitsPerSample === 32) {
      readSample = function (o) { return view.getInt32(o, true) / 2147483648; };
    } else {
      readSample = function (o) { return (view.getUint8(o) - 128) / 128; };
    }

    var pos = dataOffset;
    for (var i = 0; i < frameCount; i++) {
      for (var ch = 0; ch < numChannels; ch++) {
        var s = readSample(pos);
        // Float files may carry NaN/Inf from a broken plugin -- never let
        // that poison every filter state downstream.
        channels[ch][i] = (s === s && s !== Infinity && s !== -Infinity) ? s : 0;
        pos += bytesPerSample;
      }
    }

    return { sampleRate: fmt.sampleRate, numChannels: numChannels, frameCount: frameCount, channels: channels };
  }

  // Fast xorshift32 uniform [0,1) source for dither noise: statistically
  // plenty for TPDF dither and several times cheaper than Math.random over
  // the ~2 draws per sample a multi-minute export needs.
  var ditherState = 0x9E3779B9;
  function fastRandom() {
    var x = ditherState | 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    ditherState = x >>> 0;
    return ditherState / 4294967296;
  }

  var HOST_LITTLE_ENDIAN = (function () {
    var b = new ArrayBuffer(2);
    new DataView(b).setInt16(0, 1, true);
    return new Int16Array(b)[0] === 1;
  })();

  function encodeWav(channels, sampleRate, bitsPerSample, opts) {
    bitsPerSample = bitsPerSample || 16;
    if (bitsPerSample !== 16 && bitsPerSample !== 24) {
      throw new Error('encodeWav only supports 16 or 24 bit output.');
    }
    opts = opts || {};
    // Off by default -- this only changes behavior when a caller opts in,
    // so every existing call site (including exact round-trip tests) is
    // byte-for-byte unaffected. TPDF dither (sum of two independent
    // uniform[0,1) draws, triangular over (-1,1)) softens the harsh,
    // signal-correlated distortion that plain rounding can add on quiet
    // passages, at the cost of a tiny, inaudible noise floor.
    // `opts.rng` lets tests substitute a deterministic generator.
    var dither = !!opts.dither;
    var rng = opts.rng || fastRandom;
    var numChannels = channels.length;
    if (numChannels < 1) throw new Error('encodeWav needs at least one channel.');
    var frameCount = channels[0].length;
    var bytesPerSample = bitsPerSample / 8;
    var blockAlign = numChannels * bytesPerSample;
    var dataSize = frameCount * blockAlign;

    var buffer = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buffer);

    function writeStr(o, s) { for (var i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    var maxPos = bitsPerSample === 16 ? 32767 : 8388607;
    var maxNeg = bitsPerSample === 16 ? -32768 : -8388608;
    // Typed-array writes instead of a DataView call per byte: same bytes,
    // several times faster on multi-minute tracks.
    var i16 = (bitsPerSample === 16 && HOST_LITTLE_ENDIAN) ? new Int16Array(buffer, 44, frameCount * numChannels) : null;
    var u8 = new Uint8Array(buffer);
    var offset = 44;
    var k = 0;

    for (var i = 0; i < frameCount; i++) {
      for (var c = 0; c < numChannels; c++) {
        var s = channels[c][i];
        if (!isFinite(s)) s = 0; // NaN/Infinity safety net -- never write garbage samples
        if (s > 1) s = 1; else if (s < -1) s = -1;
        var scaled = s * (s < 0 ? -maxNeg : maxPos);
        if (dither) scaled += rng() - rng(); // TPDF, +-1 LSB triangular
        var val = Math.round(scaled);
        if (val > maxPos) val = maxPos;
        if (val < maxNeg) val = maxNeg;

        if (i16) {
          i16[k++] = val;
        } else if (bitsPerSample === 16) {
          view.setInt16(offset, val, true);
          offset += 2;
        } else {
          if (val < 0) val += 0x1000000;
          u8[offset] = val & 0xff;
          u8[offset + 1] = (val >> 8) & 0xff;
          u8[offset + 2] = (val >> 16) & 0xff;
          offset += 3;
        }
      }
    }

    return buffer;
  }

  // ---------------------------------------------------------------------
  // Biquad filter (RBJ Audio EQ Cookbook formulas) -- used both for the
  // K-weighting loudness filters and for the rumble high-pass in the
  // processing chain. Parameterized by sample rate, so it is correct at
  // 44.1kHz, 48kHz, 96kHz etc without a lookup table.
  // ---------------------------------------------------------------------
  function makeBiquad(type, fc, Q, gainDb, sampleRate) {
    // Keep the corner safely below Nyquist: at low sample rates (a 16 kHz
    // voice recording, say) an 8 kHz treble shelf would otherwise sit
    // exactly on Nyquist and produce a degenerate filter.
    var nyq = sampleRate / 2;
    if (fc > nyq * 0.9) fc = nyq * 0.9;
    var A = Math.pow(10, gainDb / 40);
    var w0 = 2 * Math.PI * (fc / sampleRate);
    var cosw0 = Math.cos(w0);
    var sinw0 = Math.sin(w0);
    var alpha = sinw0 / (2 * Q);
    var b0, b1, b2, a0, a1, a2;

    if (type === 'highshelf') {
      var sqrtA = Math.sqrt(A);
      b0 = A * ((A + 1) + (A - 1) * cosw0 + 2 * sqrtA * alpha);
      b1 = -2 * A * ((A - 1) + (A + 1) * cosw0);
      b2 = A * ((A + 1) + (A - 1) * cosw0 - 2 * sqrtA * alpha);
      a0 = (A + 1) - (A - 1) * cosw0 + 2 * sqrtA * alpha;
      a1 = 2 * ((A - 1) - (A + 1) * cosw0);
      a2 = (A + 1) - (A - 1) * cosw0 - 2 * sqrtA * alpha;
    } else if (type === 'lowshelf') {
      var sqrtA2 = Math.sqrt(A);
      b0 = A * ((A + 1) - (A - 1) * cosw0 + 2 * sqrtA2 * alpha);
      b1 = 2 * A * ((A - 1) - (A + 1) * cosw0);
      b2 = A * ((A + 1) - (A - 1) * cosw0 - 2 * sqrtA2 * alpha);
      a0 = (A + 1) + (A - 1) * cosw0 + 2 * sqrtA2 * alpha;
      a1 = -2 * ((A - 1) + (A + 1) * cosw0);
      a2 = (A + 1) + (A - 1) * cosw0 - 2 * sqrtA2 * alpha;
    } else if (type === 'peaking') {
      b0 = 1 + alpha * A;
      b1 = -2 * cosw0;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosw0;
      a2 = 1 - alpha / A;
    } else if (type === 'highpass') {
      b0 = (1 + cosw0) / 2;
      b1 = -(1 + cosw0);
      b2 = (1 + cosw0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosw0;
      a2 = 1 - alpha;
    } else if (type === 'lowpass') {
      b0 = (1 - cosw0) / 2;
      b1 = 1 - cosw0;
      b2 = (1 - cosw0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosw0;
      a2 = 1 - alpha;
    } else {
      throw new Error('Unknown biquad type: ' + type);
    }

    return {
      b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
      a1: a1 / a0, a2: a2 / a0
    };
  }

  // Direct Form I biquad writing into `out` (may be the same array as
  // `input` -- each input sample is read before its slot is overwritten).
  function runBiquad(input, out, coef) {
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    var b0 = coef.b0, b1 = coef.b1, b2 = coef.b2, a1 = coef.a1, a2 = coef.a2;
    for (var i = 0; i < input.length; i++) {
      var x0 = input[i];
      var y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      out[i] = y0;
      x2 = x1; x1 = x0;
      y2 = y1; y1 = y0;
    }
    return out;
  }

  // Returns a NEW Float32Array (never mutates the input -- callers rely on that).
  function applyBiquad(input, coef) {
    return runBiquad(input, new Float32Array(input.length), coef);
  }

  function applyBiquadInPlace(chan, coef) {
    return runBiquad(chan, chan, coef);
  }

  function copyChannels(channels) {
    return channels.map(function (c) { return new Float32Array(c); });
  }

  function scaleInPlace(channels, gainLin) {
    if (gainLin === 1) return channels;
    for (var c = 0; c < channels.length; c++) {
      var chan = channels[c];
      for (var i = 0; i < chan.length; i++) chan[i] *= gainLin;
    }
    return channels;
  }

  // ---------------------------------------------------------------------
  // ITU-R BS.1770-4 loudness measurement
  // ---------------------------------------------------------------------
  // Channel weighting per BS.1770 for the usual WAV channel orders:
  // mono/stereo all 1.0; 5.0 = L R C Ls Rs; 5.1 = L R C LFE Ls Rs (LFE is
  // excluded from the measurement).
  function channelWeight(numChannels, idx) {
    if (numChannels <= 2) return 1.0;
    if (numChannels === 6) return idx === 3 ? 0 : ((idx === 4 || idx === 5) ? 1.41 : 1.0);
    if (numChannels === 5) return (idx === 3 || idx === 4) ? 1.41 : 1.0;
    return 1.0;
  }

  function gatedLoudnessFromBlocks(blockLoudness) {
    // Absolute gate at -70 LUFS
    var ABS_GATE_LUFS = -70.0;
    var absGated = blockLoudness.filter(function (z) {
      return z > 0 && (-0.691 + 10 * Math.log10(z)) > ABS_GATE_LUFS;
    });
    if (absGated.length === 0) return -Infinity; // effectively silent track

    var meanAbs = absGated.reduce(function (a, b) { return a + b; }, 0) / absGated.length;
    var relativeThreshold = -0.691 + 10 * Math.log10(meanAbs) - 10.0;

    var relGated = absGated.filter(function (z) {
      return (-0.691 + 10 * Math.log10(z)) > relativeThreshold;
    });
    if (relGated.length === 0) relGated = absGated; // safety net

    var meanRel = relGated.reduce(function (a, b) { return a + b; }, 0) / relGated.length;
    if (meanRel <= 0) return -Infinity;
    return -0.691 + 10 * Math.log10(meanRel);
  }

  // Returns integrated loudness in LUFS, or -Infinity for digital silence.
  // K-weighting runs inline and squares are accumulated per 100 ms step,
  // so 400 ms blocks (75% overlap) are sums of 4 steps: one pass, no
  // filtered copies of the track in memory, each sample touched once.
  function integratedLoudness(channels, sampleRate) {
    var numChannels = channels.length;
    var frameCount = channels[0].length;
    if (frameCount === 0) return -Infinity;
    var shelf = makeBiquad('highshelf', 1500.0, Math.SQRT1_2, 4.0, sampleRate);
    var hp = makeBiquad('highpass', 38.0, 0.5, 0.0, sampleRate);
    var stepSize = Math.round(0.1 * sampleRate);
    var numSteps = Math.floor(frameCount / stepSize);
    var singleBlock = numSteps < 4 || frameCount < Math.round(0.4 * sampleRate);
    // File shorter than one gating block (400ms): a single whole-buffer
    // measurement. Rare (very short stingers) but must not crash.
    var span = singleBlock ? frameCount : numSteps * stepSize;
    var slots = singleBlock ? 1 : numSteps;
    var stepSums = new Float64Array(slots);

    for (var c = 0; c < numChannels; c++) {
      var w = channelWeight(numChannels, c);
      if (w === 0) continue;
      var chan = channels[c];
      var sx1 = 0, sx2 = 0, sy1 = 0, sy2 = 0;
      var hx1 = 0, hx2 = 0, hy1 = 0, hy2 = 0;
      var acc = 0, inStep = 0, s = 0;
      var stepLen = singleBlock ? frameCount : stepSize;
      for (var i = 0; i < span; i++) {
        var x0 = chan[i];
        var y0 = shelf.b0 * x0 + shelf.b1 * sx1 + shelf.b2 * sx2 - shelf.a1 * sy1 - shelf.a2 * sy2;
        sx2 = sx1; sx1 = x0; sy2 = sy1; sy1 = y0;
        var z0 = hp.b0 * y0 + hp.b1 * hx1 + hp.b2 * hx2 - hp.a1 * hy1 - hp.a2 * hy2;
        hx2 = hx1; hx1 = y0; hy2 = hy1; hy1 = z0;
        acc += z0 * z0;
        if (++inStep === stepLen) { stepSums[s++] += w * acc; acc = 0; inStep = 0; }
      }
    }

    var blockLoudness = [];
    if (singleBlock) {
      blockLoudness.push(stepSums[0] / frameCount);
    } else {
      var blockLen = 4 * stepSize;
      for (var j = 0; j + 4 <= numSteps; j++) {
        blockLoudness.push((stepSums[j] + stepSums[j + 1] + stepSums[j + 2] + stepSums[j + 3]) / blockLen);
      }
    }
    if (blockLoudness.length === 0) return -Infinity;
    return gatedLoudnessFromBlocks(blockLoudness);
  }

  // ---------------------------------------------------------------------
  // True peak (4x polyphase oversampling) and sample peak
  // ---------------------------------------------------------------------
  function samplePeak(channels) {
    var peak = 0;
    for (var c = 0; c < channels.length; c++) {
      var chan = channels[c];
      for (var i = 0; i < chan.length; i++) {
        var a = chan[i] < 0 ? -chan[i] : chan[i];
        if (a > peak) peak = a;
      }
    }
    return peak;
  }

  function besselI0(x) {
    var sum = 1, term = 1, h = x / 2;
    for (var k = 1; k < 60; k++) {
      term *= (h / k) * (h / k);
      sum += term;
      if (term < 1e-14 * sum) break;
    }
    return sum;
  }

  // Kaiser-windowed-sinc interpolation bank: phase p gives the value at
  // i + p/4 from samples i-15 .. i+16 (32 taps, flat to ~0.44*fs, i.e.
  // ~19.5 kHz at 44.1 kHz -- shorter filters under-read bright material). `l1` is
  // the largest sum of absolute tap values -- the most any interpolated
  // point can exceed the largest nearby sample by, which lets regions that
  // can't matter be skipped with no loss of accuracy.
  var TP_OS = 4, TP_TAPS = 32, TP_BANK = null;
  function getTruePeakBank() {
    if (TP_BANK) return TP_BANK;
    var half = TP_TAPS / 2, beta = 8.0, i0b = besselI0(beta);
    var h = [];
    var l1 = 0;
    for (var p = 1; p < TP_OS; p++) {
      var frac = p / TP_OS, sum = 0, k;
      var taps = new Float64Array(TP_TAPS);
      for (k = 0; k < TP_TAPS; k++) {
        var x = (k - half + 1) - frac;
        var sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        var r = x / half;
        var win = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
        taps[k] = sinc * win;
        sum += taps[k];
      }
      var a = 0;
      for (k = 0; k < TP_TAPS; k++) { taps[k] /= sum; a += Math.abs(taps[k]); }
      if (a > l1) l1 = a;
      h.push(taps);
    }
    TP_BANK = { h: h, half: half, n: TP_TAPS, l1: l1 * 1.0001 };
    return TP_BANK;
  }

  var TP_BLOCK = 256;

  // Per-block max |sample| over all channels, and the same widened to the
  // neighbouring blocks (covers the filter's +-16 sample reach).
  function blockNeighbourhoodMaxima(channels) {
    var n = channels[0].length;
    var nb = Math.ceil(n / TP_BLOCK);
    var bmax = new Float32Array(nb);
    for (var c = 0; c < channels.length; c++) {
      var chan = channels[c];
      for (var b = 0; b < nb; b++) {
        var end = Math.min(n, (b + 1) * TP_BLOCK), m = bmax[b];
        for (var i = b * TP_BLOCK; i < end; i++) {
          var a = chan[i] < 0 ? -chan[i] : chan[i];
          if (a > m) m = a;
        }
        bmax[b] = m;
      }
    }
    var nbm = new Float32Array(nb);
    for (var q = 0; q < nb; q++) {
      var mm = bmax[q];
      if (q > 0 && bmax[q - 1] > mm) mm = bmax[q - 1];
      if (q + 1 < nb && bmax[q + 1] > mm) mm = bmax[q + 1];
      nbm[q] = mm;
    }
    return { bmax: bmax, nbm: nbm };
  }

  // Interpolated (4x) peaks between frames i and i+1 for i in [s, e) of one
  // channel -- all three phases from one pass over the taps. Raises det[i]
  // when `det` is given, otherwise returns the running max `best`.
  function interpBlock(chan, s, e, n, bank, det, best) {
    var h1 = bank.h[0], h2 = bank.h[1], h3 = bank.h[2], T = bank.n, off = bank.half - 1;
    for (var i = s; i < e; i++) {
      var st = i - off, v1 = 0, v2 = 0, v3 = 0, k, x;
      if (st >= 0 && st + T <= n) {
        for (k = 0; k < T; k++) { x = chan[st + k]; v1 += h1[k] * x; v2 += h2[k] * x; v3 += h3[k] * x; }
      } else {
        for (k = 0; k < T; k++) {
          var j = st + k;
          if (j >= 0 && j < n) { x = chan[j]; v1 += h1[k] * x; v2 += h2[k] * x; v3 += h3[k] * x; }
        }
      }
      if (v1 < 0) v1 = -v1;
      if (v2 < 0) v2 = -v2;
      if (v3 < 0) v3 = -v3;
      var m = v1 > v2 ? v1 : v2;
      if (v3 > m) m = v3;
      if (det) { if (m > det[i]) det[i] = m; } else if (m > best) best = m;
    }
    return best;
  }

  // Lazy per-frame true-peak detector for the limiter. det[i] starts as the
  // max |sample| across channels; ensure(gate) upgrades it to the true
  // (interpolated) peak in every block whose neighbourhood could possibly
  // reach `gate`. Blocks that provably can't are never interpolated, and
  // blocks already done are never redone when a later loudness iteration
  // raises the gain.
  function makeTruePeakDetector(channels) {
    var bank = getTruePeakBank();
    var n = channels[0].length;
    var det = new Float32Array(n);
    for (var c = 0; c < channels.length; c++) {
      var chan = channels[c];
      for (var i = 0; i < n; i++) {
        var a = chan[i] < 0 ? -chan[i] : chan[i];
        if (a > det[i]) det[i] = a;
      }
    }
    var nbm = blockNeighbourhoodMaxima(channels).nbm;
    var done = new Uint8Array(nbm.length);
    return {
      det: det,
      ensure: function (gateLin) {
        for (var b = 0; b < nbm.length; b++) {
          if (done[b] || nbm[b] * bank.l1 <= gateLin) continue;
          var s = b * TP_BLOCK, e = Math.min(n, s + TP_BLOCK);
          for (var c2 = 0; c2 < channels.length; c2++) interpBlock(channels[c2], s, e, n, bank, det, 0);
          done[b] = 1;
        }
        return det;
      }
    };
  }

  function truePeakDetector(channels, gateLin) {
    return makeTruePeakDetector(channels).ensure(gateLin);
  }

  // True-peak meter (linear). Loudest neighbourhoods first; stops as soon
  // as no remaining block can beat the best value found.
  function truePeak(channels) {
    var n = channels[0].length;
    if (n === 0) return 0;
    var bank = getTruePeakBank();
    var bm = blockNeighbourhoodMaxima(channels);
    var nb = bm.nbm.length, nbm = bm.nbm;
    var best = 0;
    var order = new Array(nb);
    for (var b = 0; b < nb; b++) {
      if (bm.bmax[b] > best) best = bm.bmax[b];
      order[b] = b;
    }
    if (best === 0) return 0;
    order.sort(function (x, y) { return nbm[y] - nbm[x]; });
    for (var q = 0; q < nb; q++) {
      var bb = order[q];
      if (nbm[bb] * bank.l1 <= best) break;
      var s = bb * TP_BLOCK, e = Math.min(n, s + TP_BLOCK);
      for (var c = 0; c < channels.length; c++) best = interpBlock(channels[c], s, e, n, bank, null, best);
    }
    return best;
  }

  function linearToDb(x) {
    if (x <= 0) return -Infinity;
    return 20 * Math.log10(x);
  }
  function dbToLinear(db) {
    return Math.pow(10, db / 20);
  }

  function rms(channels) {
    var sum = 0, n = 0;
    for (var c = 0; c < channels.length; c++) {
      var chan = channels[c];
      for (var i = 0; i < chan.length; i++) { sum += chan[i] * chan[i]; n++; }
    }
    if (n === 0) return 0;
    return Math.sqrt(sum / n);
  }

  function crestFactorDb(channels) {
    var peak = samplePeak(channels);
    var r = rms(channels);
    if (r <= 0 || peak <= 0) return 20; // treat silence/degenerate as "dynamic" -> safe default
    return linearToDb(peak) - linearToDb(r);
  }

  // ---------------------------------------------------------------------
  // Gentle glue compressor: feed-forward, smoothed peak detector (in dB),
  // soft-knee. Same gain-reduction curve is computed from the linked
  // (max-across-channels) envelope and applied identically to every
  // channel so the stereo image is preserved. opts.inPlace overwrites the
  // input instead of allocating (safe: each frame is read before written).
  // ---------------------------------------------------------------------
  function glueCompress(channels, sampleRate, opts) {
    opts = opts || {};
    var thresholdDb = opts.thresholdDb != null ? opts.thresholdDb : -24;
    var ratio = opts.ratio != null ? opts.ratio : 1.8;
    var kneeDb = opts.kneeDb != null ? opts.kneeDb : 6;
    var attackMs = opts.attackMs != null ? opts.attackMs : 15;
    var releaseMs = opts.releaseMs != null ? opts.releaseMs : 250;
    var makeupDb = opts.makeupDb != null ? opts.makeupDb : 0;

    var n = channels[0].length;
    var numChannels = channels.length;
    var attackCoef = Math.exp(-1 / (0.001 * attackMs * sampleRate));
    var releaseCoef = Math.exp(-1 / (0.001 * releaseMs * sampleRate));

    var out;
    if (opts.inPlace) {
      out = channels;
    } else {
      out = [];
      for (var c = 0; c < numChannels; c++) out.push(new Float32Array(n));
    }

    var envDb = -100; // running detector level in dB
    var makeupLin = dbToLinear(makeupDb);

    for (var i = 0; i < n; i++) {
      // Linked detector: max instantaneous abs sample across channels this frame.
      var maxAbs = 0;
      for (var c2 = 0; c2 < numChannels; c2++) {
        var a = Math.abs(channels[c2][i]);
        if (a > maxAbs) maxAbs = a;
      }
      var inDb = maxAbs > 0 ? linearToDb(maxAbs) : -100;

      // Smooth the detector (simple one-pole attack/release follower).
      if (inDb > envDb) {
        envDb = attackCoef * envDb + (1 - attackCoef) * inDb;
      } else {
        envDb = releaseCoef * envDb + (1 - releaseCoef) * inDb;
      }

      // Soft-knee gain computer (Giannoulis/Massberg/Reiss). Within the
      // knee the reduction is (1 - 1/ratio) * (over + knee/2)^2 / (2*knee)
      // -- note (1 - 1/ratio), NOT (1/ratio - 1): the wrong sign made this
      // branch disagree with the linear branch at the knee edge (a ~2.7 dB
      // gain snap on one sample, audible as clicking). This form is
      // continuous with both neighbouring regions.
      var over = envDb - thresholdDb;
      var gainReductionDb = 0;
      if (over > kneeDb / 2) {
        gainReductionDb = over - over / ratio;
      } else if (over > -kneeDb / 2) {
        var kneeX = over + kneeDb / 2;
        gainReductionDb = (1 - 1 / ratio) * (kneeX * kneeX) / (2 * kneeDb);
      }
      var gainLin = gainReductionDb === 0 ? makeupLin : dbToLinear(-gainReductionDb) * makeupLin;

      for (var c3 = 0; c3 < numChannels; c3++) {
        out[c3][i] = channels[c3][i] * gainLin;
      }
    }

    return out;
  }

  // ---------------------------------------------------------------------
  // True-peak brickwall limiter, linked across channels.
  //
  //  need[j]  gain that sample j needs so its TRUE peak (det) * gain stays
  //           under the ceiling
  //  h[k]     minimum of need over [k-W, k+L+W)   (look-ahead hold)
  //  r[k]     h with a smooth exponential release (always <= h)
  //  g[t]     average of r over [t-L+1, t]         (smooth attack ramp)
  //
  // Averaging only values that are each <= every need in [t-W, t+W]
  // keeps g[t] <= need there, so no frame -- nor the interpolated signal
  // around it -- goes over, while the gain glides down over the look-ahead
  // window instead of stepping (a step is an audible click; v1.0 did that).
  // Writes src * gainLin * g into `out` (preallocated, may not alias src).
  // ---------------------------------------------------------------------
  function limitTruePeak(src, det, gainLin, ceilingLin, sampleRate, out, opts) {
    opts = opts || {};
    var lookaheadMs = opts.lookaheadMs != null ? opts.lookaheadMs : 5;
    var releaseMs = opts.releaseMs != null ? opts.releaseMs : 60;
    var n = src[0].length;
    var numChannels = src.length;
    var L = Math.max(1, Math.round(0.001 * lookaheadMs * sampleRate));
    var W = getTruePeakBank().half + 1;
    var rc = Math.exp(-1 / (0.001 * releaseMs * sampleRate));
    var cap = L + 2 * W + 2;
    var dqIdx = new Int32Array(cap), dqVal = new Float64Array(cap);
    var head = 0, size = 0, nextPush = 0;
    var box = new Float64Array(L), boxSum = 0, boxPos = 0;
    var r = 1.0;
    var minGain = 1.0;

    for (var k = -(L - 1); k < n; k++) {
      var right = k + L + W - 1;
      while (nextPush <= right && nextPush < n) {
        var d = det[nextPush] * gainLin;
        var v = d > ceilingLin ? ceilingLin / d : 1.0;
        while (size > 0) {
          var backPos = head + size - 1; if (backPos >= cap) backPos -= cap;
          if (dqVal[backPos] >= v) size--; else break;
        }
        var pos = head + size; if (pos >= cap) pos -= cap;
        dqIdx[pos] = nextPush; dqVal[pos] = v; size++;
        nextPush++;
      }
      var left = k - W;
      while (size > 0 && dqIdx[head] < left) { head++; if (head === cap) head = 0; size--; }
      var h = size > 0 ? dqVal[head] : 1.0;
      if (h < r) r = h; else r = rc * r + (1 - rc) * h;
      boxSum += r - box[boxPos]; box[boxPos] = r; boxPos++; if (boxPos === L) boxPos = 0;
      if (k >= 0) {
        var g = boxSum / L;
        if (g > 1) g = 1;
        if (g < minGain) minGain = g;
        var gl = g * gainLin;
        for (var c = 0; c < numChannels; c++) out[c][k] = src[c][k] * gl;
      }
    }
    return { maxReductionDb: -linearToDb(minGain) };
  }

  // Back-compat wrapper (v1.0 signature): returns new, limited channels.
  function limit(channels, sampleRate, ceilingLin, opts) {
    var det = truePeakDetector(channels, ceilingLin);
    var out = channels.map(function (c) { return new Float32Array(c.length); });
    limitTruePeak(channels, det, 1, ceilingLin, sampleRate, out, opts);
    return out;
  }

  // ---------------------------------------------------------------------
  // Optional "Advanced" processing steps -- all strict no-ops at their
  // default/neutral settings. Each has an in-place form (used by master()
  // to keep memory flat) and a pure form that never mutates its input.
  // ---------------------------------------------------------------------

  // 3-band tone EQ: low shelf (bass), mid bell (mid), high shelf (treble).
  function toneEQBands(opts) {
    opts = opts || {};
    function clampDb(v) { v = v || 0; if (v > 12) v = 12; if (v < -12) v = -12; return v; }
    return { bassDb: clampDb(opts.bassDb), midDb: clampDb(opts.midDb), trebleDb: clampDb(opts.trebleDb) };
  }
  function applyToneEQInPlace(channels, sampleRate, opts) {
    var bands = toneEQBands(opts);
    var coefs = [];
    if (bands.bassDb !== 0) coefs.push(makeBiquad('lowshelf', 120, Math.SQRT1_2, bands.bassDb, sampleRate));
    if (bands.midDb !== 0) coefs.push(makeBiquad('peaking', 1000, 1.0, bands.midDb, sampleRate));
    if (bands.trebleDb !== 0) coefs.push(makeBiquad('highshelf', 8000, Math.SQRT1_2, bands.trebleDb, sampleRate));
    coefs.forEach(function (coef) { channels.forEach(function (chan) { applyBiquadInPlace(chan, coef); }); });
    return channels;
  }
  function applyToneEQ(channels, sampleRate, opts) {
    var b = toneEQBands(opts);
    if (b.bassDb === 0 && b.midDb === 0 && b.trebleDb === 0) return channels;
    return applyToneEQInPlace(copyChannels(channels), sampleRate, opts);
  }

  // Stereo width via mid/side scaling: 100 = unchanged, 0 = fully mono,
  // 200 = doubled side signal. No-op for mono input or width===100.
  function clampWidth(widthPct) {
    if (widthPct == null || !isFinite(widthPct)) widthPct = 100;
    if (widthPct < 0) widthPct = 0;
    if (widthPct > 200) widthPct = 200;
    return widthPct;
  }
  function applyStereoWidthInPlace(channels, widthPct) {
    widthPct = clampWidth(widthPct);
    if (channels.length !== 2 || widthPct === 100) return channels;
    var width = widthPct / 100;
    var L = channels[0], R = channels[1];
    for (var i = 0; i < L.length; i++) {
      var mid = (L[i] + R[i]) * 0.5;
      var side = (L[i] - R[i]) * 0.5 * width;
      L[i] = mid + side;
      R[i] = mid - side;
    }
    return channels;
  }
  function applyStereoWidth(channels, widthPct) {
    if (channels.length !== 2 || clampWidth(widthPct) === 100) return channels;
    return applyStereoWidthInPlace(copyChannels(channels), widthPct);
  }

  // Trims leading/trailing near-silence (below thresholdDb, default
  // -50dBFS) and applies a short fade (default 15ms) only at an edge that
  // was actually cut, so the cut never clicks -- while a track that starts
  // or ends on a hard hit right at the file boundary keeps its transient.
  // A track that is silent throughout is left untouched.
  function trimSilenceAndFade(channels, sampleRate, opts) {
    opts = opts || {};
    var thresholdDb = opts.thresholdDb != null ? opts.thresholdDb : -50;
    var fadeMs = opts.fadeMs != null ? opts.fadeMs : 15;
    var thresholdLin = dbToLinear(thresholdDb);
    var numChannels = channels.length;
    var n = channels[0].length;

    function frameAbsMax(i) {
      var m = 0;
      for (var c = 0; c < numChannels; c++) {
        var a = Math.abs(channels[c][i]);
        if (a > m) m = a;
      }
      return m;
    }

    var start = 0;
    while (start < n && frameAbsMax(start) < thresholdLin) start++;
    var end = n - 1;
    while (end > start && frameAbsMax(end) < thresholdLin) end--;

    // Nothing above the threshold anywhere (silent/near-silent file), or
    // it already starts/ends "loud" -- leave it exactly as-is: no trim,
    // no fade, and no copy.
    if (start >= end) {
      return { channels: channels, trimmedStartSamples: 0, trimmedEndSamples: 0 };
    }
    var trimmedStart = start;
    var trimmedEnd = (n - 1) - end;
    if (trimmedStart === 0 && trimmedEnd === 0) {
      return { channels: channels, trimmedStartSamples: 0, trimmedEndSamples: 0 };
    }

    // slice() copies, so the fade below never touches the caller's buffers.
    var trimmed = channels.map(function (chan) { return chan.slice(start, end + 1); });
    var newLen = trimmed[0].length;
    var fadeSamples = Math.min(Math.round(0.001 * fadeMs * sampleRate), Math.floor(newLen / 2));
    if (fadeSamples > 0) {
      trimmed.forEach(function (chan) {
        for (var i = 0; i < fadeSamples; i++) {
          var g = i / fadeSamples;
          if (trimmedStart > 0) chan[i] *= g;
          if (trimmedEnd > 0) chan[newLen - 1 - i] *= g;
        }
      });
    }

    return { channels: trimmed, trimmedStartSamples: trimmedStart, trimmedEndSamples: trimmedEnd };
  }

  // Sums the low end (below crossoverHz) to mono while leaving everything
  // above the crossover in stereo. Implemented via mid/side: only the SIDE
  // signal is high-passed at the crossover, so below it L and R converge
  // to identical (mono) while above it width is preserved. (A per-channel
  // lowpass split leaked a lot of low end into the non-mono'd residual
  // around the crossover: ~72% of a 60 Hz L/R difference remained, vs ~24%
  // with the side-only high-pass.)
  function applyBassMonoInPlace(channels, sampleRate, opts) {
    opts = opts || {};
    if (!opts.enabled) return channels;
    if (channels.length !== 2) return channels; // nothing to "mono" on mono input
    var crossoverHz = opts.crossoverHz != null ? opts.crossoverHz : 120;
    var hpCoef = makeBiquad('highpass', crossoverHz, Math.SQRT1_2, 0, sampleRate);
    var L = channels[0], R = channels[1];
    var n = L.length;
    var side = new Float32Array(n);
    for (var i = 0; i < n; i++) side[i] = (L[i] - R[i]) * 0.5;
    applyBiquadInPlace(side, hpCoef);
    for (var j = 0; j < n; j++) {
      var mid = (L[j] + R[j]) * 0.5;
      L[j] = mid + side[j];
      R[j] = mid - side[j];
    }
    return channels;
  }
  function applyBassMono(channels, sampleRate, opts) {
    if (!opts || !opts.enabled || channels.length !== 2) return channels;
    return applyBassMonoInPlace(copyChannels(channels), sampleRate, opts);
  }

  // Splits into low/mid/high bands via an exact complementary split
  // (low = lowpass(x, lowHz), high = highpass(x, highHz), mid = x - low -
  // high -- low + mid + high reconstructs the original exactly), compresses
  // each band with its own glue-compressor settings, then sums the bands
  // back together. Catches what a single full-band compressor can't: a
  // loud kick pumping down the highs, or a cymbal wash dulling the bass.
  function multibandCompress(channels, sampleRate, opts) {
    opts = opts || {};
    var lowHz = opts.lowHz != null ? opts.lowHz : 150;
    var highHz = opts.highHz != null ? opts.highHz : 3000;
    // Per-band defaults: bass gets a slower attack (fast gain changes on
    // low frequencies distort the waveform of the cycle itself) and more
    // release time; highs get a fast attack and quicker release so
    // cymbals/hats don't visibly pump.
    var lowOpts = opts.low || { thresholdDb: -22, ratio: 1.6, kneeDb: 6, attackMs: 30, releaseMs: 300 };
    var midOpts = opts.mid || { thresholdDb: -24, ratio: 1.8, kneeDb: 6, attackMs: 15, releaseMs: 250 };
    var highOpts = opts.high || { thresholdDb: -26, ratio: 1.8, kneeDb: 6, attackMs: 5, releaseMs: 150 };
    function inPlace(o) { var r = {}; for (var key in o) r[key] = o[key]; r.inPlace = true; return r; }

    var lpCoef = makeBiquad('lowpass', lowHz, Math.SQRT1_2, 0, sampleRate);
    var hpCoef = makeBiquad('highpass', highHz, Math.SQRT1_2, 0, sampleRate);

    var lowBand = channels.map(function (chan) { return applyBiquad(chan, lpCoef); });
    var highBand = channels.map(function (chan) { return applyBiquad(chan, hpCoef); });
    var midBand = channels.map(function (chan, c) {
      var n = chan.length;
      var out = new Float32Array(n);
      var lb = lowBand[c], hb = highBand[c];
      for (var i = 0; i < n; i++) out[i] = chan[i] - lb[i] - hb[i];
      return out;
    });

    glueCompress(lowBand, sampleRate, inPlace(lowOpts));
    glueCompress(midBand, sampleRate, inPlace(midOpts));
    glueCompress(highBand, sampleRate, inPlace(highOpts));

    var numChannels = channels.length;
    var n2 = channels[0].length;
    var out = opts.inPlace ? channels : [];
    for (var c2 = 0; c2 < numChannels; c2++) {
      var sum = opts.inPlace ? channels[c2] : new Float32Array(n2);
      var lc = lowBand[c2], mc = midBand[c2], hc = highBand[c2];
      for (var i2 = 0; i2 < n2; i2++) sum[i2] = lc[i2] + mc[i2] + hc[i2];
      if (!opts.inPlace) out.push(sum);
    }
    return out;
  }

  // Gentle harmonic saturation ("warmth") via a tanh soft-clip blended
  // with the dry signal. amount<=0 is an exact no-op. The tanh curve is
  // normalized (divided by tanh(drive)) so a full-scale sample maps back
  // to itself -- it adds harmonics/density without raising the level,
  // leaving loudness matching and the limiter in control of the result.
  function saturationParams(opts) {
    opts = opts || {};
    var amount = opts.amount != null ? opts.amount : 0;
    if (!(amount > 0)) return null;
    if (amount > 100) amount = 100;
    var mix = amount / 100;
    var drive = 1 + mix * 5; // 1 (gentle) .. 6 (noticeably driven)
    return { mix: mix, drive: drive, driveTanh: Math.tanh(drive) };
  }
  function saturateInto(src, dst, p) {
    for (var i = 0; i < src.length; i++) {
      var x = src[i];
      var wet = Math.tanh(p.drive * x) / p.driveTanh;
      dst[i] = x + (wet - x) * p.mix;
    }
    return dst;
  }
  function applySaturationInPlace(channels, opts) {
    var p = saturationParams(opts);
    if (!p) return channels;
    channels.forEach(function (chan) { saturateInto(chan, chan, p); });
    return channels;
  }
  function applySaturation(channels, opts) {
    var p = saturationParams(opts);
    if (!p) return channels;
    return channels.map(function (chan) { return saturateInto(chan, new Float32Array(chan.length), p); });
  }

  // ---------------------------------------------------------------------
  // Full mastering chain
  // ---------------------------------------------------------------------
  function analyze(decoded, knownTruePeakLin) {
    var lufs = integratedLoudness(decoded.channels, decoded.sampleRate);
    var truePeakLin = knownTruePeakLin != null ? knownTruePeakLin : truePeak(decoded.channels);
    var crest = crestFactorDb(decoded.channels);
    return {
      lufs: lufs,
      truePeakDb: linearToDb(truePeakLin),
      samplePeakDb: linearToDb(samplePeak(decoded.channels)),
      crestFactorDb: crest,
      durationSec: decoded.frameCount / decoded.sampleRate
    };
  }

  function master(decoded, presetId, opts) {
    opts = opts || {};
    var sampleRate = decoded.sampleRate;
    var inputAnalysis = analyze(decoded); // always measured on the untouched original upload
    var preset = resolvePreset(presetId, inputAnalysis.crestFactorDb);
    var isEffectivelySilent = !isFinite(inputAnalysis.lufs) || inputAnalysis.lufs < -60;

    // 0) Optional: trim leading/trailing near-silence and fade the cut
    // edges. Runs first so every later step (and the exported length)
    // works on the trimmed material; inputAnalysis still reflects the
    // original upload as-is.
    var trimResult = opts.trimSilence
      ? trimSilenceAndFade(decoded.channels, sampleRate)
      : { channels: decoded.channels, trimmedStartSamples: 0, trimmedEndSamples: 0 };

    // One working copy; every stage below runs in place on it. The copy is
    // skipped when trimming already produced fresh buffers, or when the
    // caller says the decoded audio may be consumed (opts.inPlace -- the
    // browser worker does this; it has no further use for the original).
    var work;
    if (trimResult.channels !== decoded.channels || opts.inPlace) work = trimResult.channels;
    else work = copyChannels(decoded.channels);

    // 1) DC offset removal (per-channel mean subtraction).
    work.forEach(function (chan) {
      var sum = 0;
      for (var i = 0; i < chan.length; i++) sum += chan[i];
      var mean = chan.length ? sum / chan.length : 0;
      if (Math.abs(mean) < 1e-6) return; // nothing meaningful to remove
      for (var j = 0; j < chan.length; j++) chan[j] -= mean;
    });

    // 2) Rumble high-pass at 20Hz -- removes inaudible sub content that
    // eats headroom without adding perceived loudness.
    var rumbleCoef = makeBiquad('highpass', 20.0, Math.SQRT1_2, 0.0, sampleRate);
    work.forEach(function (chan) { applyBiquadInPlace(chan, rumbleCoef); });

    // 2a) Reference-level pre-gain (see REFERENCE_LUFS): makes saturation
    // and compression independent of the export level of the mix.
    var preGainDb = 0;
    if (!isEffectivelySilent) {
      preGainDb = REFERENCE_LUFS - inputAnalysis.lufs;
      if (preGainDb > 30) preGainDb = 30;
      if (preGainDb < -30) preGainDb = -30;
      scaleInPlace(work, dbToLinear(preGainDb));
    }

    // 2b) Optional tonal EQ (bass/mid/treble) -- before dynamics, so the
    // compressor/limiter react to the tonally-shaped signal.
    if (opts.eq) applyToneEQInPlace(work, sampleRate, opts.eq);

    // 2c) Optional stereo width -- no-op for mono input or 100%.
    if (opts.stereoWidthPct != null) applyStereoWidthInPlace(work, opts.stereoWidthPct);

    // 2d) Optional bass-mono -- after width (so a user-chosen width is
    // respected everywhere except the summed low end), before dynamics.
    if (opts.bassMono) applyBassMonoInPlace(work, sampleRate, { enabled: true, crossoverHz: opts.bassMonoHz });

    // 2e) Optional saturation/warmth.
    if (opts.saturation && opts.saturation.amount > 0) applySaturationInPlace(work, opts.saturation);

    // 3) Dynamics: gentle glue compression, single full-band (default) or
    // multiband. Skipped entirely on near-silent input either way.
    if (!isEffectivelySilent) {
      if (opts.multiband) {
        var mbOpts = typeof opts.multiband === 'object' ? opts.multiband : {};
        var mb = {}; for (var key in mbOpts) mb[key] = mbOpts[key];
        mb.inPlace = true;
        multibandCompress(work, sampleRate, mb);
      } else {
        glueCompress(work, sampleRate, {
          thresholdDb: -24, ratio: 1.8, kneeDb: 6, attackMs: 15, releaseMs: 250, inPlace: true
        });
      }
    }

    // 4) Loudness normalization THROUGH the true-peak limiter. Limiting
    // lowers loudness, so the gain is re-solved (secant steps) until the
    // limited result sits on the target, instead of normalizing first and
    // shipping whatever the limiter leaves (v1.0 missed Club by up to 3 dB).
    var ceilingPubLin = dbToLinear(preset.ceilingDbTP);
    var ceilingLin = dbToLinear(preset.ceilingDbTP - LIMITER_MARGIN_DB);
    var target = preset.targetLUFS;
    var postCompLUFS = isEffectivelySilent ? -Infinity : integratedLoudness(work, sampleRate);
    var baseGainDb = 0;
    if (!isEffectivelySilent && isFinite(postCompLUFS)) {
      baseGainDb = target - postCompLUFS;
      // Sanity clamp: never apply an absurd gain.
      if (baseGainDb > 40) baseGainDb = 40;
      if (baseGainDb < -40) baseGainDb = -40;
    }
    var maxGainDb = Math.min(40, baseGainDb + MAX_LIMITER_PUSH_DB);
    var minGainDb = baseGainDb - MAX_LIMITER_PUSH_DB;

    var tpd = makeTruePeakDetector(work);
    var out = work.map(function (c) { return new Float32Array(c.length); });
    var gainDb = baseGainDb, prevGainDb = null, prevLufs = null, lim = null, outLufs = -Infinity;
    for (var iter = 0; ; iter++) {
      var gainLin = dbToLinear(gainDb);
      tpd.ensure(ceilingLin / gainLin);
      lim = limitTruePeak(work, tpd.det, gainLin, ceilingLin, sampleRate, out, { lookaheadMs: 5, releaseMs: 60 });
      if (isEffectivelySilent) break;
      outLufs = integratedLoudness(out, sampleRate);
      if (!isFinite(outLufs)) break;
      var err = target - outLufs;
      if (Math.abs(err) <= LOUDNESS_TOLERANCE_DB || iter >= LOUDNESS_MAX_ITERATIONS - 1) break;
      var next = gainDb + err;
      if (prevGainDb !== null && gainDb !== prevGainDb) {
        var slope = (outLufs - prevLufs) / (gainDb - prevGainDb);
        if (slope > 0.05) next = gainDb + err / slope;
      }
      if (next > maxGainDb) next = maxGainDb;
      if (next < minGainDb) next = minGainDb;
      if (Math.abs(next - gainDb) < 0.005) break; // pinned at the push limit
      prevGainDb = gainDb; prevLufs = outLufs; gainDb = next;
    }
    tpd = null; work = null;

    // 5) Final verification with the true-peak meter. The limiter already
    // keeps a margin, so this is a last-resort guarantee: if anything
    // still reads over the published ceiling, trim the whole file.
    var tpOut = truePeak(out);
    if (tpOut > ceilingPubLin) {
      var trim = (ceilingPubLin / tpOut) * 0.9995;
      scaleInPlace(out, trim);
      tpOut *= trim;
    }

    var outputAnalysis = analyze({ channels: out, sampleRate: sampleRate, frameCount: out[0].length }, tpOut);

    return {
      channels: out,
      sampleRate: sampleRate,
      preset: preset,
      input: inputAnalysis,
      output: outputAnalysis,
      appliedGainDb: preGainDb + gainDb,
      limiterMaxReductionDb: lim ? lim.maxReductionDb : 0,
      targetReached: isEffectivelySilent || (isFinite(outputAnalysis.lufs) && Math.abs(outputAnalysis.lufs - target) <= 0.5),
      silent: isEffectivelySilent,
      trimmedStartSamples: trimResult.trimmedStartSamples,
      trimmedEndSamples: trimResult.trimmedEndSamples
    };
  }

  return {
    PRESETS: PRESETS,
    parseWav: parseWav,
    encodeWav: encodeWav,
    analyze: analyze,
    master: master,
    // exported for testing:
    _internal: {
      makeBiquad: makeBiquad,
      applyBiquad: applyBiquad,
      integratedLoudness: integratedLoudness,
      truePeak: truePeak,
      truePeakDetector: truePeakDetector,
      estimateTruePeakLinear: truePeak, // v1.0 name, kept for existing tests
      samplePeak: samplePeak,
      crestFactorDb: crestFactorDb,
      glueCompress: glueCompress,
      limit: limit,
      limitTruePeak: limitTruePeak,
      linearToDb: linearToDb,
      dbToLinear: dbToLinear,
      resolvePreset: resolvePreset,
      applyToneEQ: applyToneEQ,
      applyStereoWidth: applyStereoWidth,
      trimSilenceAndFade: trimSilenceAndFade,
      applyBassMono: applyBassMono,
      multibandCompress: multibandCompress,
      applySaturation: applySaturation
    }
  };
});

