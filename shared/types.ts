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
}

export interface TextClip extends ClipBase {
  type: 'text' | 'subtitle';
  text: string;
  style: TextStyle;
  transform: Transform;
}

export type Clip = MediaClip | TextClip;

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
