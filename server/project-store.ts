import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import { type Project, createEmptyProject } from '../shared/types.ts';

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Nombre de carpeta válido en Windows/macOS/Linux a partir del nombre del proyecto. */
export function folderName(name: string) {
  const clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return clean.slice(0, 80) || 'Proyecto';
}

export interface ProjectInfo {
  folder: string;
  id: string;
  name: string;
  updatedAt: string;
  clips: number;
  assets: number;
  active: boolean;
}

/**
 * Cada proyecto es una carpeta autocontenida en data/projects/<carpeta>/ con su project.json,
 * sus archivos fuente (media/), caché y exportaciones. El proyecto abierto se recuerda en data/active.json.
 *
 * El JSON del proyecto abierto se vigila: si Claude lo edita, el cambio se difunde por SSE.
 */
export class ProjectStore {
  project!: Project;
  folder = '';
  version = 1;
  private lastWritten = '';
  private clients = new Set<Response>();
  readonly root: string;

  constructor(private data: string) {
    this.root = path.join(data, 'projects');
    fs.mkdirSync(this.root, { recursive: true });
    let active = '';
    try {
      active = JSON.parse(fs.readFileSync(path.join(data, 'active.json'), 'utf8')).folder;
    } catch {}
    const folders = this.folders();
    if (!active || !folders.includes(active)) active = folders[0] ?? this.create('Proyecto sin título');
    this.open(active);
    // Renombrados de carpeta pendientes (por archivos bloqueados o porque Claude cambió el nombre en el JSON)
    setInterval(() => this.syncFolder(), 4000).unref();
  }

  // ---- Rutas del proyecto abierto ----
  get dir() {
    return path.join(this.root, this.folder);
  }
  get mediaDir() {
    return path.join(this.dir, 'media');
  }
  get cacheDir() {
    return path.join(this.dir, 'cache');
  }
  get exportsDir() {
    return path.join(this.dir, 'exports');
  }
  get sessionFile() {
    return path.join(this.dir, 'session.json');
  }
  private get file() {
    return path.join(this.dir, 'project.json');
  }

  folders() {
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(this.root, d.name, 'project.json')))
      .map((d) => d.name);
  }

  list(): ProjectInfo[] {
    return this.folders()
      .map((folder) => {
        const file = path.join(this.root, folder, 'project.json');
        try {
          const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Project;
          return {
            folder,
            id: p.id,
            name: p.name,
            updatedAt: fs.statSync(file).mtime.toISOString(),
            clips: p.tracks.reduce((n, t) => n + t.clips.length, 0),
            assets: p.assets.length,
            active: folder === this.folder,
          };
        } catch {
          return null;
        }
      })
      .filter((x): x is ProjectInfo => !!x)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private uniqueFolder(name: string, except?: string) {
    const base = folderName(name);
    const taken = new Set(this.folders().map((f) => f.toLowerCase()));
    if (except) taken.delete(except.toLowerCase());
    let f = base;
    for (let i = 2; taken.has(f.toLowerCase()); i++) f = `${base} (${i})`;
    return f;
  }

  /** Crea la carpeta de un proyecto vacío y devuelve su nombre de carpeta. */
  create(name: string): string {
    const folder = this.uniqueFolder(name);
    const dir = path.join(this.root, folder);
    for (const d of ['media', 'cache', 'exports']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    const p = { ...createEmptyProject(), id: uid(), name };
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(p, null, 2));
    return folder;
  }

  open(folder: string) {
    if (!this.folders().includes(folder)) throw new Error(`No existe el proyecto "${folder}"`);
    if (this.folder) fs.unwatchFile(this.file);
    this.folder = folder;
    for (const d of [this.mediaDir, this.cacheDir, this.exportsDir]) fs.mkdirSync(d, { recursive: true });
    this.project = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!this.project.id || this.project.id === 'default') this.project.id = uid();
    this.write();
    this.watch();
    fs.writeFileSync(path.join(this.data, 'active.json'), JSON.stringify({ folder }, null, 2));
    this.version++;
    console.log(`[project] abierto "${folder}"`);
    this.broadcast('project', { version: this.version, project: this.project, clientId: 'server' });
    this.broadcast('projects', { folder });
  }

  /** Cambia el nombre del proyecto abierto. El nombre se guarda siempre; la carpeta se renombra en cuanto se pueda. */
  rename(name: string) {
    this.project = { ...this.project, name };
    this.write();
    this.version++;
    this.broadcast('project', { version: this.version, project: this.project, clientId: 'server' });
    if (this.syncFolder()) return;
    // Carpeta bloqueada (normalmente el navegador descargando un video): se le pide que suelte los medios
    // y se reintenta rápido unos segundos. Si aun así no se puede, sigue el reintento periódico.
    this.broadcast('release-media', {});
    let tries = 0;
    const retry = setInterval(() => {
      if (this.syncFolder() || ++tries >= 20) clearInterval(retry);
    }, 250);
  }

  /**
   * Hace que la carpeta se llame como el proyecto. En Windows falla (EPERM) mientras haya archivos abiertos
   * dentro (p. ej. el navegador reproduciendo un video), así que se reintenta periódicamente.
   */
  syncFolder() {
    const target = this.uniqueFolder(this.project.name, this.folder);
    if (target === this.folder) return true;
    fs.unwatchFile(this.file);
    try {
      fs.renameSync(this.dir, path.join(this.root, target));
      console.log(`[project] carpeta renombrada: "${this.folder}" -> "${target}"`);
      this.folder = target;
      fs.writeFileSync(path.join(this.data, 'active.json'), JSON.stringify({ folder: target }, null, 2));
      this.broadcast('projects', { folder: target });
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') console.warn('[project] no se pudo renombrar la carpeta:', (e as Error).message);
      return false;
    } finally {
      this.watch();
    }
  }

  /** Copia la carpeta completa (incluidos los archivos fuente), sin las exportaciones. */
  duplicate(folder: string) {
    const src = path.join(this.root, folder);
    const p = JSON.parse(fs.readFileSync(path.join(src, 'project.json'), 'utf8')) as Project;
    const name = `${p.name} (copia)`;
    const target = this.uniqueFolder(name);
    const dst = path.join(this.root, target);
    fs.cpSync(src, dst, { recursive: true, filter: (f) => !f.startsWith(path.join(src, 'exports') + path.sep) });
    fs.mkdirSync(path.join(dst, 'exports'), { recursive: true });
    fs.rmSync(path.join(dst, 'session.json'), { force: true });
    fs.writeFileSync(path.join(dst, 'project.json'), JSON.stringify({ ...p, id: uid(), name }, null, 2));
    return target;
  }

  /** "Borrar" mueve la carpeta a data/papelera (no se elimina nada). */
  trash(folder: string) {
    if (folder === this.folder) throw new Error('No se puede borrar el proyecto abierto');
    const bin = path.join(this.data, 'papelera');
    fs.mkdirSync(bin, { recursive: true });
    fs.renameSync(path.join(this.root, folder), path.join(bin, `${folder} - ${new Date().toISOString().replace(/[:.]/g, '-')}`));
  }

  private watch() {
    fs.watchFile(this.file, { interval: 400 }, () => this.onFileChange());
  }

  private write() {
    this.lastWritten = JSON.stringify(this.project, null, 2);
    fs.writeFileSync(this.file, this.lastWritten);
  }

  private onFileChange() {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    if (raw === this.lastWritten) return;
    try {
      const p = JSON.parse(raw) as Project;
      if (!Array.isArray(p.tracks) || !Array.isArray(p.assets)) throw new Error('estructura inválida');
      this.project = p;
      this.lastWritten = raw;
      this.version++;
      console.log(`[project] cambio de Claude en "${this.folder}" -> v${this.version}`);
      this.broadcast('project', { version: this.version, project: p, clientId: 'claude' });
    } catch (e) {
      console.warn('[project] JSON externo inválido, se ignora:', (e as Error).message);
    }
  }

  /** Guarda cambios del editor. Rechaza los que pertenecen a otro proyecto (p. ej. tras cambiar de proyecto). */
  update(project: Project, clientId: string) {
    if (project.id !== this.project.id) return null;
    this.project = project;
    this.version++;
    this.write();
    this.broadcast('project', { version: this.version, project, clientId });
    return this.version;
  }

  subscribe(res: Response) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': hola\n\n');
    this.clients.add(res);
    this.send(res, 'project', { version: this.version, project: this.project, clientId: 'server' });
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    res.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  private send(res: Response, event: string, data: unknown) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(event: string, data: unknown) {
    for (const res of this.clients) this.send(res, event, data);
  }
}

