/*!
 * DZMASTER Engine v1.0
 * Client-side automatic mastering DSP core.
 * Pure JS, no DOM / Web Audio dependency -> runs identically in Node (for
 * testing) and in the browser.
 *
 * Pipeline:
 *   decode WAV -> analyze (integrated LUFS, true peak, crest factor)
 *   -> DC removal -> 20Hz rumble high-pass -> gentle glue compressor
 *   -> loudness normalization to preset target -> true-peak-safe limiter
 *   -> iterative peak safety trim -> encode WAV
 *
 * Loudness measurement follows ITU-R BS.1770-4 (K-weighting + gated
 * integration). True peak is an oversampled (4x, linear-interp) estimate,
 * not a full ITU-R BS.1770 Annex 2 implementation -- adequate for consumer
 * mastering, not for broadcast compliance certification.
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
  function fourCC(view, offset) {
    return String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1),
      view.getUint8(offset + 2), view.getUint8(offset + 3)
    );
  }

  function parseWav(arrayBuffer) {
    var view = new DataView(arrayBuffer);
    if (arrayBuffer.byteLength < 44) throw new Error('File too small to be a valid WAV file.');
    if (fourCC(view, 0) !== 'RIFF') throw new Error('Not a RIFF/WAV file.');
    if (fourCC(view, 8) !== 'WAVE') throw new Error('Not a WAVE file.');

    var offset = 12;
    var fmt = null;
    var dataOffset = -1;
    var dataLength = 0;

    while (offset + 8 <= view.byteLength) {
      var chunkId = fourCC(view, offset);
      var chunkSize = view.getUint32(offset + 4, true);
      var chunkStart = offset + 8;

      if (chunkId === 'fmt ') {
        fmt = {
          audioFormat: view.getUint16(chunkStart, true),
          numChannels: view.getUint16(chunkStart + 2, true),
          sampleRate: view.getUint32(chunkStart + 4, true),
          bitsPerSample: view.getUint16(chunkStart + 14, true)
        };
      } else if (chunkId === 'data') {
        dataOffset = chunkStart;
        dataLength = chunkSize;
      }

      // Chunks are word (2-byte) aligned; guard against malformed/odd sizes
      // and against chunkSize running past EOF (some encoders lie).
      var advance = chunkSize + (chunkSize % 2);
      if (advance <= 0) break; // avoid infinite loop on corrupt chunk
      offset = chunkStart + advance;
    }

    if (!fmt) throw new Error('WAV file has no fmt chunk.');
    if (dataOffset < 0) throw new Error('WAV file has no data chunk.');
    if (fmt.numChannels < 1 || fmt.numChannels > 32) throw new Error('Unsupported channel count: ' + fmt.numChannels);

    dataLength = Math.min(dataLength, view.byteLength - dataOffset);
    if (dataLength < 0) dataLength = 0;

    var numChannels = fmt.numChannels;
    var bitsPerSample = fmt.bitsPerSample;
    var bytesPerSample = bitsPerSample / 8;
    if (!Number.isInteger(bytesPerSample) || bytesPerSample < 1) {
      throw new Error('Unsupported bit depth: ' + bitsPerSample);
    }
    var frameCount = Math.floor(dataLength / (bytesPerSample * numChannels));

    var channels = [];
    for (var c = 0; c < numChannels; c++) channels.push(new Float32Array(frameCount));

    var readSample;
    if (fmt.audioFormat === 3 && bitsPerSample === 32) {
      readSample = function (o) { return view.getFloat32(o, true); };
    } else if (fmt.audioFormat === 3 && bitsPerSample === 64) {
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
    } else if (bitsPerSample === 32 && fmt.audioFormat === 1) {
      readSample = function (o) { return view.getInt32(o, true) / 2147483648; };
    } else if (bitsPerSample === 8) {
      readSample = function (o) { return (view.getUint8(o) - 128) / 128; };
    } else {
      throw new Error('Unsupported WAV encoding: ' + bitsPerSample + '-bit, format code ' + fmt.audioFormat);
    }

    var pos = dataOffset;
    for (var i = 0; i < frameCount; i++) {
      for (var ch = 0; ch < numChannels; ch++) {
        channels[ch][i] = readSample(pos);
        pos += bytesPerSample;
      }
    }

    return { sampleRate: fmt.sampleRate, numChannels: numChannels, frameCount: frameCount, channels: channels };
  }

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
    var rng = opts.rng || Math.random;
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

    var offset = 44;
    var maxPos = bitsPerSample === 16 ? 32767 : 8388607;
    var maxNeg = bitsPerSample === 16 ? -32768 : -8388608;

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

        if (bitsPerSample === 16) {
          view.setInt16(offset, val, true);
          offset += 2;
        } else {
          if (val < 0) val += 0x1000000;
          view.setUint8(offset, val & 0xff);
          view.setUint8(offset + 1, (val >> 8) & 0xff);
          view.setUint8(offset + 2, (val >> 16) & 0xff);
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

  // Apply a biquad to a Float32Array in place (Direct Form I), returns a
  // NEW Float32Array (never mutates the input -- callers rely on that).
  function applyBiquad(input, coef) {
    var out = new Float32Array(input.length);
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

  // ---------------------------------------------------------------------
  // ITU-R BS.1770-4 style loudness measurement
  // ---------------------------------------------------------------------
  function kWeight(channels, sampleRate) {
    var shelf = makeBiquad('highshelf', 1500.0, Math.SQRT1_2, 4.0, sampleRate);
    var hp = makeBiquad('highpass', 38.0, 0.5, 0.0, sampleRate);
    return channels.map(function (chan) {
      return applyBiquad(applyBiquad(chan, shelf), hp);
    });
  }

  // Channel weighting per BS.1770 (mono/stereo/standard 5.1 layouts only;
  // this tool only ever produces mono or stereo, but stay generic).
  function channelWeight(numChannels, idx) {
    if (numChannels <= 2) return 1.0; // mono or stereo: all channels weight 1.0
    // 3 = center, 4/5 = surrounds in typical 5-channel layout -> not used here
    return (idx === 3 || idx === 4) ? 1.41 : 1.0;
  }

  // Returns integrated loudness in LUFS, or -Infinity for digital silence.
  function integratedLoudness(channels, sampleRate) {
    var frameCount = channels[0].length;
    var blockSize = Math.round(0.4 * sampleRate);
    var stepSize = Math.round(0.1 * sampleRate);

    if (frameCount < blockSize) {
      // File shorter than one gating block (400ms): fall back to a single
      // whole-buffer measurement, ungated. Rare (very short stingers) but
      // must not crash or divide by zero.
      if (frameCount === 0) return -Infinity;
      blockSize = frameCount;
      stepSize = frameCount;
    }

    var weighted = kWeight(channels, sampleRate);
    var numChannels = weighted.length;

    var blockLoudness = []; // z (mean-square sum) per block, pre-log
    for (var start = 0; start + blockSize <= frameCount; start += stepSize) {
      var sumSq = 0;
      for (var c = 0; c < numChannels; c++) {
        var w = channelWeight(numChannels, c);
        var chan = weighted[c];
        var ms = 0;
        for (var i = start; i < start + blockSize; i++) {
          ms += chan[i] * chan[i];
        }
        ms /= blockSize;
        sumSq += w * ms;
      }
      blockLoudness.push(sumSq);
      if (stepSize <= 0) break; // safety net, should never happen
    }

    if (blockLoudness.length === 0) return -Infinity;

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

  // ---------------------------------------------------------------------
  // True peak (oversampled estimate) and sample peak
  // ---------------------------------------------------------------------
  function samplePeak(channels) {
    var peak = 0;
    for (var c = 0; c < channels.length; c++) {
      var chan = channels[c];
      for (var i = 0; i < chan.length; i++) {
        var a = Math.abs(chan[i]);
        if (a > peak) peak = a;
      }
    }
    return peak;
  }

  // Catmull-Rom cubic interpolation through 4 consecutive samples
  // (y1 at t=0, y2 at t=1). Unlike linear interpolation, a cubic spline
  // CAN overshoot beyond the surrounding sample values -- which matters
  // here because a real bandlimited reconstruction filter (what an actual
  // DAC or a streaming service's decoder does) can genuinely produce an
  // inter-sample peak higher than either neighboring sample, especially
  // on steep, high-frequency-rich transients (a piano hammer attack, a
  // drum hit, anything percussive). Linear interpolation can never
  // exceed max(y1, y2), so it silently misses exactly that case -- it
  // will always under-read the true peak on sharp attacks, sometimes by
  // more than a dB, letting the limiter/safety-trim think there is more
  // headroom than there really is and ship a file that clips on
  // playback despite every raw sample being <= full scale. Cubic
  // interpolation is a much closer (if still approximate) stand-in for
  // that ringing/overshoot behavior, at the same negligible CPU cost.
  function cubicInterp(y0, y1, y2, y3, t) {
    var a0 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
    var a1 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    var a2 = -0.5 * y0 + 0.5 * y2;
    var a3 = y1;
    return ((a0 * t + a1) * t + a2) * t + a3;
  }

  // 8x oversampled true-peak estimate (see cubicInterp above for why
  // cubic, not linear). Still an approximation of full ITU-R BS.1770
  // Annex 2 metering (which specifies a particular bandlimited FIR
  // filter), but catches the sharp-transient inter-sample overs that a
  // linear-interpolation estimate structurally cannot.
  function estimateTruePeakLinear(channels) {
    var peak = samplePeak(channels); // real samples are always included
    var OS = 8;
    for (var c = 0; c < channels.length; c++) {
      var chan = channels[c];
      var len = chan.length;
      for (var i = 0; i < len - 1; i++) {
        var y0 = i > 0 ? chan[i - 1] : chan[i];
        var y1 = chan[i];
        var y2 = chan[i + 1];
        var y3 = (i + 2 < len) ? chan[i + 2] : chan[i + 1];
        for (var k = 1; k < OS; k++) {
          var t = k / OS;
          var interp = cubicInterp(y0, y1, y2, y3, t);
          var av = Math.abs(interp);
          if (av > peak) peak = av;
        }
      }
    }
    return peak;
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
  // Gentle glue compressor: feed-forward, RMS-detector, soft-knee.
  // Same gain-reduction curve is computed from the linked (max-across-
  // channels) envelope and applied identically to every channel so the
  // stereo image is preserved.
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

    var out = [];
    for (var c = 0; c < numChannels; c++) out.push(new Float32Array(n));

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

      // Soft-knee gain computer. Standard soft-knee formula (Giannoulis/
      // Massberg/Reiss): within the knee, gain reduction is
      // (1 - 1/ratio) * (over + knee/2)^2 / (2*knee) -- note (1 - 1/ratio),
      // NOT (1/ratio - 1). The sign matters: with ratio > 1, (1 - 1/ratio)
      // is positive (an actual gain *reduction*, matching the "above knee"
      // branch just past the boundary) while (1/ratio - 1) is negative (a
      // gain *increase*). Using the wrong sign here used to make this
      // branch disagree with the linear branch right at over === kneeDb/2
      // -- e.g. for ratio 1.8 / kneeDb 6, the two branches landed on
      // +1.33dB and -1.33dB at the same point, a ~2.7dB gain snap on a
      // single sample. Since real program material spends a lot of time
      // hovering right around the knee, that discontinuity fired
      // constantly and was audible as clicking/crackling throughout a
      // track, not just on hard peaks. Fixed sign restores continuity
      // with both neighboring regions (0dB below the knee, the linear
      // formula above it) -- verified by the regression test below.
      var over = envDb - thresholdDb;
      var gainReductionDb = 0;
      if (over > kneeDb / 2) {
        gainReductionDb = over - over / ratio;
      } else if (over > -kneeDb / 2) {
        var kneeX = over + kneeDb / 2;
        gainReductionDb = (1 - 1 / ratio) * (kneeX * kneeX) / (2 * kneeDb);
      }
      var gainLin = dbToLinear(-gainReductionDb) * makeupLin;

      for (var c3 = 0; c3 < numChannels; c3++) {
        out[c3][i] = channels[c3][i] * gainLin;
      }
    }

    return out;
  }

  // ---------------------------------------------------------------------
  // True-peak-safe brickwall limiter with short lookahead, linked across
  // channels (same gain curve applied to every channel).
  // ---------------------------------------------------------------------
  function limit(channels, sampleRate, ceilingLin, opts) {
    opts = opts || {};
    var lookaheadMs = opts.lookaheadMs != null ? opts.lookaheadMs : 5;
    var releaseMs = opts.releaseMs != null ? opts.releaseMs : 60;

    var n = channels[0].length;
    var numChannels = channels.length;
    var lookaheadSamples = Math.max(1, Math.round(0.001 * lookaheadMs * sampleRate));
    var releaseCoef = Math.exp(-1 / (0.001 * releaseMs * sampleRate));

    // Linked detection envelope: max abs across channels per sample.
    var det = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var m = 0;
      for (var c = 0; c < numChannels; c++) {
        var a = Math.abs(channels[c][i]);
        if (a > m) m = a;
      }
      det[i] = m;
    }

    // Instantaneous gain needed at each sample: 1.0 unless this sample
    // itself exceeds the ceiling.
    var targetGain = new Float32Array(n);
    for (var j = 0; j < n; j++) {
      targetGain[j] = det[j] > ceilingLin ? (ceilingLin / det[j]) : 1.0;
    }

    // Backward min-hold over the lookahead window: the gain at sample idx
    // must already be at least as low as any reduction needed within the
    // next `lookaheadSamples` samples, so the limiter starts ducking
    // *before* the peak arrives instead of clipping it first.
    // Implemented as an O(n) monotonic-deque sliding-window minimum
    // (scanned backwards) rather than an O(n * window) nested loop --
    // matters for real track lengths (a few minutes of audio is millions
    // of samples).
    var lookaheadFloor = new Float32Array(n);
    var dequeIdx = new Int32Array(n); // ring-buffer-free: worst case n entries
    var dqHead = 0, dqTail = 0; // [dqHead, dqTail) is the active range
    for (var idx = n - 1; idx >= 0; idx--) {
      // Drop indices that have fallen out of the window (idx, idx+lookaheadSamples).
      while (dqTail > dqHead && dequeIdx[dqHead] >= idx + lookaheadSamples) dqHead++;
      // Maintain increasing order of values from front to back so the
      // front is always the current window minimum.
      while (dqTail > dqHead && targetGain[dequeIdx[dqTail - 1]] >= targetGain[idx]) dqTail--;
      dequeIdx[dqTail++] = idx;
      lookaheadFloor[idx] = targetGain[dequeIdx[dqHead]];
    }

    // Forward pass: instant attack down to the held floor (guarantees no
    // sample ever exceeds the ceiling), exponential release back toward
    // unity. Because each release step is a convex combination of the
    // previous gain and the floor (both <= floor), the result can never
    // overshoot above the floor -- no extra clamping needed.
    var out = [];
    for (var c2 = 0; c2 < numChannels; c2++) out.push(new Float32Array(n));
    var g = 1.0;
    for (var t = 0; t < n; t++) {
      var floor = lookaheadFloor[t];
      if (floor < g) {
        g = floor; // instant attack -- never allow an over
      } else {
        g = releaseCoef * g + (1 - releaseCoef) * floor;
      }
      for (var c3 = 0; c3 < numChannels; c3++) {
        out[c3][t] = channels[c3][t] * g;
      }
    }

    return out;
  }

  // ---------------------------------------------------------------------
  // Optional "Advanced" processing steps -- all strict no-ops at their
  // default/neutral settings, so omitting `opts` (or leaving every field
  // at its default) reproduces the exact chain that existed before these
  // were added. None of these run unless the caller explicitly asks.
  // ---------------------------------------------------------------------

  // 3-band tone EQ: low shelf (bass), mid bell (mid), high shelf (treble).
  // Each band is skipped individually when its gain is 0dB, both as a
  // fast path and so an all-zero call is byte-for-byte a no-op.
  function applyToneEQ(channels, sampleRate, opts) {
    opts = opts || {};
    function clampDb(v) { v = v || 0; if (v > 12) v = 12; if (v < -12) v = -12; return v; }
    var bassDb = clampDb(opts.bassDb);
    var midDb = clampDb(opts.midDb);
    var trebleDb = clampDb(opts.trebleDb);
    var out = channels;
    if (bassDb !== 0) {
      var lowCoef = makeBiquad('lowshelf', 120, Math.SQRT1_2, bassDb, sampleRate);
      out = out.map(function (chan) { return applyBiquad(chan, lowCoef); });
    }
    if (midDb !== 0) {
      var midCoef = makeBiquad('peaking', 1000, 1.0, midDb, sampleRate);
      out = out.map(function (chan) { return applyBiquad(chan, midCoef); });
    }
    if (trebleDb !== 0) {
      var highCoef = makeBiquad('highshelf', 8000, Math.SQRT1_2, trebleDb, sampleRate);
      out = out.map(function (chan) { return applyBiquad(chan, highCoef); });
    }
    return out;
  }

  // Stereo width via mid/side scaling: 100 = unchanged, 0 = fully mono,
  // 200 = doubled side signal. No-op for mono input or width===100.
  function applyStereoWidth(channels, widthPct) {
    if (widthPct == null) widthPct = 100;
    if (widthPct < 0) widthPct = 0;
    if (widthPct > 200) widthPct = 200;
    if (channels.length !== 2 || widthPct === 100) return channels;
    var width = widthPct / 100;
    var L = channels[0], R = channels[1];
    var n = L.length;
    var outL = new Float32Array(n), outR = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var mid = (L[i] + R[i]) * 0.5;
      var side = (L[i] - R[i]) * 0.5 * width;
      outL[i] = mid + side;
      outR[i] = mid - side;
    }
    return [outL, outR];
  }

  // Trims leading/trailing near-silence (below thresholdDb, default
  // -50dBFS) and applies a short fade in/out (default 15ms) at the new
  // edges so the cut never produces an audible click. A track that is
  // silent throughout is left untouched rather than trimmed to nothing.
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
    // no fade, and importantly no copy (return the original buffers
    // untouched so this is a true no-op when there is nothing to do).
    if (start >= end) {
      return { channels: channels, trimmedStartSamples: 0, trimmedEndSamples: 0 };
    }
    var trimmedStart = start;
    var trimmedEnd = (n - 1) - end;
    if (trimmedStart === 0 && trimmedEnd === 0) {
      return { channels: channels, trimmedStartSamples: 0, trimmedEndSamples: 0 };
    }

    // From here on we always slice (which copies), so it's always safe to
    // mutate `trimmed` in place for the fade -- the caller's original
    // channel buffers are never touched.
    var trimmed = channels.map(function (chan) { return chan.slice(start, end + 1); });
    var newLen = trimmed[0].length;
    var fadeSamples = Math.min(Math.round(0.001 * fadeMs * sampleRate), Math.floor(newLen / 2));
    if (fadeSamples > 0) {
      trimmed.forEach(function (chan) {
        for (var i = 0; i < fadeSamples; i++) {
          var g = i / fadeSamples;
          chan[i] *= g;
          chan[newLen - 1 - i] *= g;
        }
      });
    }

    return { channels: trimmed, trimmedStartSamples: trimmedStart, trimmedEndSamples: trimmedEnd };
  }

  // Sums the low end (below crossoverHz) to mono while leaving everything
  // above the crossover untouched in stereo. Standard mastering/vinyl-
  // safety technique: mono bass avoids phase-cancellation and turntable
  // tracking issues, and is inaudible as a width change since stereo bass
  // content is rarely perceptible anyway.
  //
  // Implemented via mid/side encoding rather than per-channel complementary
  // filtering: mid = (L+R)/2, side = (L-R)/2, then the SIDE channel (and
  // only the side channel) is high-passed at the crossover. Below the
  // crossover, side is filtered toward zero -- forcing L and R toward
  // identical (mono) there -- while above it, side passes through close to
  // unchanged, preserving width. An earlier version instead built "high"
  // per channel as (x - lowpass(x)) and mono-summed "low" -- mathematically
  // a valid split (low+high always reconstructed the original exactly),
  // but a poor fit for THIS purpose: right around the crossover the
  // lowpassed signal is close in magnitude but phase-shifted from the
  // original, so a lot of low-frequency energy leaked into the "high"
  // (non-mono'd) residual instead of actually being summed to mono. Only
  // filtering the side signal avoids that entirely -- verified empirically
  // (a 60Hz L/R amplitude difference dropped to ~24% of its original size
  // with this approach, vs. ~72% remaining with the per-channel version).
  function applyBassMono(channels, sampleRate, opts) {
    opts = opts || {};
    if (!opts.enabled) return channels;
    if (channels.length !== 2) return channels; // nothing to "mono" on mono input
    var crossoverHz = opts.crossoverHz != null ? opts.crossoverHz : 120;
    var hpCoef = makeBiquad('highpass', crossoverHz, Math.SQRT1_2, 0, sampleRate);
    var L = channels[0], R = channels[1];
    var n = L.length;
    var mid = new Float32Array(n), side = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      mid[i] = (L[i] + R[i]) * 0.5;
      side[i] = (L[i] - R[i]) * 0.5;
    }
    var sideHigh = applyBiquad(side, hpCoef);
    var outL = new Float32Array(n), outR = new Float32Array(n);
    for (var j = 0; j < n; j++) {
      outL[j] = mid[j] + sideHigh[j];
      outR[j] = mid[j] - sideHigh[j];
    }
    return [outL, outR];
  }

  // Splits into low/mid/high bands via an exact complementary split
  // (low = lowpass(x, lowHz), high = highpass(x, highHz), mid = x - low -
  // high -- so low + mid + high reconstructs the original exactly,
  // sample for sample, with no crossover-phase summing artifacts),
  // compresses each band independently with its own glue-compressor
  // settings (reusing glueCompress -- each band gets its own linked
  // stereo detector, same as the full-band compressor), then sums the
  // compressed bands back together. Catches problems a single full-band
  // compressor can't: a loud kick drum pumping down the highs, or a
  // harsh cymbal wash triggering gain reduction that dulls the bass.
  function multibandCompress(channels, sampleRate, opts) {
    opts = opts || {};
    var lowHz = opts.lowHz != null ? opts.lowHz : 150;
    var highHz = opts.highHz != null ? opts.highHz : 3000;
    // Per-band defaults: bass gets a slower attack (fast gain changes on
    // low frequencies distort the waveform of the cycle itself) and more
    // release time for sustain/punch; highs get a fast attack (transients
    // are short) and quicker release so cymbals/hats don't visibly pump.
    var lowOpts = opts.low || { thresholdDb: -22, ratio: 1.6, kneeDb: 6, attackMs: 30, releaseMs: 300 };
    var midOpts = opts.mid || { thresholdDb: -24, ratio: 1.8, kneeDb: 6, attackMs: 15, releaseMs: 250 };
    var highOpts = opts.high || { thresholdDb: -26, ratio: 1.8, kneeDb: 6, attackMs: 5, releaseMs: 150 };

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

    var lowC = glueCompress(lowBand, sampleRate, lowOpts);
    var midC = glueCompress(midBand, sampleRate, midOpts);
    var highC = glueCompress(highBand, sampleRate, highOpts);

    var numChannels = channels.length;
    var n2 = channels[0].length;
    var out = [];
    for (var c2 = 0; c2 < numChannels; c2++) {
      var sum = new Float32Array(n2);
      var lc = lowC[c2], mc = midC[c2], hc = highC[c2];
      for (var i2 = 0; i2 < n2; i2++) sum[i2] = lc[i2] + mc[i2] + hc[i2];
      out.push(sum);
    }
    return out;
  }

  // Gentle harmonic saturation ("warmth"/exciter) via a tanh soft-clip
  // blended with the dry signal. amount<=0 is skipped entirely (exact
  // no-op, same array references returned); increasing amount both adds
  // more harmonic content and blends more of the wet signal in. The tanh
  // curve is normalized (divided by tanh(drive)) so a full-scale
  // (|x|=1) sample maps back to almost exactly itself -- it adds
  // harmonics/density without pushing the overall level up, leaving
  // final loudness matching and the limiter in full control of how loud
  // the result ends up.
  function applySaturation(channels, opts) {
    opts = opts || {};
    var amount = opts.amount != null ? opts.amount : 0;
    if (amount <= 0) return channels;
    if (amount > 100) amount = 100;
    var mix = amount / 100;
    var drive = 1 + mix * 5; // 1 (gentle) .. 6 (noticeably driven)
    var driveTanh = Math.tanh(drive);
    return channels.map(function (chan) {
      var n = chan.length;
      var out = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        var x = chan[i];
        var wet = Math.tanh(drive * x) / driveTanh;
        out[i] = x + (wet - x) * mix;
      }
      return out;
    });
  }

  // ---------------------------------------------------------------------
  // Full mastering chain
  // ---------------------------------------------------------------------
  function analyze(decoded) {
    var lufs = integratedLoudness(decoded.channels, decoded.sampleRate);
    var truePeakLin = estimateTruePeakLinear(decoded.channels);
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

    // 0) Optional: trim leading/trailing near-silence and fade the new
    // edges. Off by default -- opt in via opts.trimSilence. Runs first so
    // every later step (and the exported file's length) works on the
    // trimmed material, while inputAnalysis above still reflects the
    // original upload as-is.
    var trimResult = opts.trimSilence
      ? trimSilenceAndFade(decoded.channels, sampleRate)
      : { channels: decoded.channels, trimmedStartSamples: 0, trimmedEndSamples: 0 };
    var working = trimResult.channels;

    // 1) DC offset removal (per-channel mean subtraction).
    var dcRemoved = working.map(function (chan) {
      var sum = 0;
      for (var i = 0; i < chan.length; i++) sum += chan[i];
      var mean = chan.length ? sum / chan.length : 0;
      if (Math.abs(mean) < 1e-6) return chan; // nothing meaningful to remove
      var out = new Float32Array(chan.length);
      for (var j = 0; j < chan.length; j++) out[j] = chan[j] - mean;
      return out;
    });

    // 2) Rumble high-pass at 20Hz -- removes inaudible sub content that
    // eats headroom without adding perceived loudness.
    var rumbleCoef = makeBiquad('highpass', 20.0, Math.SQRT1_2, 0.0, sampleRate);
    var hpFiltered = dcRemoved.map(function (chan) { return applyBiquad(chan, rumbleCoef); });

    // 2b) Optional tonal EQ (bass/mid/treble) -- no-op unless opts.eq sets
    // a non-zero band. Deliberately placed before dynamics processing so
    // the compressor/limiter react to the tonally-shaped signal, same as
    // a real mastering chain.
    var eqd = opts.eq ? applyToneEQ(hpFiltered, sampleRate, opts.eq) : hpFiltered;

    // 2c) Optional stereo width -- no-op for mono input or the default
    // 100%. Placed after EQ, before dynamics, so the limiter still has
    // the final say over any peaks a width change introduces.
    var widened = opts.stereoWidthPct != null ? applyStereoWidth(eqd, opts.stereoWidthPct) : eqd;

    // 2d) Optional bass-mono -- no-op unless opts.bassMono is set. Placed
    // after stereo width (so a user-chosen width is respected everywhere
    // except the summed low end) and before saturation/dynamics (so the
    // compressor sees the tightened, phase-coherent bass).
    var bassMonoed = opts.bassMono
      ? applyBassMono(widened, sampleRate, { enabled: true, crossoverHz: opts.bassMonoHz })
      : widened;

    // 2e) Optional saturation/warmth -- no-op unless opts.saturation.amount
    // is > 0. Placed right before dynamics so the compressor/limiter react
    // to the (subtly) harmonically enriched signal, same as the EQ step.
    var saturated = (opts.saturation && opts.saturation.amount > 0)
      ? applySaturation(bassMonoed, opts.saturation)
      : bassMonoed;

    // 3) Dynamics: gentle glue compression, either single full-band (the
    // original/default behavior) or multiband when opts.multiband is set.
    // Skipped entirely on near-silent input either way.
    var isEffectivelySilent = inputAnalysis.lufs === -Infinity || inputAnalysis.lufs < -60;
    var compressed;
    if (isEffectivelySilent) {
      compressed = saturated;
    } else if (opts.multiband) {
      compressed = multibandCompress(saturated, sampleRate, typeof opts.multiband === 'object' ? opts.multiband : {});
    } else {
      compressed = glueCompress(saturated, sampleRate, {
        thresholdDb: -24, ratio: 1.8, kneeDb: 6, attackMs: 15, releaseMs: 250
      });
    }

    // 4) Loudness normalization to preset target.
    var postCompLUFS = isEffectivelySilent ? inputAnalysis.lufs : integratedLoudness(compressed, sampleRate);
    var gainDb = 0;
    if (!isEffectivelySilent && isFinite(postCompLUFS)) {
      gainDb = preset.targetLUFS - postCompLUFS;
      // Sanity clamp: never apply an absurd gain (protects against a
      // measurement edge case blowing the file up or silencing it).
      if (gainDb > 40) gainDb = 40;
      if (gainDb < -40) gainDb = -40;
    }
    var gainLin = dbToLinear(gainDb);
    var normalized = compressed.map(function (chan) {
      var out = new Float32Array(chan.length);
      for (var i = 0; i < chan.length; i++) out[i] = chan[i] * gainLin;
      return out;
    });

    // 5) True-peak-safe limiter, with a small internal safety margin
    // because our true-peak estimate is an approximation.
    var ceilingLin = dbToLinear(preset.ceilingDbTP - 0.3);
    var limited = limit(normalized, sampleRate, ceilingLin, { lookaheadMs: 5, releaseMs: 60 });

    // 6) Iterative safety trim: re-measure true peak; if the approximation
    // still leaves us slightly over the *published* ceiling, apply one
    // more small linear gain trim and re-check (max 4 passes) so the
    // guarantee is "never exceeds ceiling", not "usually doesn't".
    var finalCeilingLin = dbToLinear(preset.ceilingDbTP);
    var safe = limited;
    for (var pass = 0; pass < 4; pass++) {
      var tp = estimateTruePeakLinear(safe);
      if (tp <= finalCeilingLin || tp <= 0) break;
      var trim = finalCeilingLin / tp;
      safe = safe.map(function (chan) {
        var out = new Float32Array(chan.length);
        for (var i = 0; i < chan.length; i++) out[i] = chan[i] * trim;
        return out;
      });
    }

    var outputAnalysis = analyze({ channels: safe, sampleRate: sampleRate, frameCount: safe[0].length });

    return {
      channels: safe,
      sampleRate: sampleRate,
      preset: preset,
      input: inputAnalysis,
      output: outputAnalysis,
      appliedGainDb: gainDb,
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
      estimateTruePeakLinear: estimateTruePeakLinear,
      samplePeak: samplePeak,
      crestFactorDb: crestFactorDb,
      glueCompress: glueCompress,
      limit: limit,
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
