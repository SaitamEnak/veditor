import { create } from 'zustand';
import type { Asset, Clip, MediaClip, Project, ShapeClip, TextClip, Track, TrackKind } from '../shared/types';
import { clipEnd, createEmptyProject, isMediaClip, projectDuration, shiftKeyframes } from '../shared/types';
import { MIN_CLIP, findClip, isFree, nearestFreeStart, trackAccepts } from './lib/ops';
import { defaultShape, defaultTextStyle } from './lib/render';
import type { Cue } from './lib/srt';
import { uid } from './lib/util';

export type Tool = 'select' | 'razor';

interface Upload {
  id: string;
  name: string;
  error?: string;
}

interface EditorState {
  project: Project;
  ready: boolean;
  dirty: boolean;
  past: Project[];
  future: Project[];

  /** Clip principal (el que muestra el panel de propiedades) */
  selectedId: string | null;
  /** Todos los clips seleccionados (Shift+clic para añadir/quitar) */
  selectedIds: string[];
  playhead: number;
  playing: boolean;
  zoom: number;
  tool: Tool;
  snap: boolean;

  connection: 'connecting' | 'online' | 'offline';
  saving: boolean;
  /** Último cambio hecho por Claude (editando data/project.json) */
  claudeChange: { at: number; changed: number; removed: number } | null;
  /** Clips que Claude acaba de tocar: se resaltan un momento en la línea de tiempo */
  flashIds: string[];
  /** Carpeta del proyecto abierto (data/projects/<carpeta>) */
  folder: string;
  /** Se incrementa cuando cambia la lista de proyectos */
  projectsTick: number;
  uploads: Upload[];

  /** Muta una copia del proyecto. history=false para pasos intermedios de un arrastre. */
  update: (fn: (p: Project) => void, history?: boolean) => void;
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  applyRemote: (p: Project) => void;
  applyClaude: (p: Project) => void;

  select: (id: string | null) => void;
  toggleSelect: (id: string) => void;
  /** Mueve varios clips a la vez manteniendo su separación. Devuelve false si chocarían con otros clips. */
  moveClips: (ids: string[], dt: number, trackOffset: number, history?: boolean) => boolean;
  setPlayhead: (t: number) => void;
  setPlaying: (v: boolean) => void;
  setZoom: (z: number) => void;
  setTool: (t: Tool) => void;
  toggleSnap: () => void;

  addAsset: (a: Asset) => void;
  removeAsset: (id: string) => void;
  addAssetClip: (asset: Asset, opts?: { trackId?: string; start?: number }) => void;
  addTextClip: (kind: 'text' | 'subtitle', opts?: { trackId?: string; start?: number }) => void;
  addShapeClip: (shape: ShapeClip['shape'], opts?: { trackId?: string; start?: number; patch?: Partial<ShapeClip> }) => void;
  importCues: (cues: Cue[]) => void;
  updateClip: (id: string, fn: (c: Clip) => void, history?: boolean) => void;
  splitAt: (t: number, clipId?: string) => void;
  detachAudio: (clipId?: string) => void;
  deleteSelected: () => void;
  duplicateSelected: () => void;
  addTrack: (kind: TrackKind) => string;
  updateTrack: (id: string, patch: Partial<Track>) => void;
  removeTrack: (id: string) => void;
}

const newTrack = (p: Project, kind: TrackKind): Track => {
  const n = p.tracks.filter((t) => t.kind === kind).length + 1;
  return {
    id: uid('t'), name: `${kind === 'audio' ? 'Audio' : 'Video'} ${n}`, kind,
    muted: false, hidden: false, locked: false, clips: [],
  };
};

/** Las pistas visuales van arriba (la nueva encima de todas) y las de audio abajo. */
function insertTrack(p: Project, t: Track) {
  if (t.kind === 'visual') p.tracks.unshift(t);
  else p.tracks.push(t);
}

/** Pista compatible donde [start, start+dur] esté libre, o una nueva. */
function pickTrack(p: Project, type: Clip['type'], start: number, dur: number, trackId?: string) {
  const wanted = trackId && p.tracks.find((t) => t.id === trackId);
  if (wanted && trackAccepts(wanted, type) && !wanted.locked) return wanted;
  const candidates = p.tracks.filter((t) => trackAccepts(t, type) && !t.locked);
  // Para lo visual se prefiere la pista libre más alta
  const found = candidates.find((t) => isFree(t, start, dur));
  if (found) return found;
  const t = newTrack(p, type === 'audio' ? 'audio' : 'visual');
  insertTrack(p, t);
  return t;
}

