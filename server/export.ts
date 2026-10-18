import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  type AnimProp, type Easing, type ExportJob, type ExportOptions, type MediaClip, type Project, type VolumeKey,
  animValue, clipEnd, fittedSize, isMediaClip, planLayers, projectDuration,
} from '../shared/types.ts';
import { FFMPEG } from './ffmpeg.ts';

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const num = (n: number) => (Math.round(n * 1000) / 1000).toString();
const hex = (c: string) => '0x' + c.replace('#', '').slice(0, 6).padEnd(6, '0');

/**
 * Curva de volumen -> expresión de FFmpeg en tiempo local del clip (t=0 al inicio del clip).
 * Suma de tramos lineales en lugar de if() anidados, para no superar el límite de anidamiento del evaluador.
 */
export function envelopeExpr(keys: VolumeKey[], inPoint: number) {
  const k = keys.map((key) => ({ t: key.t - inPoint, v: key.v }));
  const parts = [`lt(t,${num(k[0].t)})*${num(k[0].v)}`];
  for (let i = 1; i < k.length; i++) {
    const a = k[i - 1];
    const b = k[i];
    const span = Math.max(0.001, b.t - a.t);
    parts.push(`gte(t,${num(a.t)})*lt(t,${num(b.t)})*(${num(a.v)}+${num(b.v - a.v)}*(t-${num(a.t)})/${num(span)})`);
  }
  const last = k[k.length - 1];
  parts.push(`gte(t,${num(last.t)})*${num(last.v)}`);
  return parts.join('+');
}

/** Curva de easing como expresión de FFmpeg en función de P (0..1). Debe coincidir con easeFn de shared/types. */
function easeExpr(e: Easing | undefined, P: string) {
  switch (e ?? 'inOut') {
    case 'linear':
      return P;
    case 'in':
      return `pow(${P},3)`;
    case 'out':
      return `(1-pow(1-${P},3))`;
    case 'back':
      return `(1+2.70158*pow(${P}-1,3)+1.70158*pow(${P}-1,2))`;
    default:
      return `if(lt(${P},0.5),4*pow(${P},3),1-pow(2-2*${P},3)/2)`;
  }
}

/** Propiedad animada -> expresión de FFmpeg en tiempo de la línea de tiempo (suma de tramos, sin anidar). */
function animExpr(clip: MediaClip, prop: AnimProp) {
  const keys = (clip.keyframes ?? []).filter((k) => k[prop] !== undefined);
  if (keys.length < 2) return num(animValue(clip, prop, 0));
  const parts = [num(keys[0][prop]!)];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    const P = `clip((t-${num(clip.start + a.t)})/${num(Math.max(0.001, b.t - a.t))},0,1)`;
    parts.push(`(${num(b[prop]! - a[prop]!)})*${easeExpr(b.ease, P)}`);
  }
  return parts.join('+');
}

interface BuildInput {
  project: Project;
  mediaDir: string;
  /** Índice del tramo gráfico (en planLayers) -> carpeta con su secuencia de PNG (00000.png, 00001.png…) */
  gfx: Record<number, string>;
  /** false = sólo video (para renderizar fotogramas sueltos) */
  audio?: boolean;
}

/**
 * Traduce el proyecto a un comando de FFmpeg con un filter_complex:
 * fondo de color -> overlays apilados (de la pista inferior a la superior) + mezcla de audio.
 */
