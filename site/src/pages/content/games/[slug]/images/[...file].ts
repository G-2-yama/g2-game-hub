// データリポジトリの games/<slug>/images/ 以下だけを配信する（distribution.json などは出力しない）。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { APIRoute } from 'astro';
import { content, contentDir } from '../../../../../content';

export function getStaticPaths() {
  return content.games.flatMap(({ slug }) => {
    const dir = path.join(contentDir, 'games', slug, 'images');
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({ params: { slug, file: path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/') } }));
  });
}

export const GET: APIRoute = ({ params }) =>
  new Response(readFileSync(path.join(contentDir, 'games', params.slug!, 'images', params.file!)));
