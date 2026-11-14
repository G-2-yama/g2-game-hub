/**
 * データリポジトリ（site.yml / events/*.md / games/<slug>/index.md）の読み込みと検証。
 * サイトはビルド時に、ランチャーは実行時に同じ処理を使う。
 * distribution.json（配布情報）はランチャー本体（Rust）だけが読み、ここでは扱わない。
 */
import { parse as parseYaml } from 'yaml';
import { youtubeUrl } from './youtube';

export const accents = ['cyan', 'pink', 'orange', 'violet', 'lime'] as const;
export type Accent = (typeof accents)[number];

export interface Link { label: string; url: string }

export interface SiteConfig {
  groupName: string;
  name: string;
  intro: string;
  links: Link[];
}

export interface Game {
  slug: string;
  title: string;
  summary: string;
  genre?: string;
  cover?: string;
  video?: string;
  screenshots: string[];
  accent: Accent;
  order: number;
  play?: { playTimeMinutes?: number; players?: string; controls: string[]; notes?: string };
  development?: { engine?: string; languages: string[]; period?: string; team?: string; notes?: string };
  links: Link[];
  body: string;
}

export interface EventGame { slug: string; note?: string }

export interface GameEvent {
  id: string;
  name: string;
  summary?: string;
  games: EventGame[];
  body: string;
}

/** ファイルの中身（テキスト）。キーは events は id、games は slug。 */
export interface RawContent {
  site?: string;
  events: Record<string, string>;
  games: Record<string, string>;
}

export interface Content {
  site: SiteConfig;
  games: Game[];
  events: GameEvent[];
  /** 読み込めなかったファイルの理由。サイトのビルドではエラーにし、ランチャーではその項目を除いて表示する。 */
  errors: string[];
}

export const slugPattern = /^[a-z0-9][a-z0-9-]*$/;

type Data = Record<string, unknown>;

class ContentError extends Error {}

function fail(message: string): never {
  throw new ContentError(message);
}

function splitFrontmatter(text: string) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) fail('先頭に --- で囲んだ設定（frontmatter）がありません');
  return { data: (parseYaml(match[1]) ?? {}) as Data, body: match[2] };
}

function asObject(value: unknown, key: string): Data | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) fail(`${key} の形式が正しくありません`);
  return value as Data;
}

function text(data: Data, key: string, required: true): string;
function text(data: Data, key: string, required?: false): string | undefined;
function text(data: Data, key: string, required = false) {
  const value = data[key];
  if (value === undefined || value === null || value === '') {
    if (required) fail(`${key} がありません`);
    return undefined;
  }
  if (typeof value !== 'string') fail(`${key} は文字列で書いてください`);
  return value;
}

function texts(data: Data, key: string) {
  const value = data[key] ?? [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) fail(`${key} は文字列の配列で書いてください`);
  return value as string[];
}

function integer(data: Data, key: string, min: number) {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < min) fail(`${key} は${min}以上の整数で書いてください`);
  return value as number;
}

