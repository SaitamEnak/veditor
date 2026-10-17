import type { Asset, Project, TextClip, TextStyle } from '../../shared/types';
import { fittedSize } from '../../shared/types';
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
  const textW = Math.max(1, ...widths);
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
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

/** Dibuja un clip de texto/subtítulo. Lo usan la vista previa y la exportación (WYSIWYG). */
export function drawText(ctx: Ctx, clip: TextClip, alpha = 1) {
  const s = clip.style;
  const t = clip.transform;
  const L = layoutText(ctx, clip);
  ctx.save();
  ctx.globalAlpha = t.opacity * alpha;
  ctx.translate(t.x, t.y);
  ctx.rotate((t.rotation * Math.PI) / 180);
  ctx.scale(t.scale, t.scale);

  if (s.backgroundOpacity > 0) {
    ctx.fillStyle = hexToRgba(s.background, s.backgroundOpacity);
    roundRect(ctx, -L.boxW / 2, -L.boxH / 2, L.boxW, L.boxH, s.radius);
    ctx.fill();
  }

  ctx.textBaseline = 'middle';
  ctx.textAlign = s.align;
  const ax = s.align === 'left' ? -L.boxW / 2 + s.padding : s.align === 'right' ? L.boxW / 2 - s.padding : 0;
  const y0 = -L.boxH / 2 + s.padding + L.lineH / 2;

  L.lines.forEach((line, i) => {
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
      ctx.strokeText(line, ax, y);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = s.color;
    ctx.fillText(line, ax, y);
    ctx.shadowColor = 'transparent';
  });
  ctx.restore();
}

/** Caja (sin rotar) de un elemento visual en coordenadas del lienzo, para la selección en la vista previa. */
export function visualBox(
  ctx: Ctx,
  clip: TextClip | { type: 'video' | 'image'; transform: TextClip['transform'] },
  project: Project,
  asset?: Asset,
) {
  const t = clip.transform;
  let w = 0;
  let h = 0;
  if (clip.type === 'text' || clip.type === 'subtitle') {
    const L = layoutText(ctx, clip as TextClip);
    w = L.boxW * t.scale;
    h = L.boxH * t.scale;
  } else if (asset) {
    ({ w, h } = fittedSize(asset.width, asset.height, project.width, project.height, t.scale));
  }
  return { cx: t.x, cy: t.y, w, h, rotation: t.rotation };
}

/** PNG transparente a tamaño completo del lienzo, para que FFmpeg superponga el texto tal cual se ve. */
export async function renderTextPng(clip: TextClip, project: Project): Promise<string> {
  await document.fonts.load(fontString(clip.style));
  const c = document.createElement('canvas');
  c.width = Math.round(project.width / 2) * 2;
  c.height = Math.round(project.height / 2) * 2;
  const ctx = c.getContext('2d')!;
  drawText(ctx, clip);
  return c.toDataURL('image/png');
}
