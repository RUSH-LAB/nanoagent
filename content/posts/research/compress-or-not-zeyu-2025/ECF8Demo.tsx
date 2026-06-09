import React, {useEffect, useRef, useCallback} from 'react';

const T1 = 13, T2 = 24, SPD = 4;

export default function ECF8Demo() {
  const rafRef = useRef<number | null>(null);
  const stRef = useRef(0);
  const d1Ref = useRef(false);
  const d2Ref = useRef(false);

  const $ = useCallback((id: string) => document.getElementById('ecf8-' + id), []);

  const reset = useCallback(() => {
    ['ecf8', 'fp8'].forEach((k) => {
      $('panel-' + k)?.classList.remove('done-ecf8', 'done-fp8');
      $('badge-' + k)?.classList.remove('show');
      $('img-' + k)?.classList.remove('show');
      $('spinner-' + k)?.classList.remove('show');
      $('preview-' + k)?.classList.remove('hide');
      const bar = $('bar-' + k) as HTMLElement | null;
      if (bar) bar.style.width = '0%';
      const time = $('time-' + k);
      if (time) time.textContent = '0.0s / ' + (k === 'ecf8' ? T1 : T2) + 's';
      const pct = $('pct-' + k);
      if (pct) pct.textContent = '0%';
    });
    $('result')?.classList.remove('show');
    d1Ref.current = false;
    d2Ref.current = false;
  }, [$]);

  const upd = useCallback((id: string, tt: number, el: number) => {
    const e = Math.min(el, tt);
    const p = Math.min(el / tt * 100, 100);
    const bar = $('bar-' + id) as HTMLElement | null;
    if (bar) bar.style.width = p + '%';
    const time = $('time-' + id);
    if (time) time.textContent = e.toFixed(1) + 's / ' + tt + 's';
    const pct = $('pct-' + id);
    if (pct) pct.textContent = Math.round(p) + '%';
    if (p >= 100) {
      $('spinner-' + id)?.classList.remove('show');
      $('img-' + id)?.classList.add('show');
      $('badge-' + id)?.classList.add('show');
      $('panel-' + id)?.classList.add('done-' + id);
      return true;
    }
    return false;
  }, [$]);

  const tick = useCallback(() => {
    const el = (Date.now() - stRef.current) / 1000 * SPD;
    if (!d1Ref.current) d1Ref.current = upd('ecf8', T1, el);
    if (!d2Ref.current) d2Ref.current = upd('fp8', T2, el);
    if (d1Ref.current && d2Ref.current) {
      $('result')?.classList.add('show');
      const btn = document.getElementById('ecf8GenBtn') as HTMLButtonElement | null;
      if (btn) { btn.disabled = false; btn.textContent = 'Regenerate'; }
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [$, upd]);

  const generate = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    reset();
    ['ecf8', 'fp8'].forEach((k) => {
      $('preview-' + k)?.classList.add('hide');
      $('spinner-' + k)?.classList.add('show');
    });
    const btn = document.getElementById('ecf8GenBtn') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = 'Generating...'; }
    stRef.current = Date.now();
    rafRef.current = requestAnimationFrame(tick);
  }, [$, reset, tick]);

  useEffect(() => {
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  return (
    <div className="ecf8-demo-wrapper">
      <div className="ecf8-demo-header">
        <p className="ecf8-demo-subtitle">Single GH200 GPU (96 GB) · DiffSynth · Playback at 4× Speed</p>
        <button className="ecf8-demo-btn" id="ecf8GenBtn" onClick={generate}>Generate Image</button>
      </div>
      <div className="ecf8-panels">
        <div className="ecf8-panel" id="ecf8-panel-ecf8">
          <div className="ecf8-panel-header">
            <span className="ecf8-panel-label ecf8">ECF8 (Ours)</span>
            <span className="ecf8-badge ecf8" id="ecf8-badge-ecf8">13s</span>
          </div>
          <div className="ecf8-image-box">
            <img className="preview" id="ecf8-preview-ecf8" src="/img/ecf8/sample4.png" alt="" />
            <div className="ecf8-spinner-wrap" id="ecf8-spinner-ecf8"><div className="ecf8-spinner ecf8"></div><span className="ecf8-spinner-text">Generating...</span></div>
            <img className="result" id="ecf8-img-ecf8" src="/img/ecf8/sample4.png" alt="ECF8 generated" />
          </div>
          <div className="ecf8-progress-wrap">
            <div className="ecf8-progress-bar-bg"><div className="ecf8-progress-bar ecf8" id="ecf8-bar-ecf8"></div></div>
            <div className="ecf8-progress-info"><span id="ecf8-time-ecf8">0.0s / 13s</span><span id="ecf8-pct-ecf8">0%</span></div>
          </div>
        </div>
        <div className="ecf8-panel" id="ecf8-panel-fp8">
          <div className="ecf8-panel-header">
            <span className="ecf8-panel-label fp8">FP8 Baseline</span>
            <span className="ecf8-badge fp8" id="ecf8-badge-fp8">24s</span>
          </div>
          <div className="ecf8-image-box">
            <img className="preview" id="ecf8-preview-fp8" src="/img/ecf8/sample4.png" alt="" />
            <div className="ecf8-spinner-wrap" id="ecf8-spinner-fp8"><div className="ecf8-spinner fp8"></div><span className="ecf8-spinner-text">Generating...</span></div>
            <img className="result" id="ecf8-img-fp8" src="/img/ecf8/sample4.png" alt="FP8 generated" />
          </div>
          <div className="ecf8-progress-wrap">
            <div className="ecf8-progress-bar-bg"><div className="ecf8-progress-bar fp8" id="ecf8-bar-fp8"></div></div>
            <div className="ecf8-progress-info"><span id="ecf8-time-fp8">0.0s / 24s</span><span id="ecf8-pct-fp8">0%</span></div>
          </div>
        </div>
      </div>
      <div className="ecf8-result-banner" id="ecf8-result"><strong>Pixel-identical outputs.</strong> ECF8 finished in 13s, <strong>85% faster</strong> than FP8 (24s) with pixel-to-pixel identical outputs.</div>
    </div>
  );
}
