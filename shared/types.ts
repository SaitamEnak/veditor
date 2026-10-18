// Modelo de datos del proyecto. Lo comparten el cliente (edición/preview)
// y el servidor (persistencia/exportación con FFmpeg).
// Todos los tiempos están en segundos; las posiciones en píxeles del lienzo.

export type AssetKind = 'video' | 'audio' | 'image';

export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  /** Nombre del archivo dentro de data/media */
  file: string;
  /** URL para reproducir en el navegador (original o proxy) */
  url: string;
  thumb?: string;
  waveform?: string;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  size: number;
}

export interface Transform {
  /** Centro del elemento en coordenadas del lienzo */
  x: number;
  y: number;
  scale: number;
  /** Grados */
  rotation: number;
  /** 0..1 */
  opacity: number;
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  uppercase: boolean;
  color: string;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  letterSpacing: number;
  strokeColor: string;
  strokeWidth: number;
  background: string;
  backgroundOpacity: number;
  padding: number;
  radius: number;
  shadowColor: string;
  shadowBlur: number;
  /** Ancho máximo antes de partir líneas (0 = sin límite) */
  maxWidth: number;
  /** Ancho fijo de la caja (0 o ausente = se ajusta al texto). Permite anclar textos alineados a la izquierda. */
  boxWidth?: number;
}

interface ClipBase {
  id: string;
  /** Inicio en la línea de tiempo */
  start: number;
  duration: number;
  fadeIn: number;
  fadeOut: number;
}

/**
 * Nodo de la curva de volumen. `t` está en tiempo de la FUENTE (segundos dentro del archivo),
 * así los nodos quedan pegados al sonido aunque el clip se recorte, divida o mueva.
 */
export interface VolumeKey {
  t: number;
  /** 0..2 (1 = 100%) */
  v: number;
}

export interface MediaClip extends ClipBase {
  type: 'video' | 'audio' | 'image';
  assetId: string;
  /** Punto de entrada dentro del archivo fuente */
  in: number;
  /** 0..2 */
  volume: number;
  transform: Transform;
  /** Curva de volumen (se multiplica por `volume`). Ordenada por t. */
  volumeKeys?: VolumeKey[];
  /** Video cuyo audio se separó a un clip de audio independiente: el video queda mudo */
  audioDetached?: boolean;
  keyframes?: Keyframe[];
}

export interface TextClip extends ClipBase {
  type: 'text' | 'subtitle';
  text: string;
  style: TextStyle;
  transform: Transform;
  keyframes?: Keyframe[];
}

/** Forma vectorial (rectángulo, elipse o trazado SVG) dibujada por el navegador. */
export interface ShapeClip extends ClipBase {
  type: 'shape';
  shape: 'rect' | 'ellipse' | 'path';
  /** Nombre de la capa (opcional, para la línea de tiempo) */
  name?: string;
  /** Tamaño en px del lienzo (antes de la escala del transform) */
  w: number;
  h: number;
  fill: string;
  /** 0..1 */
  fillOpacity: number;
  radius: number;
  stroke: string;
  strokeWidth: number;
  shadowColor: string;
  /** 0 = sin sombra */
  shadowBlur: number;
  shadowY: number;
  shadowOpacity: number;
  /** Trazado SVG (atributo d) en un viewBox de pathW×pathH; se estira a w×h */
  path?: string;
  pathW?: number;
  pathH?: number;
  transform: Transform;
  keyframes?: Keyframe[];
}

export type Clip = MediaClip | TextClip | ShapeClip;

// ---- Keyframes ----

export type Easing = 'linear' | 'in' | 'out' | 'inOut' | 'back';
export const EASINGS: { value: Easing; label: string }[] = [
  { value: 'linear', label: 'Lineal' },
  { value: 'in', label: 'Acelera' },
  { value: 'out', label: 'Frena' },
  { value: 'inOut', label: 'Suave' },
  { value: 'back', label: 'Rebote' },
];

