/* ============================================================================
 * Cough Afrika - screening engine
 *
 *  1. TreeEnsemble      : evaluates the exported ONNX TreeEnsembleClassifier models
 *  2. Audio DSP         : librosa-compatible features (13 MFCC means, spectral
 *                         centroid, zero-crossing rate, RMS) - same definitions as
 *                         librosa.feature.* with default n_fft=2048 / hop=512
 *  3. Quality gates     : refuse to score recordings the model was never meant to see
 *  4. Triage logic      : acoustic model + guideline symptom screen -> overall tier
 *
 * Pure JS, no dependencies. Runs in the browser (window.TBEngine) and in Node
 * (require('./tb-engine.js')) so the whole pipeline can be unit-tested.
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TBEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ config */
  const CONFIG = {
    // Feature-extraction parameters (librosa defaults; must match training).
    N_FFT: 2048, HOP: 512, N_MELS: 128, N_MFCC: 13, TOP_DB: 80,
    // Recording limits.
    MIN_SECONDS: 3, MAX_SECONDS: 20,
    // Acoustic score -> tier bands. The forest's score is NOT a calibrated
    // probability of TB, so these are triage bands, not clinical thresholds.
    TIER_LOW_MAX: 0.30, TIER_MED_MAX: 0.65,
    // Quality gates.
    MIN_PEAK: 0.03,            // quieter than this = mic too far / muted
    MAX_CLIP_FRACTION: 0.005,  // >0.5% of samples at full scale = clipped
    MAX_NOISE_FLOOR_DB: -38,   // dBFS of the background between coughs
    MIN_DYNAMIC_DB: 10,        // loud part must stand >=10 dB above background
    // Out-of-distribution guard on the standardised features.
    OOD_Z: 6, OOD_COUNT: 3, OOD_Z_ANY: 10,
    // The acoustic model was fitted on adults (mean age in the clinical data is 36);
    // below this age the acoustic score is not used.
    ADULT_MIN_AGE: 15,
    // Features the questionnaire can honestly supply to a tabular model.
    // (Used to decide whether the tabular model may run at all - see tabularStatus.)
    AVAILABLE_TABULAR_FEATURES: ['age', 'hiv_infected_a', 'smkr_a', 'fever', 'un_wght_loss',
                                 'nght_swts', 'cough', 'cough_bld']
  };

  /* ------------------------------------------------------------ tree ensemble */
  function b64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const ab = new ArrayBuffer(bin.length);
    const u8 = new Uint8Array(ab);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return ab;
  }

  class TreeEnsemble {
    constructor(spec) {
      const buf = b64ToArrayBuffer(spec.b64), L = spec.layout;
      const view = (k, C) => new C(buf, L[k].offset, L[k].length);
      this.feat = view('feat', Int16Array);
      this.thr = view('thr', Float32Array);
      this.left = view('left', Int32Array);
      this.right = view('right', Int32Array);
      this.lw = view('lw', Float32Array);
      this.roots = view('roots', Int32Array);
      this.K = spec.nClassWeights;
      this.post = spec.postTransform;
      this.base = spec.baseValues || [];
      this.usedFeatures = spec.usedFeatures;
    }
    /** x: Float32Array of standardised features. Returns [P(class0), P(class1)]. */
    predictProba(x) {
      const K = this.K, s = new Float64Array(K);
      const { feat, thr, left, right, lw, roots } = this;
      for (let t = 0; t < roots.length; t++) {
        let n = roots[t];
        while (feat[n] >= 0) n = x[feat[n]] <= thr[n] ? left[n] : right[n];
        for (let k = 0; k < K; k++) s[k] += lw[n * K + k];
      }
      for (let k = 0; k < this.base.length; k++) s[k] += this.base[k];
      // ONNX "binary case": a single score column describes the positive class.
      if (K === 1) {
        const p1 = this.post === 'LOGISTIC' ? 1 / (1 + Math.exp(-s[0])) : s[0];
        return [1 - p1, p1];
      }
      return [s[0], s[1]];
    }
  }

  function loadModels(data) {
    const mk = (m) => ({
      names: m.scaler.featureNames, mean: m.scaler.mean, scale: m.scaler.scale,
      ensemble: new TreeEnsemble(m.ensemble), source: m.source
    });
    const out = { audio: mk(data.audio), tabular: mk(data.tabular) };
    out.audio.sampleRate = data.audio.featureSampleRate;
    out.builtAt = data.builtAt;
    return out;
  }

  function standardise(raw, m) {
    const x = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) x[i] = (raw[i] - m.mean[i]) / m.scale[i];
    return x;
  }

  /* ----------------------------------------------------------------------- DSP */
  function hann(N) {                       // periodic Hann (scipy get_window fftbins=True)
    const w = new Float64Array(N);
    for (let n = 0; n < N; n++) w[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / N);
    return w;
  }

  function makeFFT(N) {                    // iterative radix-2, in place
    const levels = Math.log2(N);
    if (levels !== Math.floor(levels)) throw new Error('FFT size must be a power of 2');
    const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
    for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = Math.sin(2 * Math.PI * i / N); }
    const rev = new Uint32Array(N);
    for (let i = 0; i < N; i++) {
      let r = 0, v = i;
      for (let b = 0; b < levels; b++) { r = (r << 1) | (v & 1); v >>= 1; }
      rev[i] = r;
    }
    return function fft(re, im) {
      for (let i = 0; i < N; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1, step = N / size;
        for (let i = 0; i < N; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tre = re[l] * cos[k] + im[l] * sin[k];
            const tim = -re[l] * sin[k] + im[l] * cos[k];
            re[l] = re[j] - tre; im[l] = im[j] - tim;
            re[j] += tre; im[j] += tim;
          }
        }
      }
    };
  }

  /* librosa.filters.mel(htk=False, norm='slaney') */
  function hzToMel(f) {
    const fsp = 200 / 3, minLogHz = 1000, minLogMel = minLogHz / fsp, logstep = Math.log(6.4) / 27;
    return f >= minLogHz ? minLogMel + Math.log(f / minLogHz) / logstep : f / fsp;
  }
  function melToHz(m) {
    const fsp = 200 / 3, minLogHz = 1000, minLogMel = minLogHz / fsp, logstep = Math.log(6.4) / 27;
    return m >= minLogMel ? minLogHz * Math.exp(logstep * (m - minLogMel)) : m * fsp;
  }
  function melFilterbank(sr, nFft, nMels) {
    const nBins = nFft / 2 + 1, fmax = sr / 2;
    const melPts = new Float64Array(nMels + 2);
    const m0 = hzToMel(0), m1 = hzToMel(fmax);
    for (let i = 0; i < nMels + 2; i++) melPts[i] = melToHz(m0 + (m1 - m0) * i / (nMels + 1));
    const bank = [];
    for (let i = 0; i < nMels; i++) {
      const lo = melPts[i], mid = melPts[i + 1], hi = melPts[i + 2];
      const enorm = 2 / (hi - lo);
      let start = -1; const w = [];
      for (let k = 0; k < nBins; k++) {
        const f = k * sr / nFft;
        const v = Math.max(0, Math.min((f - lo) / (mid - lo), (hi - f) / (hi - mid))) * enorm;
        if (v > 0) { if (start < 0) start = k; w.push(v); } else if (start >= 0) break;
      }
      bank.push({ start: Math.max(start, 0), w: Float64Array.from(w) });
    }
    return bank;
  }

  /** Band-limited (windowed-sinc) resampler. Deterministic and identical in every browser. */
  function resample(x, srIn, srOut) {
    if (srIn === srOut) return x instanceof Float32Array ? x : Float32Array.from(x);
    const ratio = srIn / srOut;
    const r = Math.min(1, srOut / srIn) * 0.97;           // cutoff as fraction of input Nyquist
    const W = Math.ceil(16 / r);                          // half-width in input samples
    const nOut = Math.floor(x.length / ratio);
    const out = new Float32Array(nOut);
    for (let n = 0; n < nOut; n++) {
      const pos = n * ratio, i0 = Math.ceil(pos - W), i1 = Math.floor(pos + W);
      let acc = 0, wsum = 0;
      for (let i = Math.max(i0, 0); i <= Math.min(i1, x.length - 1); i++) {
        const t = i - pos, a = Math.PI * r * t;
        const sinc = Math.abs(t) < 1e-12 ? 1 : Math.sin(a) / a;
        const h = r * sinc * (0.5 + 0.5 * Math.cos(Math.PI * t / W));
        acc += x[i] * h; wsum += h;
      }
      out[n] = wsum !== 0 ? acc / wsum : 0;
    }
    return out;
  }

  const _cache = {};
  function dspTables(sr) {
    const key = sr + '|' + CONFIG.N_FFT;
    if (!_cache[key]) {
      _cache[key] = {
        win: hann(CONFIG.N_FFT), fft: makeFFT(CONFIG.N_FFT),
        bank: melFilterbank(sr, CONFIG.N_FFT, CONFIG.N_MELS)
      };
      // DCT-II (orthonormal) matrix, first N_MFCC rows
      const M = CONFIG.N_MELS, D = [];
      for (let k = 0; k < CONFIG.N_MFCC; k++) {
        const row = new Float64Array(M), sc = k === 0 ? Math.sqrt(1 / M) : Math.sqrt(2 / M);
        for (let m = 0; m < M; m++) row[m] = sc * Math.cos(Math.PI * k * (2 * m + 1) / (2 * M));
        D.push(row);
      }
      _cache[key].dct = D;
    }
    return _cache[key];
  }

  /**
   * y: Float32Array mono PCM already at `sr` (the model's feature rate), raw amplitude
   * (no normalisation - RMS energy is one of the model's inputs).
   * Returns the 16 raw features in the model's order.
   */
  function extractFeatures(y, sr) {
    const { N_FFT: N, HOP, N_MELS, N_MFCC, TOP_DB } = CONFIG;
    const T = dspTables(sr), nBins = N / 2 + 1, pad = N / 2;
    const nFrames = 1 + Math.floor(y.length / HOP);
    const re = new Float64Array(N), im = new Float64Array(N);
    const melDb = new Float64Array(nFrames * N_MELS);
    let centroidSum = 0, rmsSum = 0, zcrSum = 0;
    const last = y.length - 1;
    const sampleZero = (i) => (i >= 0 && i < y.length ? y[i] : 0);      // constant (zero) padding
    const sampleEdge = (i) => y[Math.min(Math.max(i, 0), last)];        // edge padding (ZCR)
    const tiny = 1.1754943508222875e-38, freqStep = sr / N;
    const mag = new Float64Array(nBins);
    let dbMax = -Infinity;

    for (let t = 0; t < nFrames; t++) {
      const off = t * HOP - pad;
      let sq = 0;
      for (let n = 0; n < N; n++) {
        const v = sampleZero(off + n);
        sq += v * v;
        re[n] = v * T.win[n]; im[n] = 0;
      }
      rmsSum += Math.sqrt(sq / N);

      let crossings = 0, prevNeg = null;
      for (let n = 0; n < N; n++) {
        let v = sampleEdge(off + n);
        if (Math.abs(v) <= 1e-10) v = 0;
        const neg = v < 0 || Object.is(v, -0);
        if (prevNeg !== null && neg !== prevNeg) crossings++;
        prevNeg = neg;
      }
      zcrSum += crossings / (N - 1);

      T.fft(re, im);
      let sMag = 0, sWeighted = 0;
      for (let k = 0; k < nBins; k++) {
        const m = Math.hypot(re[k], im[k]);
        mag[k] = m; sMag += m; sWeighted += m * k * freqStep;
      }
      centroidSum += sMag < tiny ? 0 : sWeighted / sMag;

      for (let m = 0; m < N_MELS; m++) {
        const { start, w } = T.bank[m];
        let acc = 0;
        for (let j = 0; j < w.length; j++) { const p = mag[start + j]; acc += w[j] * p * p; }
        const db = 10 * Math.log10(Math.max(1e-10, acc));
        melDb[t * N_MELS + m] = db;
        if (db > dbMax) dbMax = db;
      }
    }
    // power_to_db(top_db=80): floor relative to the loudest cell of the whole clip
    const floor = dbMax - TOP_DB;
    const mfcc = new Float64Array(N_MFCC);
    for (let t = 0; t < nFrames; t++) {
      for (let k = 0; k < N_MFCC; k++) {
        const row = T.dct[k]; let acc = 0;
        for (let m = 0; m < N_MELS; m++) acc += row[m] * Math.max(melDb[t * N_MELS + m], floor);
        mfcc[k] += acc;
      }
    }
    const feats = new Float64Array(16);
    for (let k = 0; k < N_MFCC; k++) feats[k] = mfcc[k] / nFrames;
    feats[13] = centroidSum / nFrames;
    feats[14] = zcrSum / nFrames;
    feats[15] = rmsSum / nFrames;
    return feats;
  }

  /* ------------------------------------------------------------ quality gates */
  function percentile(sortedAsc, p) {
    const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.round(p * (sortedAsc.length - 1))));
    return sortedAsc[i];
  }

  /** y at `sr`. Returns measurements + a list of blocking issues and soft warnings. */
  function assessRecording(y, sr) {
    const dur = y.length / sr;
    let peak = 0, clipped = 0;
    for (let i = 0; i < y.length; i++) {
      const a = Math.abs(y[i]);
      if (a > peak) peak = a;
      if (a >= 0.99) clipped++;
    }
    const clipFrac = y.length ? clipped / y.length : 0;

    const win = Math.round(0.025 * sr), hop = Math.round(0.010 * sr);
    const db = [];
    for (let s = 0; s + win <= y.length; s += hop) {
      let sq = 0;
      for (let i = s; i < s + win; i++) sq += y[i] * y[i];
      db.push(20 * Math.log10(Math.sqrt(sq / win) + 1e-9));
    }
    const sorted = db.slice().sort((a, b) => a - b);
    const noiseFloor = sorted.length ? percentile(sorted, 0.10) : -120;
    const loud = sorted.length ? percentile(sorted, 0.97) : -120;
    const dynamic = loud - noiseFloor;

    // Cough events = loud bursts well above the background, merged if <150 ms apart
    const thr = Math.max(noiseFloor + 12, -50);
    const events = []; let cur = null;
    for (let i = 0; i < db.length; i++) {
      if (db[i] > thr) {
        if (cur && i - cur.end <= 15) cur.end = i; else { if (cur) events.push(cur); cur = { start: i, end: i }; }
      }
    }
    if (cur) events.push(cur);
    const coughs = events.filter(e => e.end - e.start + 1 >= 3 && e.end - e.start + 1 <= 80).length;

    const issues = [], warnings = [];
    if (dur < CONFIG.MIN_SECONDS) issues.push('The recording is too short — record for at least ' + CONFIG.MIN_SECONDS + ' seconds.');
    if (dur > CONFIG.MAX_SECONDS + 0.5) issues.push('The recording is too long.');
    if (peak < CONFIG.MIN_PEAK) issues.push('The recording is too quiet — hold the phone closer and cough again.');
    else if (clipFrac > CONFIG.MAX_CLIP_FRACTION) issues.push('The recording is distorted (too loud) — hold the phone a little further away.');
    else if (noiseFloor > CONFIG.MAX_NOISE_FLOOR_DB) issues.push('There is too much background noise — move somewhere quieter.');
    else if (coughs === 0 || dynamic < CONFIG.MIN_DYNAMIC_DB) issues.push('No clear cough was detected — cough firmly 2–3 times, a second apart.');
    if (!issues.length && coughs === 1) warnings.push('Only one cough was detected; 2–3 coughs give a more reliable read.');
    if (!issues.length && coughs > 12) warnings.push('Many sound events were detected; background noise or talking may affect the result.');

    return { duration: dur, peak, clipFraction: clipFrac, noiseFloorDb: noiseFloor, dynamicDb: dynamic,
             coughCount: coughs, issues, warnings, ok: issues.length === 0 };
  }

  /* ------------------------------------------------------------ audio scoring */
  function tierFromScore(p) {
    return p < CONFIG.TIER_LOW_MAX ? 'low' : (p <= CONFIG.TIER_MED_MAX ? 'med' : 'high');
  }

  function scoreAudio(models, yModelRate) {
    const feats = extractFeatures(yModelRate, models.audio.sampleRate);
    const x = standardise(feats, models.audio);
    let oodCount = 0, maxAbsZ = 0;
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]);
      if (a > CONFIG.OOD_Z) oodCount++;
      if (a > maxAbsZ) maxAbsZ = a;
    }
    const reliable = !(oodCount >= CONFIG.OOD_COUNT || maxAbsZ > CONFIG.OOD_Z_ANY);
    const proba = models.audio.ensemble.predictProba(x);
    return { features: Array.from(feats), z: Array.from(x), oodCount, maxAbsZ, reliable,
             score: proba[1], tier: tierFromScore(proba[1]) };
  }

  /** Full audio path: raw mic PCM at any rate -> quality gate -> model score. */
  function analyseAudio(models, pcm, pcmRate) {
    const sr = models.audio.sampleRate;
    const y = resample(pcm, pcmRate, sr);
    const quality = assessRecording(y, sr);
    if (!quality.ok) return { quality, scored: false };
    const s = scoreAudio(models, y);
    return { quality, scored: true, ...s };
  }

  /* --------------------------------------------------------- tabular model gate */
  /**
   * The bundled tabular (clinical) model is only allowed to run if every feature it
   * actually splits on can be supplied by the questionnaire. Imputing missing inputs
   * (especially lab results or the `class` label column) would silently produce a
   * fixed, meaningless number - so we refuse instead and say why.
   */
  function tabularStatus(models, available) {
    available = available || CONFIG.AVAILABLE_TABULAR_FEATURES;
    const used = models.tabular.ensemble.usedFeatures;
    const missing = used.filter(f => available.indexOf(f) < 0);
    return { usable: missing.length === 0, used, missing,
             reason: missing.length ? 'Model depends on inputs unavailable at screening time: ' + missing.join(', ') : '' };
  }

  /* ------------------------------------------------------------- symptom screen */
  const DURATION_WEEKS = [0.1, 0.4, 1, 2, 3, 4.3, 6, 8.7, 13];   // slider index -> weeks

  /**
   * Rule-based screen modelled on the WHO four-symptom screen (cough, fever, night
   * sweats, weight loss) plus blood in cough. Deliberately transparent: no learned
   * weights, no age/sex terms.
   */
  function symptomScreen(a) {
    const weeks = DURATION_WEEKS[Math.max(0, Math.min(8, a.durationIdx | 0))];
    const flags = [];
    const prolonged = weeks >= 2;
    if (prolonged) flags.push('cough for 2 weeks or more');
    if (a.fever) flags.push('fever');
    if (a.nightSweats) flags.push('night sweats');
    if (a.weightLoss) flags.push('unexplained weight loss');
    if (a.bloodInCough) flags.push('blood in cough');
    const hiv = !!a.hiv;
    // People living with HIV are screened positive on a cough of any duration.
    const screenPositive = flags.length > 0 || hiv;
    const core = (prolonged ? 1 : 0) + (a.fever ? 1 : 0) + (a.nightSweats ? 1 : 0) + (a.weightLoss ? 1 : 0);
    let tier = 'low';
    if (screenPositive) tier = 'med';
    if (a.bloodInCough || core >= 3) tier = 'high';
    return { tier, flags, count: flags.length, hiv, positive: screenPositive, weeks };
  }

  const RANK = { low: 0, med: 1, high: 2 };
  /**
   * Overall triage. Conservative by design:
   *  - the higher of the two signals wins (a "low" acoustic score never overrides symptoms)
   *  - the acoustic score alone can raise someone to Medium but not High, because the
   *    model has not been validated on browser-microphone audio.
   */
  function combine(symptom, audio) {
    let a = audio && audio.usable ? audio.tier : null, capped = false;
    if (a === 'high' && symptom.tier === 'low') { a = 'med'; capped = true; }
    const tier = a && RANK[a] > RANK[symptom.tier] ? a : symptom.tier;
    return { tier, capped };
  }

  function diagnostics(models) {
    return {
      builtAt: models.builtAt,
      audio: { trees: models.audio.ensemble.roots.length, featureSampleRate: models.audio.sampleRate, source: models.audio.source },
      tabular: { trees: models.tabular.ensemble.roots.length, source: models.tabular.source, gate: tabularStatus(models) }
    };
  }

  return { CONFIG, loadModels, standardise, resample, extractFeatures, assessRecording, scoreAudio,
           analyseAudio, tabularStatus, symptomScreen, combine, tierFromScore, diagnostics,
           melFilterbank, TreeEnsemble };
});
