/**
 * サイトとランチャーで共通の画面。どちらでも同じ見た目になるよう、HTML文字列を返す。
 * 値はすべて esc でエスケープする。Markdown本文は renderMarkdown で生のHTMLを無効にしてから描画する。
 */
import { Marked } from 'marked';
import type { Content, Game, GameEvent, SiteConfig } from './content';
import { eventGames } from './content';
import { youtubeUrl } from './youtube';

/** リンク先と画像のURLの作り方。サイトとランチャーで異なる。 */
export interface RenderContext {
  home(): string;
  game(slug: string, eventId?: string): string;
  event(id: string): string;
  /** games/<slug>/ からの相対パスで書かれた画像のURL。 */
  asset(slug: string, path: string): string;
  icon: string;
}

const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => escapes[c]);

const isExternal = (url: string) => /^https?:\/\//.test(url);
const imageUrl = (ctx: RenderContext, slug: string, src: string) => (isExternal(src) ? src : ctx.asset(slug, src));
const externalLink = (url: string, label: string, className: string) =>
  `<a class="${className}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;

/** Markdown本文。生のHTMLは文字として表示し、リンクは http(s)・ページ内リンク、画像は相対パスか https のみ許可する。 */
export function renderMarkdown(source: string, ctx: RenderContext, slug?: string) {
  const marked = new Marked({
    gfm: true,
    renderer: {
      html: ({ text }) => esc(text),
      link({ href, title, tokens }) {
        const label = this.parser.parseInline(tokens);
        if (!isExternal(href) && !href.startsWith('#')) return label;
        const external = isExternal(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
        return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}${external}>${label}</a>`;
      },
      image({ href, text }) {
        if (/^[a-z]+:/i.test(href) && !href.startsWith('https://')) return esc(text);
        if (!slug && !isExternal(href)) return esc(text);
        return `<img src="${esc(slug ? imageUrl(ctx, slug, href) : href)}" alt="${esc(text)}" loading="lazy" />`;
      },
    },
  });
  return marked.parse(source, { async: false });
}

export function renderHeader(site: SiteConfig, ctx: RenderContext, extraNav = '') {
  const link = site.links[0];
  return `<a class="skip-link" href="#main">本文へ移動</a>
<header class="top-app-bar">
  <div class="container">
    <a class="top-app-bar__title" href="${esc(ctx.home())}" aria-label="${esc(site.name)}"><img src="${esc(ctx.icon)}" alt="" width="40" height="40" />お品書き</a>
    <nav aria-label="メインナビゲーション">${extraNav}${link ? externalLink(link.url, link.label, 'btn btn--text') : ''}</nav>
  </div>
</header>`;
}

export function renderFooter(site: SiteConfig) {
  return `<footer class="site-footer">
  <div class="container">© ${new Date().getFullYear()} ${esc(site.groupName)}</div>
</footer>`;
}

function renderCard(game: Game, href: string, ctx: RenderContext) {
  const { slug, title, summary, genre, cover, accent } = game;
  return `<a class="card tone-${accent}" href="${esc(href)}">
  <div class="card__media">${cover ? `<img src="${esc(imageUrl(ctx, slug, cover))}" alt="" loading="lazy" />` : `<span aria-hidden="true">${esc(title)}</span>`}</div>
  <div class="card__body">
    <h3>${esc(title)}</h3>
    ${genre ? `<p class="card__meta">${esc(genre)}</p>` : ''}
    ${summary ? `<p>${esc(summary)}</p>` : ''}
  </div>
</a>`;
}

function renderGameGrid(games: Game[], ctx: RenderContext, eventId?: string) {
  return games.length > 0
    ? `<div class="card-grid">${games.map((game) => renderCard(game, ctx.game(game.slug, eventId), ctx)).join('')}</div>`
    : '<p class="body-large">公開中の作品はまだありません。</p>';
}

/** 全ゲームとイベントの一覧（サイトのトップページ）。 */
export function renderHomePage(content: Content, ctx: RenderContext) {
  const { site, games, events } = content;
  return `<section class="hero container">
  <h1 class="hero__title">${esc(site.name)}</h1>
  ${site.intro ? `<p class="body-large">${esc(site.intro)}</p>` : ''}
</section>
${events.length > 0 ? `<section class="section container" aria-labelledby="events-heading">
  <h2 id="events-heading" class="headline">イベント</h2>
  <ul class="list event-list">${events.map((event) => `<li><a href="${esc(ctx.event(event.id))}">${esc(event.name)}</a></li>`).join('')}</ul>
</section>` : ''}
<section id="games" class="section container" aria-labelledby="games-heading">
  <h2 id="games-heading" class="headline">ゲーム</h2>
  ${renderGameGrid(games, ctx)}
</section>`;
}

