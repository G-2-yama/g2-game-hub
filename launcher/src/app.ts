/**
 * ランチャーの画面。データは本体（Rust）がデータリポジトリから取得・キャッシュしたものを受け取り、
 * サイトと同じ core の描画で表示する。ランチャー固有の表示は「このゲームで遊ぶ」と事前取得・設定画面に限る。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { eventGames, findEvent, findGame, parseContent, type Content, type GameEvent, type RawContent } from '../../core/content';
import { esc, renderEventPage, renderFooter, renderGamePage, renderHeader, renderHomePage, type RenderContext } from '../../core/render';

interface Settings { repo: string; event?: string | null; hasToken: boolean }
interface Loaded extends RawContent { syncError?: string | null }
interface GameStatus {
  state: 'none' | 'web' | 'missing' | 'outdated' | 'installed';
  installedVersion?: string;
  latestVersion?: string;
}

// 画像は本体のカスタムプロトコルで配信する（WindowsではこのURL形式になる）。
const contentBase = navigator.userAgent.includes('Windows') ? 'http://content.localhost/' : 'content://localhost/';

const ctx: RenderContext = {
  home: () => '#/',
  game: (slug, eventId) => (eventId ? `#/events/${eventId}/games/${slug}` : `#/games/${slug}`),
  event: (id) => (id === settings?.event ? '#/' : `#/events/${id}`),
  asset: (slug, src) => contentBase + ['games', slug, ...src.replace(/^\.?\//, '').split('/')].map(encodeURIComponent).join('/'),
  icon: '/icon.png',
};

const header = document.getElementById('header')!;
const main = document.getElementById('main')!;
const footer = document.getElementById('footer')!;

let settings: Settings | null = null;
let content: Content | null = null;
let syncError: string | null = null;
const progressHandlers = new Set<(id: string, message: string) => void>();

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function statusText({ state, installedVersion, latestVersion }: GameStatus) {
  switch (state) {
    case 'web': return 'Webゲーム（取得不要）';
    case 'missing': return `未取得（最新 v${latestVersion}）`;
    case 'outdated': return `更新あり（取得済み v${installedVersion} → 最新 v${latestVersion}）`;
    case 'installed': return `取得済み v${installedVersion}（最新）`;
    default: return '';
  }
}

const needsDownload = (status: GameStatus) => status.state === 'missing' || status.state === 'outdated';
const getStatus = (id: string) => invoke<GameStatus>('status', { id });

/** 本体からデータを受け取る。sync なら先にデータリポジトリから最新を取得する（失敗時は前回の取得分）。 */
async function loadContent(sync: boolean) {
  const loaded = await invoke<Loaded>('load_content', { sync });
  syncError = loaded.syncError ?? null;
  content = parseContent(loaded);
  for (const error of content.errors) console.warn(error);
}

/** ランチャーで表示するイベント。未選択（すべてのゲーム）なら undefined。 */
const currentEvent = () => (settings?.event && content ? findEvent(content, settings.event) : undefined);
const targetGames = () => {
  if (!content) return [];
  const event = currentEvent();
  return event ? eventGames(content, event).map(({ game }) => game) : content.games;
};

function renderChrome() {
  if (!content) return;
  const nav = '<a class="btn btn--text" href="#/downloads">事前取得</a><a class="btn btn--text" href="#/settings">設定</a>';
  header.innerHTML = renderHeader(content.site, ctx, nav);
  footer.innerHTML = renderFooter(content.site);
  document.title = content.site.name;
}

function playSection(id: string) {
  return `<section class="launcher-play" data-game-id="${esc(id)}" aria-labelledby="play-heading" hidden>
  <h2 id="play-heading">このゲームで遊ぶ</h2>
  <p class="launcher-play__version"></p>
  <div class="launcher-play__actions">
    <button type="button" class="btn btn--filled" data-action="play">このゲームで遊ぶ</button>
    <button type="button" class="btn btn--tonal" data-action="download" hidden>事前に取得</button>
  </div>
  <p class="launcher-play__status" role="status"></p>
</section>`;
}

function setupPlay(id: string) {
  const section = main.querySelector<HTMLElement>('.launcher-play')!;
  const play = section.querySelector<HTMLButtonElement>('[data-action="play"]')!;
  const download = section.querySelector<HTMLButtonElement>('[data-action="download"]')!;
  const version = section.querySelector('.launcher-play__version')!;
  const status = section.querySelector('.launcher-play__status')!;

  const refresh = async () => {
    const current = await getStatus(id);
    section.hidden = current.state === 'none';
    version.textContent = statusText(current);
    download.hidden = !needsDownload(current);
  };
  const run = async (button: HTMLButtonElement, action: () => Promise<unknown>) => {
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      status.textContent = `失敗しました: ${errorText(error)}`;
    } finally {
      button.disabled = false;
      await refresh();
    }
  };

  progressHandlers.add((gameId, message) => {
    if (gameId === id) status.textContent = message;
  });
  play.addEventListener('click', () => run(play, () => invoke('play', { id })));
  download.addEventListener('click', () => run(download, () => invoke('download', { id })));
  refresh();
}

