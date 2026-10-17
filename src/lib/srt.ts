export interface Cue {
  start: number;
  end: number;
  text: string;
}

const toSec = (ts: string) => {
  const m = ts.trim().replace(',', '.').match(/(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?/);
  if (!m) return 0;
  return (+(m[1] ?? 0)) * 3600 + +m[2] * 60 + +m[3] + (m[4] ? +`0.${m[4]}` : 0);
};

/** Parser tolerante para SRT y WebVTT. */
export function parseSubtitles(src: string): Cue[] {
  const blocks = src.replace(/\r/g, '').replace(/^WEBVTT[^\n]*\n/, '').split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->');
    const text = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (text) cues.push({ start: toSec(a), end: toSec(z.split(' ').filter(Boolean)[0]), text });
  }
  return cues;
}

const fmt = (t: number) => {
  const ms = Math.round(t * 1000);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

export const toSrt = (cues: Cue[]) =>
  cues.map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`).join('\n');