/** Propiedades animables: las del transform, el tamaño de las formas y el revelado del texto (0..1 de caracteres). */
export type AnimProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'w' | 'h' | 'reveal';
export const ANIM_PROPS: AnimProp[] = ['x', 'y', 'scale', 'rotation', 'opacity', 'w', 'h', 'reveal'];

/**
 * Keyframe en tiempo LOCAL del clip (segundos desde su inicio). Sólo define las propiedades que fija;
 * cada propiedad se interpola entre los keyframes que la definen. `ease` es la curva del tramo que LLEGA a este keyframe.
 */
export type Keyframe = { t: number; ease?: Easing } & Partial<Record<AnimProp, number>>;

export function easeFn(e: Easing | undefined, p: number): number {
  switch (e ?? 'inOut') {
    case 'linear':
      return p;
    case 'in':
      return p * p * p;
    case 'out':
      return 1 - (1 - p) ** 3;
    case 'back': {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2;
    }
    default:
      return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
  }
}

export const keyframesOf = (c: Clip): Keyframe[] | undefined => (c.type === 'audio' ? undefined : c.keyframes);

/** Valor base (sin animar) de una propiedad. */
export function baseValue(c: Clip, prop: AnimProp): number {
  if (prop === 'reveal') return 1;
  if (prop === 'w' || prop === 'h') return c.type === 'shape' ? c[prop] : 0;
  return c.type === 'audio' ? 0 : c.transform[prop];
}

/** Valor de una propiedad en el tiempo local del clip. */
export function animValue(c: Clip, prop: AnimProp, local: number): number {
  const keys = keyframesOf(c)?.filter((k) => k[prop] !== undefined);
  if (!keys?.length) return baseValue(c, prop);
  if (local <= keys[0].t) return keys[0][prop]!;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (local < b.t) {
      const p = (local - a.t) / Math.max(1e-6, b.t - a.t);
      return a[prop]! + (b[prop]! - a[prop]!) * easeFn(b.ease, p);
    }
  }
  return keys[keys.length - 1][prop]!;
}

/** Estado animado de un clip visual en su tiempo local. */
export function animState(c: Clip, local: number) {
  const v = (p: AnimProp) => animValue(c, p, local);
  const transform: Transform = { x: v('x'), y: v('y'), scale: v('scale'), rotation: v('rotation'), opacity: v('opacity') };
  return { transform, w: v('w'), h: v('h'), reveal: v('reveal') };
}
export type AnimState = ReturnType<typeof animState>;

/**
 * Fija propiedades en el tiempo local `local`. Sin keyframes cambia el valor base;
 * con keyframes (o `forceKey`) crea o actualiza el keyframe de ese instante (± medio fotograma).
 */
export function setAnimated(c: Clip, local: number, patch: Partial<Record<AnimProp, number>>, fps = 30, forceKey = false) {
  if (c.type === 'audio') return;
  if (!c.keyframes?.length && !forceKey) {
    for (const [k, val] of Object.entries(patch) as [AnimProp, number][]) {
      if (k === 'w' || k === 'h') {
        if (c.type === 'shape') c[k] = val;
      } else if (k !== 'reveal') c.transform[k] = val;
    }
    return;
  }
  const list = (c.keyframes ??= []);
  let k = list.find((x) => Math.abs(x.t - local) < 0.5 / fps);
  if (!k) {
    k = { t: Math.round(local * 1000) / 1000 };
    // El nuevo keyframe congela las propiedades ya animadas para no alterar el resto de la animación
    for (const p of ANIM_PROPS) if (list.some((x) => x[p] !== undefined)) k[p] = animValue(c, p, local);
    list.push(k);
    list.sort((a, b) => a.t - b.t);
  }
  Object.assign(k, patch);
}

/** Desplaza los keyframes (al recortar el inicio o dividir un clip) para que sigan pegados al contenido. */
export function shiftKeyframes(c: Clip, dt: number) {
  for (const k of keyframesOf(c) ?? []) k.t = Math.round((k.t + dt) * 1000) / 1000;
}

export type TrackKind = 'visual' | 'audio';

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
  clips: Clip[];
}