function renderDownloads() {
  const games = targetGames();
  main.innerHTML = `<section class="launcher-panel section container" aria-labelledby="launcher-heading">
  <div class="launcher-panel__header">
    <h2 id="launcher-heading" class="headline">ゲームの事前取得</h2>
    <button type="button" class="btn btn--filled" data-action="download-all">すべて取得</button>
  </div>
  <p class="launcher-panel__status" role="status">${syncError ? `最新の情報を取得できなかったため、前回取得した情報を表示しています（${esc(syncError)}）` : ''}</p>
  <ul class="list launcher-panel__list">
    ${games.map((game) => `<li data-game-id="${esc(game.slug)}" hidden>
      <span class="launcher-panel__title">${esc(game.title)}</span>
      <span class="launcher-panel__version"></span>
      <button type="button" class="btn btn--tonal" data-action="download" hidden>取得</button>
    </li>`).join('')}
  </ul>
  <div class="launcher-play__actions" style="display: flex; margin-top: 16px">
    <button type="button" class="btn btn--text" data-action="sync">最新の情報に更新</button>
    <button type="button" class="btn btn--text" data-action="settings">設定</button>
  </div>
</section>`;

  const panel = main.querySelector<HTMLElement>('.launcher-panel')!;
  const status = panel.querySelector('.launcher-panel__status')!;
  const all = panel.querySelector<HTMLButtonElement>('[data-action="download-all"]')!;
  const rows = [...panel.querySelectorAll<HTMLElement>('li[data-game-id]')];

  const refresh = async () => {
    let pending = 0;
    await Promise.all(rows.map(async (row) => {
      const current = await getStatus(row.dataset.gameId!);
      row.hidden = current.state === 'none';
      row.querySelector('.launcher-panel__version')!.textContent = statusText(current);
      row.querySelector<HTMLElement>('[data-action="download"]')!.hidden = !needsDownload(current);
      if (needsDownload(current)) pending++;
    }));
    all.disabled = pending === 0;
  };

  progressHandlers.add((id, message) => {
    if (id === '*') {
      if (message) status.textContent = message;
      return;
    }
    const version = rows.find((row) => row.dataset.gameId === id)?.querySelector('.launcher-panel__version');
    if (version && message) version.textContent = message;
  });

  all.addEventListener('click', async () => {
    all.disabled = true;
    try {
      const { total, failed } = await invoke<{ total: number; failed: string[] }>('download_all', { ids: rows.map((row) => row.dataset.gameId!) });
      status.textContent = failed.length
        ? `${total}件中${failed.length}件の取得に失敗しました: ${failed.join(' / ')}`
        : `${total}件を取得しました。`;
    } catch (error) {
      status.textContent = `失敗しました: ${errorText(error)}`;
    }
    await refresh();
  });

  for (const row of rows) {
    const button = row.querySelector<HTMLButtonElement>('[data-action="download"]')!;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await invoke('download', { id: row.dataset.gameId! });
      } catch (error) {
        status.textContent = `${row.querySelector('.launcher-panel__title')!.textContent}: ${errorText(error)}`;
      }
      button.disabled = false;
      await refresh();
    });
  }

  panel.querySelector('[data-action="sync"]')!.addEventListener('click', async (event) => {
    (event.currentTarget as HTMLButtonElement).disabled = true;
    status.textContent = '取得中…';
    try {
      await loadContent(true);
    } catch (error) {
      syncError = errorText(error);
    }
    renderChrome();
    render();
    if (!syncError) main.querySelector('.launcher-panel__status')!.textContent = '最新の情報を取得しました。';
  });
  panel.querySelector('[data-action="settings"]')!.addEventListener('click', () => { location.hash = '#/settings'; });

  refresh();
}

