/**
 * Herramientas de Claude para colaborar en el proyecto.
 *
 *   pnpm claude state            Resumen del proyecto + qué está mirando el usuario (cabezal, selección)
 *   pnpm claude frame [t]        Renderiza con FFmpeg el fotograma en t (por defecto, el cabezal) -> data/claude/frame.png
 *                                (sin textos: esos los dibuja el navegador; para verlos usa "snapshot")
 *   pnpm claude snapshot         Captura exacta de la vista previa del navegador -> data/claude/view.png
 *
 *   pnpm claude projects         Lista los proyectos (data/projects/<carpeta>) e indica el abierto
 *
 * Para editar, Claude modifica data/projects/<abierto>/project.json (la ruta la imprime "state");
 * el editor lo recibe en vivo y se puede deshacer con Ctrl+Z.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Clip, Project } from '../shared/types.ts';
import { clipEnd, isMediaClip, projectDuration } from '../shared/types.ts';
import { buildFfmpegGraph } from '../server/export.ts';
import { FFMPEG, run } from '../server/ffmpeg.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'claude');
fs.mkdirSync(OUT, { recursive: true });
const API = process.env.VEDITOR_API ?? 'http://localhost:3001';

const activeFolder = (): string => JSON.parse(fs.readFileSync(path.join(DATA, 'active.json'), 'utf8')).folder;
const projectDir = () => path.join(DATA, 'projects', activeFolder());
const project = (): Project => JSON.parse(fs.readFileSync(path.join(projectDir(), 'project.json'), 'utf8'));
const session = (): { playhead: number; selectedId: string | null; selectedIds?: string[]; playing: boolean; updatedAt: string } | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectDir(), 'session.json'), 'utf8'));
  } catch {
    return null;
  }
};
const f = (n: number) => n.toFixed(2);

function describe(c: Clip, p: Project) {
  const base = `${c.id}  ${c.type.padEnd(8)} ${f(c.start)}→${f(clipEnd(c))}s`;
  if (isMediaClip(c)) {
    const a = p.assets.find((x) => x.id === c.assetId);
    const extra = [
      `in=${f(c.in)}`,
      `vol=${Math.round(c.volume * 100)}%`,
      c.volumeKeys?.length ? `nodos=${c.volumeKeys.length}` : '',
      c.audioDetached ? 'audio-separado' : '',
      c.type !== 'audio' ? `pos=${Math.round(c.transform.x)},${Math.round(c.transform.y)} esc=${Math.round(c.transform.scale * 100)}%` : '',
    ].filter(Boolean);
    return `${base}  "${a?.name ?? '?'}"  ${extra.join(' ')}`;
  }
  return `${base}  "${c.text.replace(/\n/g, ' / ').slice(0, 60)}"`;
}

function state() {
  const p = project();
  const s = session();
  console.log(`Proyecto: ${p.name} · ${p.width}x${p.height} @${p.fps}fps · duración ${f(projectDuration(p))}s`);
  console.log(`Archivo:  ${path.join(projectDir(), 'project.json')}`);
  if (s) {
    const all = p.tracks.flatMap((t) => t.clips);
    const ids = s.selectedIds ?? (s.selectedId ? [s.selectedId] : []);
    const sel = ids.map((id) => all.find((c) => c.id === id)).filter((c): c is Clip => !!c);
    console.log(`Usuario: cabezal=${f(s.playhead)}s ${s.playing ? '(reproduciendo)' : ''} · ${s.updatedAt}`);
    console.log(sel.length ? `Selección (${sel.length}):\n${sel.map((c) => `  ${c.id === s.selectedId ? '*' : ' '} ${describe(c, p)}`).join('\n')}` : 'Selección: ninguna');
  }
  console.log('\nAssets:');
  for (const a of p.assets) console.log(`  ${a.id}  ${a.kind.padEnd(5)} ${f(a.duration)}s ${a.width}x${a.height} audio=${a.hasAudio}  "${a.name}"`);
  console.log('\nPistas (de arriba a abajo):');
  p.tracks.forEach((t, i) => {
    const flags = [t.hidden && 'oculta', t.muted && 'muda', t.locked && 'bloqueada'].filter(Boolean).join(',');
    console.log(`  [${i}] ${t.id} ${t.kind} "${t.name}" ${flags}`);
    for (const c of [...t.clips].sort((a, b) => a.start - b.start)) console.log(`      ${describe(c, p)}`);
  });
}

async function frame(tArg?: string) {
  const p = project();
  const t = tArg !== undefined ? parseFloat(tArg) : session()?.playhead ?? 0;
  // Subproyecto con sólo los clips activos en t, desplazados para que t sea el instante 0
  const sub: Project = structuredClone(p);
  for (const tr of sub.tracks) {
    tr.clips = tr.clips
      .filter((c) => t >= c.start && t < clipEnd(c))
      .map((c) => {
        const d = t - c.start;
        const fade = { fadeIn: c.fadeIn > d ? c.fadeIn : 0, fadeOut: 0 };
        return isMediaClip(c) ? { ...c, ...fade, start: 0, in: c.in + d, duration: 0.5 } : { ...c, ...fade, start: 0, duration: 0.5 };
      });
  }
  const { inputs, graph } = buildFfmpegGraph({ project: sub, mediaDir: path.join(projectDir(), 'media'), textRenders: {}, audio: false });
  const graphFile = path.join(OUT, 'frame-graph.txt');
  fs.writeFileSync(graphFile, graph);
  const out = path.join(OUT, 'frame.png');
  await run(FFMPEG, ['-y', '-v', 'error', ...inputs, '-filter_complex_script', graphFile, '-map', '[vout]', '-frames:v', '1', out]);
  console.log(`Fotograma t=${f(t)}s -> ${out}`);
}

async function snapshot() {
  const r = await fetch(`${API}/api/snapshot`, { method: 'POST' });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  console.log(`Vista previa (cabezal ${f(j.playhead)}s) -> ${j.file}`);
}

function projects() {
  const active = activeFolder();
  for (const folder of fs.readdirSync(path.join(DATA, 'projects'))) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(DATA, 'projects', folder, 'project.json'), 'utf8')) as Project;
      console.log(`${folder === active ? '*' : ' '} ${folder}  ("${p.name}", ${p.assets.length} archivos)`);
    } catch {}
  }
}

const [cmd, ...args] = process.argv.slice(2);
const cmds: Record<string, (...a: string[]) => unknown> = { state, frame, snapshot, projects };
if (!cmd || !cmds[cmd]) {
  console.log('Uso: pnpm claude <state | frame [t] | snapshot | projects>');
  process.exit(1);
}
Promise.resolve(cmds[cmd](...args)).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
