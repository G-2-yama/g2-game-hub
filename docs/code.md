---
type: Reference
title: コードの構造
description: ファイルの役割、core の関数、Rust のコマンド、開発の手順と変更の約束。
tags: [code, development]
status: draft
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-15T23:00:00+09:00 }
---

# コードの構造

## ディレクトリ

```text
core/                    サイトとランチャーで共通
  content.ts             データの読み込み・検証（parseContent など）
  render.ts              画面のHTMLを作る関数
  styles.css             見た目
  youtube.ts             YouTubeのURLの判定、クリックで埋め込みを読み込む処理
site/                    紹介サイト（Astro、静的出力）
  src/content.ts         CONTENT_DIR からデータを読む。エラーがあればビルドを失敗させる
  src/pages/             各ページ（URLは下表）
launcher/                ランチャー
  src/app.ts             画面（ハッシュでの画面遷移、遊ぶ・事前取得・設定）
  src/pages/index.astro  画面の入れ物
  src-tauri/src/lib.rs   本体（取得・キャッシュ・ダウンロード・起動・トークン）
  src-tauri/tauri.conf.json  ウィンドウ、CSP、インストーラーの設定（日本語、アイコンは icons/installer.ico）
examples/                distribution.json の例（架空の値）
.github/workflows/       deploy.yml（サイト公開）、release.yml（インストーラー）
```

## core

| 関数 | 役割 |
|---|---|
| `parseContent(raw)` | site.yml・各md を読み、`{ site, games, events, errors }` を返す |
| `findGame` / `findEvent` / `eventGames` | slug・id での検索、イベントの出展ゲーム |
| `renderHomePage` / `renderEventPage` / `renderGamePage` | 各ページの本文 |
| `renderHeader` / `renderFooter` | ヘッダー（サイトではイベントのメニューつき）・フッター |
| `renderMarkdown` | 本文の描画（改行はそのまま改行、生のHTMLは無効、リンクは http(s) のみ） |

動画は最初はサムネイル（cover があればそれ、なければ YouTube のもの）だけを出し、クリックされたら `enableYoutubeFacade()` が埋め込みに置き換えます（埋め込みの読み込みが重く、開いた直後に画面が操作できなくなるため）。サイトとランチャーの両方で呼びます。

URL の作り方はサイトとランチャーで異なるため、`RenderContext`（`home`・`game`・`event`・`asset`・`icon`）で渡します。値はすべて `esc` でエスケープします。

## サイトのURL

| URL | 内容 |
|---|---|
| `/` | 全ゲームとイベントの一覧 |
| `/games/<slug>/` | ゲームの詳細 |
| `/events/<id>/` | イベントの出展ゲーム |
| `/events/<id>/games/<slug>/` | イベントの補足つきの詳細 |
| `/content/games/<slug>/images/...` | 画像（`images/` 以下だけを出力） |

## ランチャー

画面（`app.ts`）の画面遷移：`#/`、`#/games/<slug>`、`#/events/<id>`、`#/events/<id>/games/<slug>`、`#/downloads`、`#/settings`。

本体（`lib.rs`）のコマンド：

| コマンド | 役割 |
|---|---|
| `get_settings` / `connect` / `select_event` / `delete_token` | 設定とトークン（トークンは keyring に保存） |
| `unlock` / `lock` / `set_password` | 設定画面のパスワード（ハッシュを settings.json に保存）。施錠中は設定を変えるコマンドを拒否し、リポジトリ名を返さない |
| `load_content` | dataのzipballを取得し、変わったファイルだけ書き換えて読み込む（失敗時は前回の分）。一括の削除・置き換えはウイルス対策ソフトに誤検出されるため行わない |
| `status` / `download` / `download_all` | ゲームの取得状況と取得（SHA-256検証・展開・旧版の削除） |
| `play` | 起動（未取得なら取得してから） |
| `installed_games` / `remove_game` / `open_data_dir` | キャッシュの管理（起動中・取得中は削除しない） |
| `open_external` | 外部リンクをOSのブラウザで開く |

画像は独自のプロトコル `content://`（Windowsでは `http://content.localhost`）で配信し、`games/<slug>/images/` 以下だけを返します。

## 開発

必要なもの：Node.js（`.nvmrc`）、npm。ランチャーはさらに Rust と [Tauri の前提ソフト](https://tauri.app/start/prerequisites/)。

```bash
npm ci --ignore-scripts
npm run dev              # サイト（データは CONTENT_DIR、既定は ../g2-game-data）
npm run build            # site/dist に出力
npm run launcher         # ランチャー（開発用）
npm run launcher:build   # インストーラーを作成
```

## 変更するときの約束

- 見た目は `core/` で変える。サイトとランチャーに複製しない。
- データの形式を変えたら、`core/content.ts` とdataの `docs/` を合わせて直す。
- 依存はバージョンを固定し、`package-lock.json`・`Cargo.lock` をレビューしてコミットする。npm はライフサイクルスクリプトを無効にしてインストールする。
- このリポジトリは公開なので、data のリポジトリ名・トークン・非公開のゲーム情報を書かない。