const formatSize = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)}GB` : `${(bytes / 1024 ** 2).toFixed(1)}MB`);

/**
 * 設定画面（#/settings。Ctrl+Shift+M でも開く）。データリポジトリ・トークン・表示するイベントと、
 * 取得済みゲームのキャッシュを管理する。未設定のときは接続の欄だけを表示する。
 */
function renderSettings() {
  progressHandlers.clear();
  if (!content) {
    header.innerHTML = '';
    footer.innerHTML = '';
  }
  const eventOptions = () => '<option value="">すべてのゲーム</option>'
    + (content?.events ?? []).map((event) => `<option value="${esc(event.id)}">${esc(event.name)}</option>`).join('');
  main.innerHTML = `<div class="section container launcher-setup">
  <h1 class="headline">ランチャーの設定</h1>
  <section aria-labelledby="connection-heading">
    <h2 id="connection-heading">データリポジトリとトークン</h2>
    <p>配布担当者から伝えられたデータリポジトリとトークン（Fine-grained personal access token）を入力してください。トークンはこのPCの資格情報ストアに保存されます。</p>
    ${settings ? `<p>トークン: ${settings.hasToken ? '保存済み' : '未保存'}（トークンを変えるときは新しいトークンを入力して「接続」。空欄なら保存済みのトークンで接続）</p>` : ''}
    <label for="repo">データリポジトリ（owner/name）</label>
    <input id="repo" placeholder="example-org/game-data" value="${esc(settings?.repo ?? '')}" autocomplete="off" />
    <label for="token">トークン</label>
    <input id="token" type="password" placeholder="github_pat_..." autocomplete="off" />
    <div class="launcher-play__actions">
      <button type="button" class="btn btn--filled" data-action="connect">接続</button>
      ${settings?.hasToken ? '<button type="button" class="btn btn--tonal" data-action="delete-token">トークンを削除</button>' : ''}
    </div>
    <p class="launcher-play__status" role="status" data-status="connection"></p>
  </section>
  <section aria-labelledby="event-heading" data-section="event" ${content ? '' : 'hidden'}>
    <h2 id="event-heading">表示するイベント</h2>
    <select id="event">${eventOptions()}</select>
    <div class="launcher-play__actions">
      <button type="button" class="btn btn--filled" data-action="save">保存して開始</button>
    </div>
  </section>
  <section aria-labelledby="cache-heading" data-section="cache" ${settings ? '' : 'hidden'}>
    <h2 id="cache-heading">取得済みのゲーム</h2>
    <ul class="list launcher-panel__list" data-list="cache"></ul>
    <div class="launcher-play__actions">
      <button type="button" class="btn btn--tonal" data-action="remove-all">すべて削除</button>
      <button type="button" class="btn btn--text" data-action="open-dir">フォルダを開く</button>
    </div>
    <p class="launcher-play__status" role="status" data-status="cache"></p>
  </section>