export function buildFfmpegGraph({ project, mediaDir, gfx, audio = true }: BuildInput) {
  const W = even(project.width);
  const H = even(project.height);
  const fps = project.fps;
  const total = Math.max(0.1, projectDuration(project));
  const assets = new Map(project.assets.map((a) => [a.id, a]));

  const inputs: string[] = [];
  const graph: string[] = [];
  const audioLabels: string[] = [];
  let inputCount = 0;
  const addInput = (args: string[]) => {
    inputs.push(...args);
    return inputCount++;
  };

  graph.push(`color=c=${hex(project.background)}:s=${W}x${H}:r=${fps}:d=${num(total)},format=yuv420p[base]`);
  let last = 'base';
  let layer = 0;

  // Capas visuales, de abajo hacia arriba: videos con FFmpeg, tramos gráficos como secuencias del navegador
  let gfxIndex = 0;
  for (const item of planLayers(project)) {
    const label = `v${layer++}`;
    let src: string;
    let start: number;
    let end: number;
    let x = '0';
    let y = '0';
    if (item.kind === 'gfx') {
      const dir = gfx[gfxIndex++];
      if (!dir) continue;
      start = item.k0 / fps;
      end = item.k1 / fps;
      const idx = addInput(['-framerate', String(fps), '-start_number', '0', '-i', path.join(dir, '%05d.png')]);
      src = `[${idx}:v]format=rgba,setpts=PTS-STARTPTS+${num(start)}/TB`;
    } else {
      const { clip, track } = item;
      const asset = assets.get(clip.assetId);
      if (!asset) continue;
      start = clip.start;
      end = clipEnd(clip);
      const dur = clip.duration;
      const idx = addInput(['-ss', num(clip.in), '-t', num(dur), '-i', path.join(mediaDir, asset.file)]);
      if (audio && asset.hasAudio && !clip.audioDetached && !track.muted && clip.volume > 0) audioLabels.push(audioChain(graph, idx, clip, start));
      // Escala, rotación y opacidad de un video no se animan al exportar (se usa su valor al inicio); la posición sí
      const scale = animValue(clip, 'scale', 0);
      const rotation = animValue(clip, 'rotation', 0);
      const opacity = animValue(clip, 'opacity', 0);
      const { w, h } = fittedSize(asset.width, asset.height, project.width, project.height, scale);
      const chain = [`scale=${even(w)}:${even(h)}`, 'format=rgba'];
      if (rotation % 360 !== 0) {
        const rad = num((rotation * Math.PI) / 180);
        chain.push(`rotate=${rad}:ow=rotw(${rad}):oh=roth(${rad}):c=none`);
      }
      if (opacity < 1) chain.push(`colorchannelmixer=aa=${num(opacity)}`);
      if (clip.fadeIn > 0) chain.push(`fade=t=in:st=0:d=${num(clip.fadeIn)}:alpha=1`);
      if (clip.fadeOut > 0) chain.push(`fade=t=out:st=${num(Math.max(0, dur - clip.fadeOut))}:d=${num(clip.fadeOut)}:alpha=1`);
      src = `[${idx}:v]setpts=PTS-STARTPTS,${chain.join(',')},setpts=PTS+${num(start)}/TB`;
      x = `'${animExpr(clip, 'x')}-overlay_w/2'`;
      y = `'${animExpr(clip, 'y')}-overlay_h/2'`;
    }
    graph.push(`${src}[${label}]`);
    const out = `o${layer}`;
    graph.push(`[${last}][${label}]overlay=x=${x}:y=${y}:eval=frame:eof_action=pass:enable='between(t,${num(start)},${num(end)})'[${out}]`);
    last = out;
  }
  graph.push(`[${last}]format=yuv420p[vout]`);

  if (!audio) return { inputs, graph: graph.join(';\n'), total, fps };

  // Pistas de audio
  for (const track of project.tracks) {
    if (track.kind !== 'audio' || track.muted) continue;
    for (const clip of track.clips) {
      if (!isMediaClip(clip) || clip.volume <= 0) continue;
      const asset = assets.get(clip.assetId);
      if (!asset || !asset.hasAudio) continue;
      const idx = addInput(['-ss', num(clip.in), '-t', num(clip.duration), '-i', path.join(mediaDir, asset.file)]);
      audioLabels.push(audioChain(graph, idx, clip, clip.start));
    }
  }

  if (audioLabels.length === 0) {
    const idx = addInput(['-f', 'lavfi', '-t', num(total), '-i', 'anullsrc=r=48000:cl=stereo']);
    graph.push(`[${idx}:a]anull[aout]`);
  } else if (audioLabels.length === 1) {
    graph.push(`[${audioLabels[0]}]apad=whole_dur=${num(total)}[aout]`);
  } else {
    graph.push(`${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:normalize=0:dropout_transition=0,apad=whole_dur=${num(total)}[aout]`);
  }

  return { inputs, graph: graph.join(';\n'), total, fps };

  function audioChain(g: string[], idx: number, clip: MediaClip, start: number) {
    const label = `a${idx}`;
    const parts = [
      'aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo', 'asetpts=PTS-STARTPTS', `volume=${num(clip.volume)}`,
    ];
    if (clip.volumeKeys?.length) parts.push(`volume='${envelopeExpr(clip.volumeKeys, clip.in)}':eval=frame`);
    if (clip.fadeIn > 0) parts.push(`afade=t=in:st=0:d=${num(clip.fadeIn)}`);
    if (clip.fadeOut > 0) parts.push(`afade=t=out:st=${num(Math.max(0, clip.duration - clip.fadeOut))}:d=${num(clip.fadeOut)}`);
    const ms = Math.round(start * 1000);
    if (ms > 0) parts.push(`adelay=delays=${ms}:all=1`);
    g.push(`[${idx}:a]${parts.join(',')}[${label}]`);
    return label;
  }
}

const jobs = new Map<string, ExportJob>();
export const getJob = (id: string) => jobs.get(id);

export function startExport(opts: {
  id: string;
  project: Project;
  mediaDir: string;
  jobDir: string;
  gfx: Record<number, string>;
  options: ExportOptions;
}): ExportJob {
  const { inputs, graph, total, fps } = buildFfmpegGraph(opts);
  const graphFile = path.join(opts.jobDir, 'graph.txt');
  fs.writeFileSync(graphFile, graph);
  const outFile = path.join(opts.jobDir, 'output.mp4');
  const args = [
    '-y', '-hide_banner', '-nostats', '-progress', 'pipe:1',
    ...inputs,
    '-filter_complex_script', graphFile,
    '-map', '[vout]', '-map', '[aout]',
    '-t', num(total), '-r', String(fps),
    '-c:v', 'libx264', '-preset', opts.options.preset, '-crf', String(opts.options.crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
    outFile,
  ];
  fs.writeFileSync(path.join(opts.jobDir, 'command.txt'), [FFMPEG, ...args].map((a) => JSON.stringify(a)).join(' '));

  const job: ExportJob = { id: opts.id, status: 'running', progress: 0 };
  jobs.set(job.id, job);

  const p = spawn(FFMPEG, args, { windowsHide: true });
  let stderr = '';
  p.stdout.on('data', (d) => {
    const m = [...d.toString().matchAll(/out_time_us=(\d+)/g)].pop();
    if (m) job.progress = Math.min(0.99, parseInt(m[1], 10) / 1e6 / total);
  });
  p.stderr.on('data', (d) => {
    stderr = (stderr + d.toString()).slice(-20_000);
  });
  p.on('error', (e) => {
    job.status = 'error';
    job.error = e.message;
  });
  p.on('close', (code) => {
    fs.writeFileSync(path.join(opts.jobDir, 'ffmpeg.log'), stderr);
    if (code === 0) {
      job.status = 'done';
      job.progress = 1;
      job.url = `/api/export/${job.id}/download`;
    } else {
      job.status = 'error';
      job.error = stderr.split('\n').filter(Boolean).slice(-8).join('\n');
    }
  });
  return job;
}