export interface Project {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  background: string;
  /** tracks[0] es la pista superior (se dibuja encima) */
  tracks: Track[];
  assets: Asset[];
}

export interface ExportOptions {
  crf: number;
  preset: 'ultrafast' | 'veryfast' | 'medium' | 'slow';
}

export interface ExportJob {
  id: string;
  status: 'running' | 'done' | 'error';
  progress: number;
  error?: string;
  url?: string;
}

export const isMediaClip = (c: Clip): c is MediaClip =>
  c.type === 'video' || c.type === 'audio' || c.type === 'image';

export const isTextClip = (c: Clip): c is TextClip => c.type === 'text' || c.type === 'subtitle';

export const isShapeClip = (c: Clip): c is ShapeClip => c.type === 'shape';

/**
 * Plan de capas para exportar, de abajo hacia arriba. Los videos los compone FFmpeg; cada tramo de capas
 * gráficas consecutivas (textos, formas, imágenes) lo dibuja el navegador cuadro a cuadro, igual que la
 * vista previa, como una secuencia de PNG transparentes que van de los fotogramas k0 a k1 (sin incluir k1).
 */
export type LayerItem =
  | { kind: 'video'; clip: MediaClip; track: Track }
  | { kind: 'gfx'; clips: Clip[]; k0: number; k1: number };

export function planLayers(p: Project): LayerItem[] {
  const out: LayerItem[] = [];
  let run: Clip[] = [];
  const flush = () => {
    if (!run.length) return;
    const k0 = Math.ceil(Math.min(...run.map((c) => c.start)) * p.fps - 1e-6);
    const k1 = Math.ceil(Math.max(...run.map(clipEnd)) * p.fps - 1e-6);
    if (k1 > k0) out.push({ kind: 'gfx', clips: run, k0, k1 });
    run = [];
  };
  for (const track of [...p.tracks].reverse()) {
    if (track.kind !== 'visual' || track.hidden) continue;
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      if (clip.type === 'audio') continue;
      if (clip.type === 'video') {
        flush();
        out.push({ kind: 'video', clip, track });
      } else run.push(clip);
    }
  }
  flush();
  return out;
}

export const clipEnd = (c: Clip) => c.start + c.duration;

export function projectDuration(p: Project): number {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

/** Tamaño base de un medio visual: encaja ("contain") en el lienzo, luego se aplica scale. */
export function fittedSize(aw: number, ah: number, cw: number, ch: number, scale: number) {
  const fit = Math.min(cw / aw, ch / ah);
  return { w: aw * fit * scale, h: ah * fit * scale };
}

export const MAX_GAIN = 2;

/** Valor de la curva de volumen en un instante de la fuente (interpolación lineal). */
export function envelopeAt(keys: VolumeKey[] | undefined, sourceT: number): number {
  if (!keys || keys.length === 0) return 1;
  if (sourceT <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (sourceT < b.t) return a.v + ((b.v - a.v) * (sourceT - a.t)) / Math.max(1e-6, b.t - a.t);
  }
  return keys[keys.length - 1].v;
}

/** Factor 0..1 de fundido de entrada/salida en el tiempo local del clip. */
export function fadeFactor(c: Clip, local: number): number {
  let f = 1;
  if (c.fadeIn > 0 && local < c.fadeIn) f = Math.min(f, local / c.fadeIn);
  const rem = c.duration - local;
  if (c.fadeOut > 0 && rem < c.fadeOut) f = Math.min(f, rem / c.fadeOut);
  return Math.max(0, Math.min(1, f));
}

export function createEmptyProject(): Project {
  return {
    id: 'default',
    name: 'Proyecto sin título',
    width: 1920,
    height: 1080,
    fps: 30,
    background: '#000000',
    tracks: [
      { id: 'tv1', name: 'Video 1', kind: 'visual', muted: false, hidden: false, locked: false, clips: [] },
      { id: 'ta1', name: 'Audio 1', kind: 'audio', muted: false, hidden: false, locked: false, clips: [] },
    ],
    assets: [],
  };
}
