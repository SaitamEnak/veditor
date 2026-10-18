import type { AnimState, Asset, Clip, MediaClip, Project, ShapeClip, TextClip, TextStyle } from '../../shared/types';
import { animState, clipEnd, fadeFactor, fittedSize, isShapeClip, isTextClip } from '../../shared/types';
import { hexToRgba } from './util';

export const FONTS = [
  'Inter', 'Montserrat', 'Poppins', 'Roboto', 'Oswald', 'Bebas Neue', 'Playfair Display', 'Permanent Marker', 'JetBrains Mono',
  'Arial', 'Georgia', 'Impact',
];

export function defaultTextStyle(kind: 'text' | 'subtitle', p: Project): TextStyle {
  const base = p.height / 1080;
  if (kind === 'subtitle') {
    return {
      fontFamily: 'Inter', fontSize: Math.round(46 * base), fontWeight: 600, italic: false, uppercase: false,
      color: '#ffffff', align: 'center', lineHeight: 1.25, letterSpacing: 0,
      strokeColor: '#000000', strokeWidth: 0, background: '#000000', backgroundOpacity: 0.65,
      padding: Math.round(14 * base), radius: Math.round(8 * base), shadowColor: '#000000', shadowBlur: 0,
      maxWidth: Math.round(p.width * 0.8),
    };
  }
  return {
    fontFamily: 'Montserrat', fontSize: Math.round(110 * base), fontWeight: 900, italic: false, uppercase: false,
    color: '#ffffff', align: 'center', lineHeight: 1.1, letterSpacing: 0,
    strokeColor: '#000000', strokeWidth: 0, background: '#000000', backgroundOpacity: 0,
    padding: Math.round(20 * base), radius: Math.round(12 * base), shadowColor: '#000000', shadowBlur: Math.round(24 * base),
    maxWidth: Math.round(p.width * 0.9),
  };
}

export function defaultShape(p: Project): Omit<ShapeClip, 'id' | 'start' | 'duration' | 'transform'> {
  const base = p.height / 1080;
  return {
    type: 'shape', shape: 'rect', w: Math.round(400 * base), h: Math.round(240 * base), fill: '#7c6cff', fillOpacity: 1,
    radius: Math.round(24 * base), stroke: '#000000', strokeWidth: 0, shadowColor: '#000000', shadowBlur: 0,
    shadowY: Math.round(12 * base), shadowOpacity: 0.25, fadeIn: 0, fadeOut: 0,
  };
}

export const fontString = (s: TextStyle) =>
  `${s.italic ? 'italic ' : ''}${s.fontWeight} ${s.fontSize}px "${s.fontFamily}", sans-serif`;

type Ctx = CanvasRenderingContext2D;