function links(data: Data) {
  const value = data.links ?? [];
  if (!Array.isArray(value)) fail('links は配列で書いてください');
  return value.map((item, i) => {
    const link = asObject(item, `links[${i}]`) ?? {};
    const url = text(link, 'url', true);
    if (!/^https?:\/\//.test(url)) fail(`links[${i}].url は http(s) のURLを指定してください`);
    return { label: text(link, 'label', true), url };
  });
}

/** 値が空のオブジェクトなら undefined にして、表示側で欄ごと省略できるようにする。 */
function compact<T extends object>(value: T) {
  return Object.values(value).some((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined)) ? value : undefined;
}

function parseSite(source = ''): SiteConfig {
  const data = asObject(parseYaml(source), 'site.yml') ?? {};
  return {
    groupName: text(data, 'groupName') ?? '',
    name: text(data, 'name', true),
    intro: text(data, 'intro') ?? '',
    links: links(data),
  };
}

function parseGame(slug: string, source: string): Game {
  const { data, body } = splitFrontmatter(source);
  const video = text(data, 'video');
  if (video && !youtubeUrl.test(video)) fail('video はYouTubeのURLを指定してください');
  const accent = text(data, 'accent') ?? 'cyan';
  if (!accents.includes(accent as Accent)) fail(`accent は ${accents.join(' / ')} のいずれかを指定してください`);
  const play = asObject(data.play, 'play');
  const development = asObject(data.development, 'development');
  return {
    slug,
    title: text(data, 'title', true),
    summary: text(data, 'summary') ?? '',
    genre: text(data, 'genre'),
    cover: text(data, 'cover'),
    video,
    screenshots: texts(data, 'screenshots'),
    accent: accent as Accent,
    order: integer(data, 'order', Number.MIN_SAFE_INTEGER) ?? 999,
    play: play && compact({
      playTimeMinutes: integer(play, 'playTimeMinutes', 1),
      players: text(play, 'players'),
      controls: texts(play, 'controls'),
      notes: text(play, 'notes'),
    }),
    development: development && compact({
      engine: text(development, 'engine'),
      languages: texts(development, 'languages'),
      period: text(development, 'period'),
      team: text(development, 'team'),
      notes: text(development, 'notes'),
    }),
    links: links(data),
    body,
  };
}

function parseEvent(id: string, source: string, games: Set<string>): GameEvent {
  const { data, body } = splitFrontmatter(source);
  const list = data.games ?? [];
  if (!Array.isArray(list)) fail('games は配列で書いてください');
  return {
    id,
    name: text(data, 'name', true),
    summary: text(data, 'summary'),
    games: list.map((item, i) => {
      const entry = typeof item === 'string' ? { slug: item } : asObject(item, `games[${i}]`) ?? {};
      const slug = text(entry, 'slug', true);
      if (!games.has(slug)) fail(`games[${i}] の「${slug}」は games/ にありません`);
      return { slug, note: text(entry, 'note') };
    }),
    body,
  };
}

function attempt<T>(file: string, errors: string[], parse: () => T): T | undefined {
  try {
    return parse();
  } catch (error) {
    if (!(error instanceof ContentError) && !(error instanceof Error && error.name === 'YAMLParseError')) throw error;
    errors.push(`${file}: ${error.message}`);
    return undefined;
  }
}

export function parseContent(raw: RawContent): Content {
  const errors: string[] = [];
  const site = attempt('site.yml', errors, () => parseSite(raw.site))
    ?? { groupName: '', name: 'ゲーム一覧', intro: '', links: [] };

  const games: Game[] = [];
  for (const [slug, source] of Object.entries(raw.games)) {
    const file = `games/${slug}/index.md`;
    if (!slugPattern.test(slug)) {
      errors.push(`${file}: フォルダ名は英小文字・数字・ハイフンにしてください`);
      continue;
    }
    const game = attempt(file, errors, () => parseGame(slug, source));
    if (game) games.push(game);
  }
  games.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'ja'));

  const slugs = new Set(games.map((game) => game.slug));
  const events: GameEvent[] = [];
  for (const [id, source] of Object.entries(raw.events)) {
    const event = attempt(`events/${id}.md`, errors, () => parseEvent(id, source, slugs));
    if (event) events.push(event);
  }
  // 新しいイベントを先に表示する（ファイル名を「年-名前」にしておくと新しい順になる）。
  events.sort((a, b) => b.id.localeCompare(a.id));

  return { site, games, events, errors };
}

export function findGame(content: Content, slug: string) {
  return content.games.find((game) => game.slug === slug);
}

export function findEvent(content: Content, id: string) {
  return content.events.find((event) => event.id === id);
}

/** イベントの出展ゲーム（並び順はイベントに書いた順）。 */
export function eventGames(content: Content, event: GameEvent) {
  return event.games.flatMap((entry) => {
    const game = findGame(content, entry.slug);
    return game ? [{ game, note: entry.note }] : [];
  });
}
