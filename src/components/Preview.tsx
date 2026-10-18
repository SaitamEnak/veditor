import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronFirst, ChevronLast, Pause, Play, StepBack, StepForward } from 'lucide-react';
import type { Asset, Clip, MediaClip } from '../../shared/types';
import { MAX_GAIN, animState, clipEnd, envelopeAt, fadeFactor, isMediaClip, projectDuration, setAnimated } from '../../shared/types';
import { findClip } from '../lib/ops';
import { previewCanvas, previewMedia } from '../lib/previewCanvas';
import { drawClipAt, visualBox } from '../lib/render';
import { formatTime } from '../lib/util';
import { useEditor } from '../store';

/**
 * Motor de vista previa: un <video>/<audio> oculto por clip (creado bajo demanda),
 * sincronizados con el reloj de la línea de tiempo, y composición en <canvas>.
 */
let audioCtx: AudioContext | null = null;
const getAudioCtx = () => (audioCtx ??= new AudioContext());

interface PoolEntry {
  el: HTMLMediaElement;
  /** El sonido pasa por Web Audio: permite ganancia > 100% y curvas de volumen suaves */
  gain: GainNode;
  used: number;
}

class MediaPool {
  private els = new Map<string, PoolEntry>();
  private images = new Map<string, HTMLImageElement>();

  media(clip: MediaClip, asset: Asset): PoolEntry {
    let e = this.els.get(clip.id);
    if (!e || e.el.dataset.src !== asset.url) {
      if (e) this.destroy(clip.id);
      const el = document.createElement(asset.kind === 'audio' ? 'audio' : 'video');
      el.preload = 'auto';
      el.dataset.src = asset.url;
      el.src = asset.url;
      (el as HTMLVideoElement).playsInline = true;
      el.currentTime = clip.in;
      const ac = getAudioCtx();
      const gain = ac.createGain();
      gain.gain.value = 0;
      ac.createMediaElementSource(el).connect(gain).connect(ac.destination);
      e = { el, gain, used: 0 };
      this.els.set(clip.id, e);
    }
    e.used = performance.now();
    return e;
  }

  image(asset: Asset) {
    let img = this.images.get(asset.id);
    if (!img) {
      img = new Image();
      img.src = asset.url;
      this.images.set(asset.id, img);
    }
    return img;
  }

  /** Pausa todo lo que no esté activo y libera los elementos menos usados. */
  sweep(active: Set<string>, existing: Set<string>) {
    const idle: [string, number][] = [];
    for (const [id, e] of this.els) {
      if (!existing.has(id)) {
        this.destroy(id);
        continue;
      }
      if (!active.has(id)) {
        if (!e.el.paused) e.el.pause();
        idle.push([id, e.used]);
      }
    }
    idle.sort((a, b) => a[1] - b[1]);
    while (idle.length > 6) this.destroy(idle.shift()![0]);
  }

  private destroy(id: string) {
    const e = this.els.get(id);
    if (!e) return;
    e.el.pause();
    e.gain.disconnect();
    e.el.removeAttribute('src');
    e.el.load();
    this.els.delete(id);
  }

  pauseAll() {
    for (const e of this.els.values()) e.el.pause();
  }

  releaseAll() {
    for (const id of [...this.els.keys()]) this.destroy(id);
  }
}

const PRELOAD = 1.5;