function applyFont(ctx: Ctx, s: TextStyle) {
  ctx.font = fontString(s);
  if ('letterSpacing' in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = `${s.letterSpacing}px`;
}

export function layoutText(ctx: Ctx, clip: TextClip) {
  const s = clip.style;
  applyFont(ctx, s);
  const raw = s.uppercase ? clip.text.toUpperCase() : clip.text;
  const lines: string[] = [];
  for (const para of raw.split('\n')) {
    if (!s.maxWidth) {
      lines.push(para);
      continue;
    }
    let cur = '';
    for (const word of para.split(' ')) {
      const test = cur ? `${cur} ${word}` : word;
      if (cur && ctx.measureText(test).width > s.maxWidth) {
        lines.push(cur);
        cur = word;
      } else cur = test;
    }
    lines.push(cur);
  }
  const widths = lines.map((l) => ctx.measureText(l).width);
  const lineH = s.fontSize * s.lineHeight;
  const textW = s.boxWidth || Math.max(1, ...widths);
  return {
    lines,
    widths,
    lineH,
    boxW: textW + s.padding * 2,
    boxH: lines.length * lineH + s.padding * 2,
  };
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

function applyTransform(ctx: Ctx, t: AnimState['transform']) {
  ctx.translate(t.x, t.y);
  ctx.rotate((t.rotation * Math.PI) / 180);
  ctx.scale(t.scale, t.scale);
}

/** Dibuja un clip de texto/subtítulo. Lo usan la vista previa y la exportación (WYSIWYG). */
export function drawText(ctx: Ctx, clip: TextClip, alpha = 1, st: AnimState = animState(clip, 0)) {
  const s = clip.style;
  const t = st.transform;
  const L = layoutText(ctx, clip);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, t.opacity * alpha));
  applyTransform(ctx, t);

  if (s.backgroundOpacity > 0) {
    ctx.fillStyle = hexToRgba(s.background, s.backgroundOpacity);
    roundRect(ctx, -L.boxW / 2, -L.boxH / 2, L.boxW, L.boxH, s.radius);
    ctx.fill();
  }

  ctx.textBaseline = 'middle';
  ctx.textAlign = s.align;
  const ax = s.align === 'left' ? -L.boxW / 2 + s.padding : s.align === 'right' ? L.boxW / 2 - s.padding : 0;
  const y0 = -L.boxH / 2 + s.padding + L.lineH / 2;
  // Revelado tipo máquina de escribir: el diseño se calcula con el texto completo para que no salte
  let budget = st.reveal >= 1 ? Infinity : Math.round(Math.max(0, st.reveal) * L.lines.reduce((n, l) => n + [...l].length, 0));

  L.lines.forEach((full, i) => {
    if (budget <= 0) return;
    const chars = [...full];
    const line = budget >= chars.length ? full : chars.slice(0, budget).join('');
    budget -= chars.length;
    // Con revelado parcial y alineación centrada/derecha, la línea se ancla donde estaría completa
    let x = ax;
    if (line !== full && s.align !== 'left') {
      const wFull = L.widths[i];
      const left = s.align === 'center' ? ax - wFull / 2 : ax - wFull;
      ctx.textAlign = 'left';
      x = left;
    }
    const y = y0 + i * L.lineH;
    if (s.shadowBlur > 0) {
      ctx.shadowColor = hexToRgba(s.shadowColor, 0.8);
      ctx.shadowBlur = s.shadowBlur;
      ctx.shadowOffsetY = s.shadowBlur / 6;
    }
    if (s.strokeWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = s.strokeWidth * 2;
      ctx.strokeStyle = s.strokeColor;
      ctx.strokeText(line, x, y);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = s.color;
    ctx.fillText(line, x, y);
    ctx.shadowColor = 'transparent';
    ctx.textAlign = s.align;
  });
  ctx.restore();
}

const paths = new Map<string, Path2D>();
const path2d = (d: string) => {
  let p = paths.get(d);
  if (!p) paths.set(d, (p = new Path2D(d)));
  return p;
};

/** Dibuja una forma (rectángulo redondeado, elipse o trazado SVG). */
export function drawShape(ctx: Ctx, clip: ShapeClip, alpha = 1, st: AnimState = animState(clip, 0)) {
  const { w, h } = st;
  if (w <= 0 || h <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, st.transform.opacity * alpha));
  applyTransform(ctx, st.transform);
  if (clip.shadowBlur > 0 && clip.shadowOpacity > 0) {
    ctx.shadowColor = hexToRgba(clip.shadowColor, clip.shadowOpacity);
    ctx.shadowBlur = clip.shadowBlur;
    ctx.shadowOffsetY = clip.shadowY;
  }
  ctx.fillStyle = hexToRgba(clip.fill, clip.fillOpacity);
  ctx.strokeStyle = clip.stroke;
  ctx.lineWidth = clip.strokeWidth;
  ctx.lineJoin = 'round';
  if (clip.shape === 'path' && clip.path) {
    const sx = w / (clip.pathW || 100);
    const sy = h / (clip.pathH || 100);
    ctx.translate(-w / 2, -h / 2);
    ctx.scale(sx, sy);
    const p = path2d(clip.path);
    if (clip.fillOpacity > 0) ctx.fill(p);
    if (clip.strokeWidth > 0) {
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = clip.strokeWidth / ((sx + sy) / 2);
      ctx.stroke(p);
    }
  } else {
    if (clip.shape === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else roundRect(ctx, -w / 2, -h / 2, w, h, clip.radius);
    if (clip.fillOpacity > 0) ctx.fill();
    if (clip.strokeWidth > 0) {
      ctx.shadowColor = 'transparent';
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Dibuja un medio visual (imagen o fotograma de video) con su transform animado. */
export function drawMedia(ctx: Ctx, src: CanvasImageSource, asset: Asset, p: Project, alpha: number, st: AnimState) {
  const t = st.transform;
  const { w, h } = fittedSize(asset.width, asset.height, p.width, p.height, 1);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, t.opacity * alpha));
  applyTransform(ctx, t);
  ctx.drawImage(src, -w / 2, -h / 2, w, h);
  ctx.restore();
}

export interface LayerSources {
  image: (asset: Asset) => CanvasImageSource | null;
  video?: (clip: MediaClip, asset: Asset) => CanvasImageSource | null;
}

/** Dibuja un clip visual en el instante `t` de la línea de tiempo. */
export function drawClipAt(ctx: Ctx, clip: Clip, t: number, p: Project, sources: LayerSources) {
  const local = t - clip.start;
  const alpha = fadeFactor(clip, local);
  const st = animState(clip, local);
  if (isTextClip(clip)) drawText(ctx, clip, alpha, st);
  else if (isShapeClip(clip)) drawShape(ctx, clip, alpha, st);
  else if (clip.type !== 'audio') {
    const asset = p.assets.find((a) => a.id === clip.assetId);
    if (!asset) return;
    const src = asset.kind === 'image' ? sources.image(asset) : sources.video?.(clip, asset);
    if (src) drawMedia(ctx, src, asset, p, alpha, st);
  }
}

/** Clips visuales activos en `t`, de abajo hacia arriba (orden de dibujo). */
export function visibleClipsAt(p: Project, t: number) {
  const out: Clip[] = [];
  for (let ti = p.tracks.length - 1; ti >= 0; ti--) {
    const track = p.tracks[ti];
    if (track.kind !== 'visual' || track.hidden) continue;
    for (const c of track.clips) if (c.type !== 'audio' && t >= c.start && t < clipEnd(c)) out.push(c);
  }
  return out;
}

/** Huella del aspecto de un clip en `t`: si no cambia entre fotogramas, la exportación reutiliza el fotograma anterior. */
export function clipLook(c: Clip, t: number) {
  const local = t - c.start;
  const st = animState(c, local);
  const r = (n: number) => Math.round(n * 100) / 100;
  return `${c.id}:${r(fadeFactor(c, local))}:${r(st.transform.x)},${r(st.transform.y)},${r(st.transform.scale * 100)},${r(st.transform.rotation)},${r(st.transform.opacity * 100)},${r(st.w)},${r(st.h)},${r(st.reveal * 1000)}`;
}

/** Caja (sin rotar) de un elemento visual en coordenadas del lienzo, para la selección en la vista previa. */
export function visualBox(ctx: Ctx, clip: Clip, project: Project, asset: Asset | undefined, local: number) {
  const st = animState(clip, local);
  const t = st.transform;
  let w = 0;
  let h = 0;
  if (isTextClip(clip)) {
    const L = layoutText(ctx, clip);
    w = L.boxW * t.scale;
    h = L.boxH * t.scale;
  } else if (isShapeClip(clip)) {
    w = st.w * t.scale;
    h = st.h * t.scale;
  } else if (asset) {
    ({ w, h } = fittedSize(asset.width, asset.height, project.width, project.height, t.scale));
  }
  return { cx: t.x, cy: t.y, w, h, rotation: t.rotation };
}

/** Carga las fuentes de todos los textos del proyecto (antes de rasterizar fuera de la vista previa). */
export async function loadFonts(p: Project) {
  const seen = new Set<string>();
  for (const tr of p.tracks)
    for (const c of tr.clips)
      if (isTextClip(c)) {
        const f = fontString(c.style);
        if (!seen.has(f)) {
          seen.add(f);
          await document.fonts.load(f).catch(() => {});
        }
      }
}

/** Carga (una vez) las imágenes del proyecto. */
const imageCache = new Map<string, Promise<HTMLImageElement | null>>();
export function loadImage(url: string) {
  let pr = imageCache.get(url);
  if (!pr) {
    pr = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    imageCache.set(url, pr);
  }
  return pr;
}

export async function imageSources(p: Project): Promise<LayerSources> {
  const map = new Map<string, HTMLImageElement | null>();
  for (const a of p.assets) if (a.kind === 'image') map.set(a.id, await loadImage(a.url));
  return { image: (a) => map.get(a.id) ?? null };
}

/**
 * Fotograma completo de las capas gráficas (textos, formas, imágenes) en `t`, sin videos.
 * Lo usa Claude para ver la composición en cualquier instante sin mover el cabezal del usuario.
 */
export async function renderGraphicsFrame(p: Project, t: number) {
  await loadFonts(p);
  const sources = await imageSources(p);
  const c = document.createElement('canvas');
  c.width = p.width;
  c.height = p.height;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = p.background;
  ctx.fillRect(0, 0, p.width, p.height);
  for (const clip of visibleClipsAt(p, t)) drawClipAt(ctx, clip, t, p, sources);
  return c;
}
