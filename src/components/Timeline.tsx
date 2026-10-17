import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Copy, Eye, EyeOff, Lock, Unlink, Magnet, MousePointer2, Music, Plus, Scissors, SplitSquareHorizontal, Trash2, Unlock,
  Video, Volume2, VolumeX, ZoomIn, ZoomOut,
} from 'lucide-react';
import type { Asset, Clip, MediaClip, Track } from '../../shared/types';
import { clipEnd, isMediaClip, isTextClip, projectDuration } from '../../shared/types';
import { MIN_CLIP, findClip, nearestFreeStart, neighbours, trackAccepts } from '../lib/ops';
import { formatTime } from '../lib/util';
import { useEditor } from '../store';
import { Range } from './fields';
import { DND_ASSET, DND_TEXT, addPreset } from './MediaPanel';
import { VolumeEnvelope } from './VolumeEnvelope';

const HEADER_W = 176;
const TRACK_H = { visual: 68, audio: 72 };
const SNAP_PX = 8;

type DragMode = 'move' | 'trim-l' | 'trim-r';

export function Timeline() {
  const project = useEditor((s) => s.project);
  const zoom = useEditor((s) => s.zoom);
  const tool = useEditor((s) => s.tool);
  const snap = useEditor((s) => s.snap);
  const selectedIds = useEditor((s) => s.selectedIds);
  const flashIds = useEditor((s) => s.flashIds);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [viewW, setViewW] = useState(1000);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [razorX, setRazorX] = useState<number | null>(null);
  const [dropTrack, setDropTrack] = useState<string | null>(null);

  const duration = projectDuration(project);
  const contentW = Math.max(viewW - HEADER_W, (duration + 20) * zoom);
  const assets = useMemo(() => new Map(project.assets.map((a) => [a.id, a])), [project.assets]);

  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ctrl + rueda = zoom centrado en el ratón
  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const { zoom, setZoom } = useEditor.getState();
      const x = e.clientX - el.getBoundingClientRect().left - HEADER_W + el.scrollLeft;
      const t = x / zoom;
      const nz = Math.min(400, Math.max(4, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      setZoom(nz);
      requestAnimationFrame(() => (el.scrollLeft = t * nz - (x - el.scrollLeft)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /** Tiempo bajo el puntero (en segundos) */
  const timeAt = (clientX: number) => {
    const el = scrollRef.current!;
    return Math.max(0, (clientX - el.getBoundingClientRect().left - HEADER_W + el.scrollLeft) / zoom);
  };

  const snapPoints = (excludeId?: string) => {
    const pts = [0, useEditor.getState().playhead];
    for (const t of useEditor.getState().project.tracks)
      for (const c of t.clips) if (c.id !== excludeId) pts.push(c.start, clipEnd(c));
    return pts;
  };

  /** Devuelve el desplazamiento necesario para pegar alguno de `times` a un punto de snap. */
  const snapDelta = (times: number[], pts: number[]) => {
    if (!useEditor.getState().snap) return { delta: 0, at: null as number | null };
    const thr = SNAP_PX / useEditor.getState().zoom;
    let best = { delta: 0, at: null as number | null, d: thr };
    for (const t of times)
      for (const p of pts) {
        const d = Math.abs(p - t);
        if (d < best.d) best = { delta: p - t, at: p, d };
      }
    return best;
  };

  const snapTime = (t: number, pts: number[]) => t + snapDelta([t], pts).delta;

  const onClipPointerDown = (e: React.PointerEvent, clip: Clip, track: Track, mode: DragMode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const st = useEditor.getState();
    if (st.tool === 'razor') {
      if (!track.locked) st.splitAt(snapTime(timeAt(e.clientX), snapPoints(clip.id)), clip.id);
      return;
    }
    // Shift+clic: añade o quita el clip de la selección
    if (e.shiftKey && mode === 'move') {
      st.toggleSelect(clip.id);
      return;
    }
    const group = st.selectedIds.includes(clip.id) && st.selectedIds.length > 1 && mode === 'move';
    if (group) useEditor.setState({ selectedId: clip.id });
    else st.select(clip.id);
    if (track.locked) return;
    if (group) {
      startGroupDrag(e, clip, track, useEditor.getState().selectedIds);
      return;
    }

    const x0 = e.clientX;
    const y0 = e.clientY;
    const orig = structuredClone(clip);
    const asset = isMediaClip(clip) ? assets.get(clip.assetId) : undefined;
    const sourceLimited = (clip.type === 'video' || clip.type === 'audio') && asset;
    const pts = snapPoints(clip.id);
    let moved = false;
    document.body.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize';

    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3 && Math.abs(ev.clientY - y0) < 3) return;
      if (!moved) {
        useEditor.getState().checkpoint();
        moved = true;
      }
      const z = useEditor.getState().zoom;
      const dt = (ev.clientX - x0) / z;
      let line: number | null = null;

      useEditor.getState().update((p) => {
        const f = findClip(p, clip.id);
        if (!f) return;
        const c = f.clip;
        if (mode === 'move') {
          const s = Math.max(0, orig.start + dt);
          const sn = snapDelta([s, s + orig.duration], pts);
          line = sn.at;
          // Pista bajo el puntero
          const row = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-track]');
          let target = f.track;
          const over = row && p.tracks.find((t) => t.id === row.dataset.track);
          if (over && over !== f.track && trackAccepts(over, c.type) && !over.locked) target = over;
          const ns = nearestFreeStart(target, Math.max(0, s + sn.delta), c.duration, c.id);
          if (Math.abs(ns - (s + sn.delta)) > 1e-6) line = null;
          if (target !== f.track) {
            f.track.clips.splice(f.index, 1);
            target.clips.push(c);
          }
          c.start = ns;
        } else if (mode === 'trim-l') {
          const { prevEnd } = neighbours(f.track, orig);
          const min = Math.max(prevEnd, sourceLimited ? orig.start - (orig as MediaClip).in : 0);
          const max = clipEnd(orig) - MIN_CLIP;
          let ns = orig.start + dt;
          const sn = snapDelta([ns], pts);
          ns = Math.min(max, Math.max(min, ns + sn.delta));
          line = sn.at !== null && Math.abs(ns - sn.at) < 1e-6 ? sn.at : null;
          const d = ns - orig.start;
          c.start = ns;
          c.duration = orig.duration - d;
          if (isMediaClip(c)) c.in = Math.max(0, (orig as MediaClip).in + d);
        } else {
          const { nextStart } = neighbours(f.track, orig);
          const max = Math.min(nextStart, sourceLimited ? orig.start + asset!.duration - (orig as MediaClip).in : Infinity);
          let ne = clipEnd(orig) + dt;
          const sn = snapDelta([ne], pts);
          ne = Math.min(max, Math.max(orig.start + MIN_CLIP, ne + sn.delta));
          line = sn.at !== null && Math.abs(ne - sn.at) < 1e-6 ? sn.at : null;
          c.duration = ne - orig.start;
        }
      }, false);
      setSnapLine(line);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      setSnapLine(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /** Arrastre de varios clips: se mueven juntos (tiempo y pista) manteniendo su separación. */
  const startGroupDrag = (e: React.PointerEvent, clip: Clip, track: Track, ids: string[]) => {
    const x0 = e.clientX;
    const y0 = e.clientY;
    const p0 = useEditor.getState().project;
    const fromIdx = p0.tracks.findIndex((t) => t.id === track.id);
    const items = ids.map((id) => findClip(p0, id)!).filter(Boolean);
    const pts = snapPoints().filter((_, i) => i < 2);
    for (const t of p0.tracks) for (const c of t.clips) if (!ids.includes(c.id)) pts.push(c.start, clipEnd(c));
    const edges = items.flatMap((f) => [f.clip.start, clipEnd(f.clip)]);
    let moved = false;
    let last = p0;
    document.body.style.cursor = 'grabbing';

    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3 && Math.abs(ev.clientY - y0) < 3) return;
      const st = useEditor.getState();
      if (!moved) {
        st.checkpoint();
        moved = true;
      }
      const dt = (ev.clientX - x0) / st.zoom;
      const sn = snapDelta(edges.map((t) => t + dt), pts);
      const row = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-track]');
      const overIdx = row ? p0.tracks.findIndex((t) => t.id === row.dataset.track) : -1;
      const off = overIdx >= 0 ? overIdx - fromIdx : 0;
      // Cada movimiento parte de la posición original; si el destino choca, se queda en la última posición válida
      useEditor.setState({ project: p0 });
      const ok = st.moveClips(ids, dt + sn.delta, off, false);
      if (ok) last = useEditor.getState().project;
      else useEditor.setState({ project: last });
      setSnapLine(ok ? sn.at : null);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      setSnapLine(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startScrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const st = useEditor.getState();
    st.setPlaying(false);
    const pts = snapPoints();
    const seek = (x: number) => st.setPlayhead(snapTime(timeAt(x), pts.filter((_, i) => i !== 1)));
    seek(e.clientX);
    const onMove = (ev: PointerEvent) => seek(ev.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /**
   * Clic en zona vacía: deselecciona y mueve el cabezal.
   * Clic y arrastrar: recuadro de selección (con Shift se suma a la selección actual).
   */
  const onLaneDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const st = useEditor.getState();
    if (st.tool === 'razor') {
      startScrub(e);
      return;
    }
    const inner = innerRef.current!;
    const scroll = scrollRef.current!;
    const toContent = (cx: number, cy: number) => {
      const r = inner.getBoundingClientRect();
      return { x: Math.max(HEADER_W, cx - r.left), y: cy - r.top };
    };
    const a = toContent(e.clientX, e.clientY);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const base = e.shiftKey ? st.selectedIds : [];
    let dragging = false;

    const onMove = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      dragging = true;
      // Desplazamiento automático cerca de los bordes
      const sr = scroll.getBoundingClientRect();
      if (ev.clientX > sr.right - 30) scroll.scrollLeft += 20;
      else if (ev.clientX < sr.left + HEADER_W + 30) scroll.scrollLeft -= 20;
      if (ev.clientY > sr.bottom - 20) scroll.scrollTop += 12;
      else if (ev.clientY < sr.top + 40) scroll.scrollTop -= 12;

      const b = toContent(ev.clientX, ev.clientY);
      const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
      setMarquee(box);

      // Clips que tocan el recuadro
      const z = useEditor.getState().zoom;
      const ir = inner.getBoundingClientRect();
      const hits: string[] = [];
      for (const row of inner.querySelectorAll<HTMLElement>('[data-track]')) {
        const rr = row.getBoundingClientRect();
        const top = rr.top - ir.top;
        if (top > box.y + box.h || top + rr.height < box.y) continue;
        const track = useEditor.getState().project.tracks.find((t) => t.id === row.dataset.track);
        for (const c of track?.clips ?? []) {
          const cx0 = HEADER_W + c.start * z;
          const cx1 = cx0 + c.duration * z;
          if (cx1 >= box.x && cx0 <= box.x + box.w) hits.push(c.id);
        }
      }
      const ids = [...new Set([...base, ...hits])];
      useEditor.setState({ selectedIds: ids, selectedId: hits[hits.length - 1] ?? base[base.length - 1] ?? null });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setMarquee(null);
      if (dragging) return;
      // Fue un clic simple
      if (!ev.shiftKey) st.select(null);
      st.setPlaying(false);
      const pts = snapPoints();
      st.setPlayhead(snapTime(timeAt(ev.clientX), pts.filter((_, i) => i !== 1)));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const acceptsDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(DND_ASSET) || e.dataTransfer.types.includes(DND_TEXT);

  const onDrop = (e: React.DragEvent, trackId?: string) => {
    e.preventDefault();
    setDropTrack(null);
    const start = snapTime(timeAt(e.clientX), snapPoints());
    const assetId = e.dataTransfer.getData(DND_ASSET);
    const preset = e.dataTransfer.getData(DND_TEXT);
    if (assetId) {
      const a = assets.get(assetId);
      if (a) useEditor.getState().addAssetClip(a, { trackId, start });
    } else if (preset) addPreset(preset, { trackId, start });
  };

  return (
    <section className={`timeline ${tool === 'razor' ? 'razor' : ''}`}>
      <Toolbar viewW={viewW} duration={duration} />
      <div
        className="tl-scroll"
        ref={scrollRef}
        onPointerMove={(e) => setRazorX(tool === 'razor' ? snapTime(timeAt(e.clientX), snapPoints()) : null)}
        onPointerLeave={() => setRazorX(null)}
        onDragOver={(e) => acceptsDrag(e) && e.preventDefault()}
        onDrop={(e) => onDrop(e)}
      >
        <div className="tl-inner" ref={innerRef} style={{ width: HEADER_W + contentW }}>
          <div className="tl-ruler-row">
            <div className="tl-corner" style={{ width: HEADER_W }}>
              <PlayheadTime fps={project.fps} />
            </div>
            <Ruler zoom={zoom} width={contentW} onPointerDown={startScrub} />
          </div>

          {project.tracks.map((track) => (
            <TrackRow
              key={track.id}
              track={track}
              zoom={zoom}
              assets={assets}
              selectedIds={selectedIds}
              flashIds={flashIds}
              isDrop={dropTrack === track.id}
              onClipPointerDown={onClipPointerDown}
              onLaneDown={onLaneDown}
              onDragOver={(e) => {
                if (!acceptsDrag(e)) return;
                e.preventDefault();
                e.stopPropagation();
                setDropTrack(track.id);
              }}
              onDragLeave={() => setDropTrack(null)}
              onDrop={(e) => {
                e.stopPropagation();
                onDrop(e, track.id);
              }}
            />
          ))}

          <div className="tl-add">
            <button className="btn sm" onClick={() => useEditor.getState().addTrack('visual')}>
              <Plus size={13} /> Pista de video
            </button>
            <button className="btn sm" onClick={() => useEditor.getState().addTrack('audio')}>
              <Plus size={13} /> Pista de audio
            </button>
          </div>

          {duration === 0 && <div className="tl-empty">Arrastra medios o textos aquí para empezar</div>}

          <Playhead zoom={zoom} scrollRef={scrollRef} onPointerDown={startScrub} />
          {snapLine !== null && snap && <div className="guide-line snap" style={{ left: HEADER_W + snapLine * zoom }} />}
          {razorX !== null && <div className="guide-line razor" style={{ left: HEADER_W + razorX * zoom }} />}
          {marquee && <div className="marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
        </div>
      </div>
    </section>
  );
}

function Toolbar({ viewW, duration }: { viewW: number; duration: number }) {
  const tool = useEditor((s) => s.tool);
  const snap = useEditor((s) => s.snap);
  const zoom = useEditor((s) => s.zoom);
  const hasSel = useEditor((s) => s.selectedIds.length > 0);
  const canDetach = useEditor((s) => {
    const f = findClip(s.project, s.selectedId);
    if (!f || f.clip.type !== 'video' || f.clip.audioDetached || f.track.locked) return false;
    const id = f.clip.assetId;
    return !!s.project.assets.find((a) => a.id === id)?.hasAudio;
  });
  const st = useEditor.getState();
  const fit = () => st.setZoom((viewW - HEADER_W - 40) / Math.max(5, duration));
  return (
    <div className="tl-toolbar">
      <button className={`btn sm icon ${tool === 'select' ? 'active' : 'ghost'}`} title="Selección (V)" onClick={() => st.setTool('select')}>
        <MousePointer2 size={14} />
      </button>
      <button className={`btn sm icon ${tool === 'razor' ? 'active' : 'ghost'}`} title="Cuchilla: clic en un clip para cortarlo (C)" onClick={() => st.setTool('razor')}>
        <Scissors size={14} />
      </button>
      <div className="sep" />
      <button className="btn sm ghost" title="Dividir en el cabezal (S)" onClick={() => st.splitAt(useEditor.getState().playhead)}>
        <SplitSquareHorizontal size={14} /> Dividir
      </button>
      <button className="btn sm icon ghost" title="Duplicar (Ctrl+D)" disabled={!hasSel} onClick={st.duplicateSelected}>
        <Copy size={14} />
      </button>
      <button className="btn sm icon ghost danger" title="Eliminar (Supr)" disabled={!hasSel} onClick={st.deleteSelected}>
        <Trash2 size={14} />
      </button>
      <button className="btn sm ghost" title="Separar audio del video" disabled={!canDetach} onClick={() => st.detachAudio()}>
        <Unlink size={14} /> Separar audio
      </button>
      <div className="sep" />
      <button className={`btn sm icon ${snap ? 'active' : 'ghost'}`} title="Imán / ajuste" onClick={st.toggleSnap}>
        <Magnet size={14} />
      </button>
      <div className="spacer" />
      <button className="btn sm ghost" onClick={fit} title="Ajustar el proyecto a la ventana">
        Ajustar
      </button>
      <div className="zoom">
        <button className="btn sm icon ghost" onClick={() => st.setZoom(zoom / 1.3)}>
          <ZoomOut size={14} />
        </button>
        <Range label="Zoom" min={Math.log(4)} max={Math.log(400)} step={0.01} value={Math.log(zoom)} onChange={(v) => st.setZoom(Math.exp(v))} />
        <button className="btn sm icon ghost" onClick={() => st.setZoom(zoom * 1.3)}>
          <ZoomIn size={14} />
        </button>
      </div>
    </div>
  );
}

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

const Ruler = memo(function Ruler({ zoom, width, onPointerDown }: { zoom: number; width: number; onPointerDown: (e: React.PointerEvent) => void }) {
  const step = STEPS.find((s) => s * zoom >= 90) ?? 600;
  const minor = step / 5;
  const count = Math.ceil(width / zoom / step) + 1;
  const fps = useEditor((s) => s.project.fps);
  return (
    <div
      className="ruler"
      onPointerDown={onPointerDown}
      style={{
        width,
        backgroundImage: 'linear-gradient(to right, var(--line-2) 1px, transparent 1px)',
        backgroundSize: `${minor * zoom}px 6px`,
      }}
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <div className="ruler-major" style={{ left: i * step * zoom }} />
          <span className="ruler-label" style={{ left: i * step * zoom }}>
            {step < 1 ? formatTime(i * step, fps) : formatTime(i * step, fps, false)}
          </span>
        </div>
      ))}
    </div>
  );
});

function PlayheadTime({ fps }: { fps: number }) {
  const t = useEditor((s) => s.playhead);
  return <>{formatTime(t, fps)}</>;
}

function Playhead({ zoom, scrollRef, onPointerDown }: { zoom: number; scrollRef: React.RefObject<HTMLDivElement | null>; onPointerDown: (e: React.PointerEvent) => void }) {
  const t = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const x = HEADER_W + t * zoom;
  // Seguir el cabezal durante la reproducción
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    const right = el.scrollLeft + el.clientWidth;
    if (x > right - 40 || x < el.scrollLeft + HEADER_W) el.scrollLeft = x - HEADER_W - 40;
  }, [x, playing, scrollRef]);
  return (
    <div className="playhead" style={{ left: x }}>
      <div className="playhead-head" onPointerDown={onPointerDown} />
    </div>
  );
}

interface TrackRowProps {
  track: Track;
  zoom: number;
  assets: Map<string, Asset>;
  selectedIds: string[];
  flashIds: string[];
  isDrop: boolean;
  onClipPointerDown: (e: React.PointerEvent, clip: Clip, track: Track, mode: DragMode) => void;
  onLaneDown: (e: React.PointerEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}

function TrackRow(props: TrackRowProps) {
  const { track, zoom } = props;
  const { updateTrack, removeTrack } = useEditor.getState();
  const [editing, setEditing] = useState(false);
  const h = TRACK_H[track.kind];
  return (
    <div className={`track ${track.kind} ${track.locked ? 'locked' : ''} ${track.hidden ? 'hidden' : ''}`} style={{ height: h }} data-track={track.id}>
      <div className="track-head" style={{ width: HEADER_W }}>
        <div className="name" onDoubleClick={() => setEditing(true)} title="Doble clic para renombrar">
          {track.kind === 'audio' ? <Music size={13} color="var(--clip-audio)" /> : <Video size={13} color="var(--clip-video)" />}
          {editing ? (
            <input
              className="input"
              autoFocus
              defaultValue={track.name}
              onBlur={(e) => {
                updateTrack(track.id, { name: e.target.value || track.name });
                setEditing(false);
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.name}</span>
          )}
        </div>
        {track.kind === 'visual' && (
          <button className={`btn icon ghost ${track.hidden ? 'on' : ''}`} title={track.hidden ? 'Mostrar' : 'Ocultar'} onClick={() => updateTrack(track.id, { hidden: !track.hidden })}>
            {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        )}
        <button className={`btn icon ghost ${track.muted ? 'on' : ''}`} title={track.muted ? 'Activar audio' : 'Silenciar'} onClick={() => updateTrack(track.id, { muted: !track.muted })}>
          {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
        <button className={`btn icon ghost ${track.locked ? 'on' : ''}`} title={track.locked ? 'Desbloquear' : 'Bloquear'} onClick={() => updateTrack(track.id, { locked: !track.locked })}>
          {track.locked ? <Lock size={13} /> : <Unlock size={13} />}
        </button>
        <button className="btn icon ghost danger" title="Eliminar pista" onClick={() => removeTrack(track.id)}>
          <Trash2 size={12} />
        </button>
      </div>
      <div
        className={`lane ${props.isDrop ? 'drop' : ''}`}
        onPointerDown={props.onLaneDown}
        onDragOver={props.onDragOver}
        onDragLeave={props.onDragLeave}
        onDrop={props.onDrop}
      >
        {track.clips.map((clip) => (
          <ClipView
            key={clip.id}
            clip={clip}
            zoom={zoom}
            asset={isMediaClip(clip) ? props.assets.get(clip.assetId) : undefined}
            selected={props.selectedIds.includes(clip.id)}
            flash={props.flashIds.includes(clip.id)}
            height={TRACK_H[track.kind] - 8}
            locked={track.locked}
            onPointerDown={(e, mode) => props.onClipPointerDown(e, clip, track, mode)}
          />
        ))}
      </div>
    </div>
  );
}

const ClipView = memo(function ClipView({ clip, zoom, asset, selected, flash, height, locked, onPointerDown }: {
  clip: Clip;
  zoom: number;
  asset?: Asset;
  selected: boolean;
  flash: boolean;
  height: number;
  locked: boolean;
  onPointerDown: (e: React.PointerEvent, mode: DragMode) => void;
}) {
  const w = clip.duration * zoom;
  const label = isTextClip(clip) ? clip.text.replace(/\n/g, ' ') : asset?.name ?? '(medio no encontrado)';
  const inPoint = isMediaClip(clip) ? clip.in : 0;
  const hasSound = !!asset?.hasAudio && (clip.type === 'audio' || (clip.type === 'video' && !clip.audioDetached));
  return (
    <div
      className={`clip ${clip.type} ${selected ? 'selected' : ''} ${flash ? 'flash' : ''}`}
      style={{ left: clip.start * zoom, width: Math.max(2, w) }}
      onPointerDown={(e) => onPointerDown(e, 'move')}
      title={label}
    >
      {asset?.thumb && clip.type !== 'audio' && <div className="clip-thumbs" style={{ backgroundImage: `url(${asset.thumb})` }} />}
      {asset?.waveform && (clip.type === 'audio' || (clip.type === 'video' && !clip.audioDetached)) && (
        <div
          className="clip-wave"
          style={{
            backgroundImage: `url(${asset.waveform})`,
            backgroundSize: `${asset.duration * zoom}px 100%`,
            backgroundPosition: `${-inPoint * zoom}px 0`,
          }}
        />
      )}
      {clip.fadeIn > 0 && <div className="clip-fade in" style={{ width: clip.fadeIn * zoom }} />}
      {clip.fadeOut > 0 && <div className="clip-fade out" style={{ width: clip.fadeOut * zoom }} />}
      {w > 30 && (
        <div className="clip-label">
          {clip.type === 'video' && clip.audioDetached && <Unlink size={11} style={{ flex: 'none' }} />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
          {w > 120 && <span className="dur">{clip.duration.toFixed(1)}s</span>}
        </div>
      )}
      <div className="clip-handle l" onPointerDown={(e) => onPointerDown(e, 'trim-l')} />
      {hasSound && <VolumeEnvelope clip={clip as MediaClip} zoom={zoom} height={height} locked={locked} />}
      <div className="clip-handle r" onPointerDown={(e) => onPointerDown(e, 'trim-r')} />
    </div>
  );
});