/** イベントの出展ゲーム一覧。 */
export function renderEventPage(content: Content, event: GameEvent, ctx: RenderContext) {
  return `<section class="hero container">
  <h1 class="hero__title">${esc(event.name)}</h1>
  ${event.summary ? `<p class="body-large">${esc(event.summary)}</p>` : ''}
  ${event.body.trim() ? `<div class="prose">${renderMarkdown(event.body, ctx)}</div>` : ''}
</section>
<section id="games" class="section container" aria-labelledby="games-heading">
  <h2 id="games-heading" class="headline">出展ゲーム</h2>
  ${renderGameGrid(eventGames(content, event).map(({ game }) => game), ctx, event.id)}
</section>`;
}

export interface GamePageOptions {
  /** イベントから開いた場合はそのイベント。展示・試遊情報にイベントの補足を加える。 */
  event?: GameEvent;
  /** aside の先頭に入れるHTML（ランチャーの「このゲームで遊ぶ」）。 */
  asideTop?: string;
}

/** ゲームの詳細ページ。 */
export function renderGamePage(game: Game, ctx: RenderContext, { event, asideTop = '' }: GamePageOptions = {}) {
  const { slug, title, summary, genre, cover, video, screenshots, accent, play, development, links } = game;
  const youtubeId = video?.match(youtubeUrl)?.[1];
  const note = event?.games.find((entry) => entry.slug === slug)?.note;
  const back = event ? ctx.event(event.id) : ctx.home();

  const media = youtubeId
    ? `<iframe src="https://www.youtube-nocookie.com/embed/${esc(youtubeId)}" title="${esc(title)}の動画" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`
    : cover ? `<img src="${esc(imageUrl(ctx, slug, cover))}" alt="${esc(title)}のキービジュアル" />` : `<span aria-hidden="true">${esc(title)}</span>`;

  const row = (label: string, value: string | undefined, className = '') =>
    value ? `<div><dt>${label}</dt><dd${className ? ` class="${className}"` : ''}>${value}</dd></div>` : '';
  const playRows = [
    row('プレイ時間の目安', play?.playTimeMinutes ? `約${play.playTimeMinutes}分` : undefined),
    row('プレイ人数', play?.players && esc(play.players)),
    row('操作方法', play?.controls.length ? `<ul>${play.controls.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : undefined),
    row('補足', play?.notes && esc(play.notes), 'preserve-newlines'),
    row('このイベントでの補足', note && esc(note), 'preserve-newlines'),
  ].join('');
  const developmentRows = [
    row('ゲームエンジン', development?.engine && esc(development.engine)),
    row('実装言語', development?.languages.length ? esc(development.languages.join(' / ')) : undefined),
    row('開発期間', development?.period && esc(development.period)),
    row('開発人数', development?.team && esc(development.team)),
    row('補足', development?.notes && esc(development.notes), 'preserve-newlines'),
  ].join('');

  return `<div class="container section">
  <a href="${esc(back)}#games" class="btn btn--text">← ゲーム一覧</a>
  <div class="detail-media tone-${accent}">${media}</div>
  <div class="detail-layout">
    <div>
      ${genre ? `<span class="chip">${esc(genre)}</span>` : ''}
      <h1 class="display" style="margin-top: 16px">${esc(title)}</h1>
      ${summary ? `<p class="body-large">${esc(summary)}</p>` : ''}
      <div class="prose">${renderMarkdown(game.body, ctx, slug)}</div>
      ${screenshots.length > 0 ? `<section aria-labelledby="screenshots-heading">
        <h2 id="screenshots-heading" class="headline" style="margin-top: 24px">スクリーンショット</h2>
        <div class="screenshots">${screenshots.map((src, i) => `<img src="${esc(imageUrl(ctx, slug, src))}" alt="${esc(title)}のスクリーンショット ${i + 1}" loading="lazy" />`).join('')}</div>
      </section>` : ''}
    </div>
    <aside>
      ${asideTop}
      ${playRows ? `<section aria-labelledby="event-heading">
        <h2 id="event-heading">${event ? '展示・試遊情報' : 'プレイ情報'}</h2>
        <dl class="list">${playRows}</dl>
      </section>` : ''}
      ${developmentRows ? `<section aria-labelledby="development-heading">
        <h2 id="development-heading">開発情報</h2>
        <dl class="list">${developmentRows}</dl>
      </section>` : ''}
      ${links.length > 0 ? `<section aria-labelledby="links-heading">
        <h2 id="links-heading">関連リンク</h2>
        <div class="link-list">${links.map((link) => externalLink(link.url, link.label, 'btn btn--tonal')).join('')}</div>
      </section>` : ''}
    </aside>
  </div>
</div>`;
}
