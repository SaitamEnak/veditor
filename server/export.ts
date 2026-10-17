import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  type ExportJob, type ExportOptions, type MediaClip, type Project, type VolumeKey, clipEnd, fittedSize, isMediaClip, isTextClip, projectDuration,
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

interface BuildInput {
  project: Project;
  mediaDir: string;
  /** clipId -> PNG a tamaño completo del lienzo con el texto ya dibujado */
  textRenders: Record<string, string>;
  /** false = sólo video (para renderizar fotogramas sueltos) */
  audio?: boolean;
}

/**
 * Traduce el proyecto a un comando de FFmpeg con un filter_complex:
 * fondo de color -> overlays apilados (de la pista inferior a la superior) + mezcla de audio.
 */
export function buildFfmpegGraph({ project, mediaDir, textRenders, audio = true }: BuildInput) {
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

  // Capas visuales: de abajo hacia arriba
  const visualTracks = [...project.tracks].reverse().filter((t) => t.kind === 'visual' && !t.hidden);
  for (const track of visualTracks) {
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      const start = clip.start;
      const end = clipEnd(clip);
      const dur = clip.duration;
      const fades: string[] = [];
      if (clip.fadeIn > 0) fades.push(`fade=t=in:st=0:d=${num(clip.fadeIn)}:alpha=1`);
      if (clip.fadeOut > 0) fades.push(`fade=t=out:st=${num(Math.max(0, dur - clip.fadeOut))}:d=${num(clip.fadeOut)}:alpha=1`);
      const label = `v${layer++}`;
      let chain: string[];
      let x = '0';
      let y = '0';
      let idx: number;

      if (isTextClip(clip)) {
        const png = textRenders[clip.id];
        if (!png) continue;
        idx = addInput(['-loop', '1', '-framerate', String(fps), '-t', num(dur), '-i', png]);
        chain = ['format=rgba', ...fades];
      } else {
        const asset = assets.get(clip.assetId);
        if (!asset || asset.kind === 'audio') continue;
        const file = path.join(mediaDir, asset.file);
        if (asset.kind === 'image') {
          idx = addInput(['-loop', '1', '-framerate', String(fps), '-t', num(dur), '-i', file]);
        } else {
          idx = addInput(['-ss', num(clip.in), '-t', num(dur), '-i', file]);
          if (audio && asset.hasAudio && !clip.audioDetached && !track.muted && clip.volume > 0) audioLabels.push(audioChain(graph, idx, clip, start));
        }
        const { w, h } = fittedSize(asset.width, asset.height, project.width, project.height, clip.transform.scale);
        const t = clip.transform;
        chain = [`scale=${even(w)}:${even(h)}`, 'format=rgba'];
        if (t.rotation % 360 !== 0) {
          const rad = num((t.rotation * Math.PI) / 180);
          chain.push(`rotate=${rad}:ow=rotw(${rad}):oh=roth(${rad}):c=none`);
        }
        if (t.opacity < 1) chain.push(`colorchannelmixer=aa=${num(t.opacity)}`);
        chain.push(...fades);
        x = `${num(t.x)}-overlay_w/2`;
        y = `${num(t.y)}-overlay_h/2`;
      }

      graph.push(`[${idx}:v]setpts=PTS-STARTPTS,${chain.join(',')},setpts=PTS+${num(start)}/TB[${label}]`);
      const out = `o${layer}`;
      graph.push(`[${last}][${label}]overlay=x=${x}:y=${y}:eof_action=pass:enable='between(t,${num(start)},${num(end)})'[${out}]`);
      last = out;
    }
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
  textRenders: Record<string, string>;
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