/**
 * Checkpoint perezoso: se arma al empezar una interacción (arrastre, foco en un campo)
 * y sólo crea una entrada de historial si después hay un cambio sin historial.
 */
let armed: Project | null = null;

const sel = (id: string | null) => ({ selectedId: id, selectedIds: id ? [id] : [] });

/** Mantiene sólo los clips seleccionados que siguen existiendo en el proyecto. */
const keepSelection = (p: Project, s: { selectedId: string | null; selectedIds: string[] }) => {
  const selectedIds = s.selectedIds.filter((id) => findClip(p, id));
  const selectedId = s.selectedId && selectedIds.includes(s.selectedId) ? s.selectedId : (selectedIds[selectedIds.length - 1] ?? null);
  return { selectedId, selectedIds };
};

const centerTransform = (p: Project) => ({ x: p.width / 2, y: p.height / 2, scale: 1, rotation: 0, opacity: 1 });

export const useEditor = create<EditorState>((set, get) => ({
  project: createEmptyProject(),
  ready: false,
  dirty: false,
  past: [],
  future: [],
  selectedId: null,
  selectedIds: [],
  playhead: 0,
  playing: false,
  zoom: 60,
  tool: 'select',
  snap: true,
  connection: 'connecting',
  saving: false,
  claudeChange: null,
  flashIds: [],
  folder: '',
  projectsTick: 0,
  uploads: [],

  update: (fn, history = true) => {
    const prev = get().project;
    const next = structuredClone(prev);
    fn(next);
    const pushPrev = history || armed === prev;
    armed = null;
    set((s) => ({
      project: next,
      dirty: true,
      past: pushPrev ? [...s.past.slice(-99), prev] : s.past,
      future: pushPrev ? [] : s.future,
    }));
  },
  checkpoint: () => {
    armed = get().project;
  },
  undo: () => {
    const { past, project, future } = get();
    if (!past.length) return;
    set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future], dirty: true });
  },
  redo: () => {
    const { past, project, future } = get();
    if (!future.length) return;
    set({ project: future[0], future: future.slice(1), past: [...past, project], dirty: true });
  },
  applyRemote: (p) =>
    set((s) =>
      s.ready && p.id !== s.project.id
        ? // Otro proyecto: se empieza de cero
          { project: p, ready: true, dirty: false, past: [], future: [], selectedId: null, selectedIds: [], playhead: 0, playing: false, flashIds: [] }
        : { project: p, ready: true, dirty: false, ...keepSelection(p, s) },
    ),

  applyClaude: (p) => {
    const prev = get().project;
    const before = new Map(prev.tracks.flatMap((t) => t.clips.map((c) => [c.id, JSON.stringify(c)] as const)));
    const after = p.tracks.flatMap((t) => t.clips);
    const changedIds = after.filter((c) => before.get(c.id) !== JSON.stringify(c)).map((c) => c.id);
    const afterIds = new Set(after.map((c) => c.id));
    const removed = [...before.keys()].filter((id) => !afterIds.has(id)).length;
    set((s) => ({
      project: p,
      ready: true,
      dirty: false,
      past: [...s.past.slice(-99), prev],
      future: [],
      ...keepSelection(p, s),
      flashIds: changedIds,
      claudeChange: { at: Date.now(), changed: changedIds.length, removed },
    }));
  },

  select: (id) => set(sel(id)),
  toggleSelect: (id) =>
    set((s) => {
      if (s.selectedIds.includes(id)) {
        const selectedIds = s.selectedIds.filter((x) => x !== id);
        return { selectedIds, selectedId: s.selectedId === id ? (selectedIds[selectedIds.length - 1] ?? null) : s.selectedId };
      }
      return { selectedIds: [...s.selectedIds, id], selectedId: id };
    }),

  moveClips: (ids, dt, trackOffset, history = false) => {
    const p0 = get().project;
    const items = ids.map((id) => findClip(p0, id)).filter((f) => f && !f.track.locked) as NonNullable<ReturnType<typeof findClip>>[];
    if (!items.length) return false;
    dt = Math.max(dt, -Math.min(...items.map((f) => f.clip.start)));
    const idSet = new Set(items.map((f) => f.clip.id));

    const plan = (off: number) => {
      const out: { id: string; from: number; to: number; start: number; dur: number }[] = [];
      for (const f of items) {
        const from = p0.tracks.indexOf(f.track);
        const to = from + off;
        const target = p0.tracks[to];
        if (!target || target.locked || !trackAccepts(target, f.clip.type)) return null;
        out.push({ id: f.clip.id, from, to, start: f.clip.start + dt, dur: f.clip.duration });
      }
      // Sin choques con los clips que no se mueven ni entre los propios clips movidos
      for (const m of out) {
        const others = p0.tracks[m.to].clips.filter((c) => !idSet.has(c.id));
        if (others.some((c) => c.start < m.start + m.dur - 1e-6 && clipEnd(c) > m.start + 1e-6)) return null;
        if (out.some((o) => o !== m && o.to === m.to && o.start < m.start + m.dur - 1e-6 && o.start + o.dur > m.start + 1e-6)) return null;
      }
      return out;
    };
    const moves = plan(trackOffset) ?? (trackOffset ? plan(0) : null);
    if (!moves) return false;
    get().update((p) => {
      for (const m of moves) {
        const src = p.tracks[m.from];
        const i = src.clips.findIndex((c) => c.id === m.id);
        const [c] = src.clips.splice(i, 1);
        c.start = m.start;
        p.tracks[m.to].clips.push(c);
      }
    }, history);
    return true;
  },
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (v) => {
    const s = get();
    const end = projectDuration(s.project);
    if (v && s.playhead >= end - 0.01) set({ playhead: 0 });
    set({ playing: v && end > 0 });
  },
  setZoom: (z) => set({ zoom: Math.min(400, Math.max(4, z)) }),
  setTool: (tool) => set({ tool }),
  toggleSnap: () => set((s) => ({ snap: !s.snap })),

  addAsset: (a) => get().update((p) => void p.assets.push(a)),
  removeAsset: (id) =>
    get().update((p) => {
      p.assets = p.assets.filter((a) => a.id !== id);
      for (const t of p.tracks) t.clips = t.clips.filter((c) => !(isMediaClip(c) && c.assetId === id));
    }),

  addAssetClip: (asset, opts) => {
    const id = uid('c');
    get().update((p) => {
      const start = Math.max(0, opts?.start ?? get().playhead);
      const dur = asset.duration;
      const track = pickTrack(p, asset.kind, start, dur, opts?.trackId);
      const clip: MediaClip = {
        id, type: asset.kind, assetId: asset.id, start: nearestFreeStart(track, start, dur), duration: dur,
        in: 0, volume: 1, fadeIn: 0, fadeOut: 0, transform: centerTransform(p),
      };
      track.clips.push(clip);
    });
    set(sel(id));
  },

  addTextClip: (kind, opts) => {
    const id = uid('c');
    get().update((p) => {
      const start = Math.max(0, opts?.start ?? get().playhead);
      const dur = kind === 'subtitle' ? 2.5 : 4;
      const track = pickTrack(p, kind, start, dur, opts?.trackId);
      const clip: TextClip = {
        id, type: kind, start: nearestFreeStart(track, start, dur), duration: dur, fadeIn: 0, fadeOut: 0,
        text: kind === 'subtitle' ? 'Escribe el subtítulo aquí' : 'Título',
        style: defaultTextStyle(kind, p),
        transform: { ...centerTransform(p), y: kind === 'subtitle' ? p.height * 0.86 : p.height / 2 },
      };
      track.clips.push(clip);
    });
    set(sel(id));
  },

  addShapeClip: (shape, opts) => {
    const id = uid('c');
    get().update((p) => {
      const start = Math.max(0, opts?.start ?? get().playhead);
      const dur = 4;
      const track = pickTrack(p, 'shape', start, dur, opts?.trackId);
      const clip: ShapeClip = {
        ...defaultShape(p), shape, id, start: nearestFreeStart(track, start, dur), duration: dur, transform: centerTransform(p), ...opts?.patch,
      };
      if (shape === 'ellipse') clip.h = clip.w;
      track.clips.push(clip);
    });
    set(sel(id));
  },

  importCues: (cues) =>
    get().update((p) => {
      const track = newTrack(p, 'visual');
      track.name = 'Subtítulos';
      insertTrack(p, track);
      const style = defaultTextStyle('subtitle', p);
      for (const cue of cues) {
        track.clips.push({
          id: uid('c'), type: 'subtitle', start: cue.start, duration: Math.max(MIN_CLIP, cue.end - cue.start),
          fadeIn: 0, fadeOut: 0, text: cue.text, style: { ...style },
          transform: { ...centerTransform(p), y: p.height * 0.86 },
        });
      }
    }),

  updateClip: (id, fn, history = true) =>
    get().update((p) => {
      const f = findClip(p, id);
      if (f) fn(f.clip);
    }, history),

  splitAt: (t, clipId) => {
    const { project, selectedId, selectedIds } = get();
    const inside = (c: Clip) => t > c.start + MIN_CLIP / 2 && t < clipEnd(c) - MIN_CLIP / 2;
    const targetId = clipId ?? selectedId;
    const cuttable = (id: string) => {
      const f = findClip(project, id);
      return !!f && !f.track.locked && inside(f.clip);
    };
    // Con clipId: ese clip. Con selección: los seleccionados bajo el cabezal. Si no: todos los clips bajo el cabezal.
    let ids = clipId ? [clipId].filter(cuttable) : selectedIds.filter(cuttable);
    if (!clipId && !ids.length)
      ids = project.tracks.filter((tr) => !tr.locked).flatMap((tr) => tr.clips.filter(inside).map((c) => c.id));
    if (!ids.length) return;
    let newSel: string | null = null;
    const newIds: string[] = [];
    get().update((p) => {
      for (const id of ids) {
        const f = findClip(p, id)!;
        const a = f.clip;
        const b = structuredClone(a);
        b.id = uid('c');
        const cut = t - a.start;
        b.start = t;
        b.duration = a.duration - cut;
        b.fadeIn = 0;
        if (isMediaClip(b)) b.in = (a as MediaClip).in + cut;
        shiftKeyframes(b, -cut);
        a.duration = cut;
        a.fadeOut = 0;
        f.track.clips.splice(f.index + 1, 0, b);
        if (selectedIds.includes(id)) newIds.push(b.id);
        if (id === targetId) newSel = b.id;
      }
    });
    // La selección pasa a las mitades derechas de los clips cortados
    if (newIds.length) set({ selectedIds: newIds, selectedId: newSel ?? newIds[newIds.length - 1] });
    else if (newSel) set(sel(newSel));
  },

  detachAudio: (clipId) => {
    const id = clipId ?? get().selectedId;
    const st = get();
    const f = findClip(st.project, id);
    if (!f || f.clip.type !== 'video' || f.clip.audioDetached || f.track.locked) return;
    const asset = st.project.assets.find((a) => a.id === (f.clip as MediaClip).assetId);
    if (!asset?.hasAudio) return;
    const audioId = uid('c');
    get().update((p) => {
      const v = findClip(p, id)!.clip as MediaClip;
      const track = pickTrack(p, 'audio', v.start, v.duration);
      track.clips.push({
        id: audioId, type: 'audio', assetId: v.assetId, start: v.start, duration: v.duration, in: v.in,
        volume: v.volume, fadeIn: v.fadeIn, fadeOut: v.fadeOut, transform: { ...v.transform },
        ...(v.volumeKeys ? { volumeKeys: structuredClone(v.volumeKeys) } : {}),
      });
      v.audioDetached = true;
    });
    set(sel(audioId));
  },

  deleteSelected: () => {
    const { project, selectedIds } = get();
    const ids = selectedIds.filter((id) => {
      const f = findClip(project, id);
      return f && !f.track.locked;
    });
    if (!ids.length) return;
    get().update((p) => {
      for (const t of p.tracks) t.clips = t.clips.filter((c) => !ids.includes(c.id));
    });
    set((s) => keepSelection(s.project, s));
  },

  duplicateSelected: () => {
    const { project, selectedIds, selectedId } = get();
    const items = selectedIds.map((id) => findClip(project, id)).filter(Boolean) as NonNullable<ReturnType<typeof findClip>>[];
    if (!items.length) return;
    // Las copias van justo después del grupo, manteniendo la separación entre clips
    const shift = Math.max(...items.map((f) => clipEnd(f.clip))) - Math.min(...items.map((f) => f.clip.start));
    const map = new Map(items.map((f) => [f.clip.id, uid('c')]));
    get().update((p) => {
      for (const f of items) {
        const g = findClip(p, f.clip.id)!;
        const copy = { ...structuredClone(g.clip), id: map.get(f.clip.id)! };
        copy.start = nearestFreeStart(g.track, g.clip.start + shift, copy.duration);
        g.track.clips.push(copy);
      }
    });
    const newIds = [...map.values()];
    set({ selectedIds: newIds, selectedId: (selectedId && map.get(selectedId)) || newIds[newIds.length - 1] });
  },

  addTrack: (kind) => {
    let id = '';
    get().update((p) => {
      const t = newTrack(p, kind);
      id = t.id;
      insertTrack(p, t);
    });
    return id;
  },
  updateTrack: (id, patch) =>
    get().update((p) => {
      const t = p.tracks.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
    }),
  removeTrack: (id) =>
    get().update((p) => {
      p.tracks = p.tracks.filter((t) => t.id !== id);
    }),
}));