function syncMedia(el: HTMLMediaElement, target: number, playing: boolean, fps: number) {
  if (el.readyState < 1) return;
  const drift = Math.abs(el.currentTime - target);
  if (playing) {
    if (el.paused) {
      if (drift > 0.05) el.currentTime = target;
      el.play().catch(() => {});
    } else if (drift > 0.3) el.currentTime = target;
  } else {
    if (!el.paused) el.pause();
    if (drift > 0.5 / fps && !el.seeking) el.currentTime = target;
  }
}

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const width = useEditor((s) => s.project.width);
  const height = useEditor((s) => s.project.height);
  const [scale, setScale] = useState(0.3);

  useLayoutEffect(() => {
    const el = stageRef.current!;
    const ro = new ResizeObserver(() => {
      const pad = 36;
      setScale(Math.min((el.clientWidth - pad) / width, (el.clientHeight - pad) / height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, height]);

  // Bucle de render + reloj de reproducción
  useEffect(() => {
    const pool = new MediaPool();
    previewCanvas.current = canvasRef.current;
    previewMedia.release = () => pool.releaseAll();
    const ctx = canvasRef.current!.getContext('2d')!;
    let raf = 0;
    let last = performance.now();
    let lastDraw = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const st = useEditor.getState();
      const p = st.project;
      let t = st.playhead;
      if (st.playing) {
        const end = projectDuration(p);
        t = Math.min(end, t + (now - last) / 1000);
        if (t >= end) st.setPlaying(false);
        st.setPlayhead(t);
      }
      last = now;

      const assets = new Map(p.assets.map((a) => [a.id, a]));
      const active = new Set<string>();
      const existing = new Set<string>();
      const layers: Clip[] = [];
      let waiting = false;

      for (let ti = p.tracks.length - 1; ti >= 0; ti--) {
        const track = p.tracks[ti];
        for (const clip of track.clips) {
          existing.add(clip.id);
          const isActive = t >= clip.start && t < clipEnd(clip);
          const upcoming = !isActive && clip.start > t && clip.start - t < PRELOAD;
          if (!isActive && !upcoming) continue;
          const asset = isMediaClip(clip) ? assets.get(clip.assetId) : undefined;
          const local = t - clip.start;

          if (isMediaClip(clip) && asset && asset.kind !== 'image') {
            const { el, gain } = pool.media(clip, asset);
            if (isActive) {
              active.add(clip.id);
              syncMedia(el, clip.in + local, st.playing, p.fps);
              const vol = track.muted || clip.audioDetached
                ? 0
                : clip.volume * envelopeAt(clip.volumeKeys, clip.in + local) * fadeFactor(clip, local);
              gain.gain.setTargetAtTime(Math.min(MAX_GAIN * MAX_GAIN, Math.max(0, vol)), getAudioCtx().currentTime, 0.015);
              if (track.kind === 'visual' && asset.kind === 'video' && (el.readyState < 2 || el.seeking)) waiting = true;
            } else if (!st.playing && Math.abs(el.currentTime - clip.in) > 0.1 && !el.seeking && el.readyState >= 1) {
              el.currentTime = clip.in; // precarga del punto de entrada
            }
          }
          if (isActive && track.kind === 'visual' && !track.hidden) layers.push(clip);
        }
      }
      pool.sweep(active, existing);

      // Si algún video está buscando, mantenemos el último fotograma para evitar parpadeos
      if (waiting && now - lastDraw < 250) return;
      lastDraw = now;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = p.background;
      ctx.fillRect(0, 0, p.width, p.height);
      const sources = {
        image: (asset: Asset) => {
          const img = pool.image(asset);
          return img.complete && img.naturalWidth ? img : null;
        },
        video: (clip: MediaClip, asset: Asset) => {
          const el = pool.media(clip, asset).el as HTMLVideoElement;
          return el.readyState >= 2 ? el : null;
        },
      };
      for (const clip of layers) drawClipAt(ctx, clip, t, p, sources);
    };
    raf = requestAnimationFrame(frame);
    const unsub = useEditor.subscribe((s, prev) => {
      if (prev.playing && !s.playing) pool.pauseAll();
      if (!prev.playing && s.playing) getAudioCtx().resume();
    });
    return () => {
      cancelAnimationFrame(raf);
      unsub();
      pool.pauseAll();
    };
  }, []);

  return (
    <main className="preview">
      <div className="stage" ref={stageRef} onPointerDown={(e) => e.target === e.currentTarget && useEditor.getState().select(null)}>
        <div className="stage-inner" style={{ width: width * scale, height: height * scale }}>
          <canvas ref={canvasRef} width={width} height={height} />
          <SelectionOverlay scale={scale} canvasRef={canvasRef} />
        </div>
      </div>
      <Transport />
    </main>
  );
}

/** Caja de selección sobre el lienzo: mover, escalar (esquinas) y rotar (asa superior). */
function SelectionOverlay({ scale, canvasRef }: { scale: number; canvasRef: React.RefObject<HTMLCanvasElement | null> }) {
  const project = useEditor((s) => s.project);
  const selectedId = useEditor((s) => s.selectedId);
  const playhead = useEditor((s) => s.playhead);
  const isActive = useEditor((s) => {
    const f = findClip(s.project, s.selectedId);
    return !!f && s.playhead >= f.clip.start && s.playhead < clipEnd(f.clip);
  });
  const found = findClip(project, selectedId);
  const ctx = canvasRef.current?.getContext('2d');

  /** Clic en el lienzo: selecciona el elemento visible más alto bajo el puntero. */
  const pick = (e: React.PointerEvent) => {
    if (!ctx) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / scale;
    const py = (e.clientY - r.top) / scale;
    const st = useEditor.getState();
    for (const track of st.project.tracks) {
      if (track.kind !== 'visual' || track.hidden) continue;
      for (const c of track.clips) {
        if (c.type === 'audio' || st.playhead < c.start || st.playhead >= clipEnd(c)) continue;
        const asset = isMediaClip(c) ? st.project.assets.find((a) => a.id === c.assetId) : undefined;
        const b = visualBox(ctx, c, st.project, asset, st.playhead - c.start);
        const a = (-b.rotation * Math.PI) / 180;
        const dx = px - b.cx;
        const dy = py - b.cy;
        const lx = dx * Math.cos(a) - dy * Math.sin(a);
        const ly = dx * Math.sin(a) + dy * Math.cos(a);
        if (Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2) {
          if (e.shiftKey) {
            st.toggleSelect(c.id);
            return;
          }
          st.select(c.id);
          if (!track.locked) startDrag(e, c.id, 'move');
          return;
        }
      }
    }
    if (!e.shiftKey) st.select(null);
  };

  const startDrag = (e: React.PointerEvent, id: string, mode: 'move' | 'scale' | 'rotate') => {
    e.stopPropagation();
    e.preventDefault();
    const st = useEditor.getState();
    const f = findClip(st.project, id);
    if (!f || f.clip.type === 'audio' || f.track.locked) return;
    // Con keyframes se edita (o crea) el keyframe del cabezal
    const local = st.playhead - f.clip.start;
    const t0 = animState(f.clip, local).transform;
    const stage = (e.currentTarget as HTMLElement).closest('.stage-inner')!.getBoundingClientRect();
    const toCanvas = (ev: PointerEvent) => ({ x: (ev.clientX - stage.left) / scale, y: (ev.clientY - stage.top) / scale });
    const start = toCanvas(e.nativeEvent);
    const d0 = Math.hypot(start.x - t0.x, start.y - t0.y) || 1;
    const a0 = Math.atan2(start.y - t0.y, start.x - t0.x);
    const W = st.project.width;
    const H = st.project.height;
    st.checkpoint();

    const move = (ev: PointerEvent) => {
      const pt = toCanvas(ev);
      st.updateClip(id, (c) => {
        if (c.type === 'audio') return;
        const tr = { ...t0 };
        if (mode === 'move') {
          let x = t0.x + pt.x - start.x;
          let y = t0.y + pt.y - start.y;
          // Imán al centro del lienzo
          if (!ev.altKey) {
            const thr = 10 / scale;
            if (Math.abs(x - W / 2) < thr) x = W / 2;
            if (Math.abs(y - H / 2) < thr) y = H / 2;
          }
          tr.x = Math.round(x);
          tr.y = Math.round(y);
        } else if (mode === 'scale') {
          tr.scale = Math.max(0.01, t0.scale * (Math.hypot(pt.x - t0.x, pt.y - t0.y) / d0));
        } else {
          let deg = t0.rotation + ((Math.atan2(pt.y - t0.y, pt.x - t0.x) - a0) * 180) / Math.PI;
          if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
          tr.rotation = Math.round(deg * 10) / 10;
        }
        const patch = mode === 'move' ? { x: tr.x, y: tr.y } : mode === 'scale' ? { scale: tr.scale } : { rotation: tr.rotation };
        setAnimated(c, local, patch, st.project.fps);
      }, false);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  let box: React.ReactNode = null;
  if (found && isActive && found.clip.type !== 'audio' && ctx) {
    const c = found.clip;
    const asset = isMediaClip(c) ? project.assets.find((a) => a.id === c.assetId) : undefined;
    const b = visualBox(ctx, c, project, asset, playhead - c.start);
    box = (
      <div
        className="sel-box"
        style={{
          left: (b.cx - b.w / 2) * scale,
          top: (b.cy - b.h / 2) * scale,
          width: b.w * scale,
          height: b.h * scale,
          transform: `rotate(${b.rotation}deg)`,
        }}
        onPointerDown={(e) => startDrag(e, c.id, 'move')}
      >
        <div className="sel-rot-line" />
        <div className="sel-handle rot" style={{ left: '50%', top: -26 }} onPointerDown={(e) => startDrag(e, c.id, 'rotate')} />
        {[
          [0, 0, 'nwse-resize'],
          [100, 0, 'nesw-resize'],
          [0, 100, 'nesw-resize'],
          [100, 100, 'nwse-resize'],
        ].map(([x, y, cursor]) => (
          <div
            key={`${x}${y}`}
            className="sel-handle"
            style={{ left: `${x}%`, top: `${y}%`, cursor: cursor as string }}
            onPointerDown={(e) => startDrag(e, c.id, 'scale')}
          />
        ))}
      </div>
    );
  }

  return (
    <div style={{ position: 'absolute', inset: 0 }} onPointerDown={pick}>
      {box}
    </div>
  );
}

function Transport() {
  const playing = useEditor((s) => s.playing);
  const playhead = useEditor((s) => s.playhead);
  const fps = useEditor((s) => s.project.fps);
  const duration = useEditor((s) => projectDuration(s.project));
  const w = useEditor((s) => s.project.width);
  const h = useEditor((s) => s.project.height);
  const { setPlaying, setPlayhead } = useEditor.getState();
  return (
    <div className="transport">
      <div className="tc">
        {formatTime(playhead, fps)} <span>/ {formatTime(duration, fps)}</span>
      </div>
      <div className="center">
        <button className="btn icon ghost" title="Inicio" onClick={() => setPlayhead(0)}>
          <ChevronFirst size={16} />
        </button>
        <button className="btn icon ghost" title="Fotograma anterior" onClick={() => setPlayhead(playhead - 1 / fps)}>
          <StepBack size={16} />
        </button>
        <button className="btn icon primary play-btn" title="Reproducir (Espacio)" onClick={() => setPlaying(!playing)}>
          {playing ? <Pause size={16} /> : <Play size={16} style={{ marginLeft: 2 }} />}
        </button>
        <button className="btn icon ghost" title="Fotograma siguiente" onClick={() => setPlayhead(playhead + 1 / fps)}>
          <StepForward size={16} />
        </button>
        <button className="btn icon ghost" title="Final" onClick={() => setPlayhead(duration)}>
          <ChevronLast size={16} />
        </button>
      </div>
      <div className="right">
        {w}×{h} · {fps} fps
      </div>
    </div>
  );
}
