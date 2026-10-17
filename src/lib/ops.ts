import type { Clip, Track } from '../../shared/types';
import { clipEnd } from '../../shared/types';
import type { Project } from '../../shared/types';

export const MIN_CLIP = 0.1;

export function findClip(p: Project, id: string | null) {
  if (!id) return null;
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === id);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}

export const trackAccepts = (track: Track, type: Clip['type']) =>
  track.kind === 'audio' ? type === 'audio' : type !== 'audio';

export function isFree(track: Track, start: number, dur: number, ignoreId?: string) {
  return track.clips.every((c) => c.id === ignoreId || clipEnd(c) <= start + 1e-6 || c.start >= start + dur - 1e-6);
}

/** Posición libre más cercana a `start` en la pista donde cabe un clip de duración `dur`. */
export function nearestFreeStart(track: Track, start: number, dur: number, ignoreId?: string) {
  const others = track.clips.filter((c) => c.id !== ignoreId).sort((a, b) => a.start - b.start);
  const gaps: [number, number][] = [];
  let cur = 0;
  for (const c of others) {
    if (c.start > cur) gaps.push([cur, c.start]);
    cur = Math.max(cur, clipEnd(c));
  }
  gaps.push([cur, Infinity]);
  let best = cur;
  let bestD = Infinity;
  for (const [a, b] of gaps) {
    if (b - a < dur - 1e-6) continue;
    const s = Math.min(Math.max(start, a), b - dur);
    const d = Math.abs(s - start);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return Math.max(0, best);
}

/** Límites de los vecinos de un clip dentro de su pista. */
export function neighbours(track: Track, clip: Clip) {
  let prevEnd = 0;
  let nextStart = Infinity;
  for (const c of track.clips) {
    if (c.id === clip.id) continue;
    if (clipEnd(c) <= clip.start + 1e-6) prevEnd = Math.max(prevEnd, clipEnd(c));
    else if (c.start >= clipEnd(clip) - 1e-6) nextStart = Math.min(nextStart, c.start);
  }
  return { prevEnd, nextStart };
}