/**
 * Migración desde la versión de un solo proyecto (data/project.json + data/media|cache|exports).
 * Los archivos usados pasan a la carpeta del proyecto; los no usados, a data/papelera/sin-usar.
 */
export function migrateLegacy(data: string) {
  const legacy = path.join(data, 'project.json');
  if (!fs.existsSync(legacy)) return;
  const p = JSON.parse(fs.readFileSync(legacy, 'utf8')) as Project;
  fs.mkdirSync(path.join(data, 'papelera'), { recursive: true });
  fs.copyFileSync(legacy, path.join(data, 'papelera', 'project-antes-de-migrar.json'));
  const root = path.join(data, 'projects');
  fs.mkdirSync(root, { recursive: true });
  let folder = folderName(p.name);
  for (let i = 2; fs.existsSync(path.join(root, folder)); i++) folder = `${folderName(p.name)} (${i})`;
  const dir = path.join(root, folder);
  const unused = path.join(data, 'papelera', 'sin-usar');
  for (const d of ['media', 'cache', 'exports']) fs.mkdirSync(path.join(dir, d), { recursive: true });

  const used = new Set(p.assets.map((a) => a.id));
  const isUsed = (file: string) => used.has(file.split('.')[0]);
  const move = (from: string, to: string) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  };
  for (const sub of ['media', 'cache']) {
    const src = path.join(data, sub);
    if (!fs.existsSync(src)) continue;
    for (const f of fs.readdirSync(src)) move(path.join(src, f), path.join(isUsed(f) ? path.join(dir, sub) : path.join(unused, sub), f));
    fs.rmdirSync(src);
  }
  const ex = path.join(data, 'exports');
  if (fs.existsSync(ex)) {
    for (const f of fs.readdirSync(ex)) move(path.join(ex, f), path.join(dir, 'exports', f));
    fs.rmdirSync(ex);
  }
  if (!p.id || p.id === 'default') p.id = uid();
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(p, null, 2));
  fs.rmSync(legacy);
  const session = path.join(data, 'session.json');
  if (fs.existsSync(session)) move(session, path.join(dir, 'session.json'));
  fs.writeFileSync(path.join(data, 'active.json'), JSON.stringify({ folder }, null, 2));
  console.log(`[migración] proyecto movido a data/projects/${folder}`);
}