</div>`;

  const connectionStatus = main.querySelector('[data-status="connection"]')!;
  const cacheStatus = main.querySelector('[data-status="cache"]')!;
  const repo = main.querySelector<HTMLInputElement>('#repo')!;
  const token = main.querySelector<HTMLInputElement>('#token')!;
  const eventSection = main.querySelector<HTMLElement>('[data-section="event"]')!;
  const select = main.querySelector<HTMLSelectElement>('#event')!;
  const connect = main.querySelector<HTMLButtonElement>('[data-action="connect"]')!;
  const cacheList = main.querySelector<HTMLElement>('[data-list="cache"]')!;
  select.value = settings?.event ?? content?.events[0]?.id ?? '';

  const onConnect = async () => {
    connect.disabled = true;
    connectionStatus.textContent = '接続中…';
    try {
      await invoke('connect', { repo: repo.value.trim(), token: token.value.trim() });
      token.value = '';
      settings = await invoke<Settings | null>('get_settings');
      await loadContent(false);
      select.innerHTML = eventOptions();
      select.value = settings?.event ?? content!.events[0]?.id ?? '';
      eventSection.hidden = false;
      connectionStatus.textContent = `接続しました（ゲーム ${content!.games.length} 件、イベント ${content!.events.length} 件）。表示するイベントを選んでください。`;
    } catch (error) {
      connectionStatus.textContent = `接続できません: ${errorText(error)}`;
    }
    connect.disabled = false;
  };
  connect.addEventListener('click', onConnect);
  token.addEventListener('keydown', (event) => { if (event.key === 'Enter') onConnect(); });

  main.querySelector('[data-action="delete-token"]')?.addEventListener('click', async () => {
    if (!confirm('このPCに保存したトークンを削除します。取得済みのゲームは削除しません。よろしいですか？')) return;
    try {
      await invoke('delete_token');
      settings = await invoke<Settings | null>('get_settings');
      renderSettings();
      main.querySelector('[data-status="connection"]')!.textContent = 'トークンを削除しました。';
    } catch (error) {
      connectionStatus.textContent = `削除できません: ${errorText(error)}`;
    }
  });

  main.querySelector('[data-action="save"]')!.addEventListener('click', async () => {
    await invoke('select_event', { event: select.value || null });
    location.hash = '#/';
    await start();
  });

  const titleOf = (id: string) => (content && findGame(content, id)?.title) || id;
  const refreshCache = async () => {
    const games = await invoke<{ id: string; version?: string | null; size: number }[]>('installed_games');
    const total = games.reduce((sum, game) => sum + game.size, 0);
    cacheList.innerHTML = games.length
      ? games.map((game) => `<li data-game-id="${esc(game.id)}">
      <span class="launcher-panel__title">${esc(titleOf(game.id))}</span>
      <span class="launcher-panel__version">${game.version ? `v${esc(game.version)}` : '展開途中'} / ${formatSize(game.size)}</span>
      <button type="button" class="btn btn--tonal" data-action="remove">削除</button>
    </li>`).join('')
      : '<li>取得済みのゲームはありません。</li>';
    main.querySelector<HTMLButtonElement>('[data-action="remove-all"]')!.disabled = games.length === 0;
    if (games.length) cacheStatus.textContent = `合計 ${formatSize(total)}`;
    for (const row of cacheList.querySelectorAll<HTMLElement>('li[data-game-id]')) {
      row.querySelector('[data-action="remove"]')!.addEventListener('click', async () => {
        try {
          await invoke('remove_game', { id: row.dataset.gameId! });
        } catch (error) {
          cacheStatus.textContent = `${titleOf(row.dataset.gameId!)}: ${errorText(error)}`;
          return;
        }
        await refreshCache();
      });
    }
  };
  main.querySelector('[data-action="remove-all"]')!.addEventListener('click', async () => {
    if (!confirm('取得済みのゲームをすべて削除します。遊ぶ前に再度取得が必要になります。よろしいですか？')) return;
    const failed: string[] = [];
    for (const game of await invoke<{ id: string }[]>('installed_games')) {
      try {
        await invoke('remove_game', { id: game.id });
      } catch (error) {
        failed.push(`${titleOf(game.id)}: ${errorText(error)}`);
      }
    }
    await refreshCache();
    if (failed.length) cacheStatus.textContent = `削除できなかったゲームがあります: ${failed.join(' / ')}`;
  });
  main.querySelector('[data-action="open-dir"]')!.addEventListener('click', () => invoke('open_data_dir'));
  if (settings) refreshCache();
}

/** 現在のURL（#/...）に応じて画面を描画する。 */
function render() {
  const [path, anchor] = location.hash.slice(1).split('#');
  const parts = (path || '/').split('/').filter(Boolean);
  if (parts[0] === 'settings' || !settings || !content) return renderSettings();
  progressHandlers.clear();
  let gameId: string | undefined;

  if (parts[0] === 'downloads') {
    renderDownloads();
  } else if (parts[0] === 'games' && parts[1] && findGame(content, parts[1])) {
    gameId = parts[1];
    main.innerHTML = renderGamePage(findGame(content, gameId)!, ctx, { asideTop: playSection(gameId) });
  } else if (parts[0] === 'events' && parts[1] && findEvent(content, parts[1])) {
    const event = findEvent(content, parts[1])!;
    if (parts[2] === 'games' && parts[3] && findGame(content, parts[3])) {
      gameId = parts[3];
      main.innerHTML = renderGamePage(findGame(content, gameId)!, ctx, { event, asideTop: playSection(gameId) });
    } else {
      main.innerHTML = renderEventPage(content, event, ctx);
    }
  } else {
    const event: GameEvent | undefined = currentEvent();
    main.innerHTML = event ? renderEventPage(content, event, ctx) : renderHomePage(content, ctx);
  }

  if (gameId) setupPlay(gameId);
  if (anchor) document.getElementById(anchor)?.scrollIntoView();
  else window.scrollTo(0, 0);
}

async function start() {
  settings = await invoke<Settings | null>('get_settings');
  if (!settings) return renderSettings();
  try {
    await loadContent(true);
  } catch (error) {
    main.innerHTML = `<p class="section container">データを読み込めません: ${esc(errorText(error))}</p>`;
    return;
  }
  renderChrome();
  render();
}

// 外部リンクは既定のブラウザで開く。
document.addEventListener('click', (event) => {
  // 画面内のリンク（#/...）も href プロパティでは http(s) の絶対URLになるため、属性の値で判定する。
  const url = (event.target as Element).closest?.('a')?.getAttribute('href') ?? '';
  if (/^https?:\/\//.test(url)) {
    event.preventDefault();
    invoke('open_external', { url });
  }
});
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'm') {
    event.preventDefault();
    location.hash = '#/settings';
  }
});
window.addEventListener('hashchange', render);
listen<[string, string]>('launcher:progress', ({ payload: [id, message] }) => {
  for (const handler of progressHandlers) handler(id, message);
});

start();
