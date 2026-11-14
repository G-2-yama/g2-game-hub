/**
 * データリポジトリをビルド時に読み込む。場所は環境変数 CONTENT_DIR（既定はこのリポジトリと同じ階層の g2-game-data）。
 * 配布情報（distribution.json）は読まない。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseContent, type RawContent } from '../../core/content';
import type { RenderContext } from '../../core/render';

export const contentDir = path.resolve(process.env.CONTENT_DIR ?? '../g2-game-data');

function readRaw(): RawContent {
  if (!existsSync(contentDir)) throw new Error(`データリポジトリが見つかりません: ${contentDir}（環境変数 CONTENT_DIR で指定してください）`);
  const read = (...parts: string[]) => readFileSync(path.join(contentDir, ...parts), 'utf8');
  const list = (dir: string) => (existsSync(path.join(contentDir, dir)) ? readdirSync(path.join(contentDir, dir)) : []);
  return {
    site: existsSync(path.join(contentDir, 'site.yml')) ? read('site.yml') : undefined,
    events: Object.fromEntries(list('events').filter((f) => f.endsWith('.md')).map((f) => [f.slice(0, -3), read('events', f)])),
    games: Object.fromEntries(list('games').filter((d) => existsSync(path.join(contentDir, 'games', d, 'index.md'))).map((d) => [d, read('games', d, 'index.md')])),
  };
}

export const content = parseContent(readRaw());
if (content.errors.length > 0) throw new Error(`データに誤りがあります:\n${content.errors.join('\n')}`);

/** GitHub Pagesのサブパスも考慮して内部リンクのURLを作る。 */
export function withBase(p = '/') {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}/${p.replace(/^\/+/, '')}`;
}

export const ctx: RenderContext = {
  home: () => withBase('/'),
  game: (slug, eventId) => withBase(eventId ? `/events/${eventId}/games/${slug}/` : `/games/${slug}/`),
  event: (id) => withBase(`/events/${id}/`),
  asset: (slug, src) => withBase(`/content/games/${slug}/${src.replace(/^\.?\//, '')}`),
  icon: withBase('/icon.png'),
};
