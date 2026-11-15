---
type: Architecture
title: 仕組み
description: サイトとランチャーの構成、データの流れ、認証の考え方。
tags: [architecture, auth]
status: draft
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-15T23:30:00+09:00 }
---

# 仕組み

## 全体像

```text
 g2-game-data（private）                    g2-game-hub（public）
 ┌──────────────────────────┐              ┌───────────────────────────┐
 │ site.yml                 │  ビルド時に取得 │ site/  紹介サイト（Astro） │──▶ GitHub Pages
 │ games/<slug>/index.md    │─────────────▶│                           │
 │ games/<slug>/images/     │  Deploy key   │ core/  共通の読み込み・画面 │
 │ games/<slug>/distribution.json           │                           │
 │ events/<id>.md           │  起動時に取得  │ launcher/ ランチャー(Tauri)│──▶ 試遊PC
 │ Releases（試遊用zip）     │─────────────▶│                           │
 └──────────────────────────┘  PAT          └───────────────────────────┘
```

- **ゲームは一か所に一度だけ書く**（`games/<slug>/`）。イベントは出展するゲームの slug を並べるだけ。
- **コードは公開、データは非公開**。販売中のゲームがあるため、データとゲーム本体はhubに含めない。
- **画面は共通**。`core/` がHTMLを作り、サイトとランチャーが同じものを表示する。ランチャーにだけ「遊ぶ」・事前取得・設定がある。

## データの流れ

| 何が変わったか | 起きること | 必要な作業 |
|---|---|---|
| dataのmd・画像・site.yml | dataの `notify-hub.yml` がhubの「Deploy site」を起動し、サイトを再公開 | なし（pushだけ） |
| 〃 | ランチャーは次回の起動時（または「最新の情報に更新」）に取得 | なし |
| `distribution.json`・Release | サイトには出ないので何も起動しない。ランチャーは次回の取得で新しい版をダウンロード | なし |
| hubのコード | タグ `v*` のpushでサイトの公開とインストーラーの作成 | タグを付ける |

hubのワークフローは **タグ `v*` と手動実行（とdataからの起動）でだけ** 動き、`main` へのpushでは動きません。

## 認証

| 用途 | 方式 | 権限 | 期限 |
|---|---|---|---|
| サイトのビルドでdataを取得 | Deploy key（hubのSecrets） | dataの読み取りのみ | なし |
| dataの更新でhubのサイト公開を起動 | GitHub App（dataのSecrets） | hubの Actions: write のみ | なし（鍵を作り直せる） |
| ランチャーがdataとReleaseを取得 | Fine-grained PAT（試遊PCの資格情報ストア） | dataの Contents: read のみ | イベント期間 |

- 試遊PCに置くPATは**漏れる前提**で、範囲を最小にし、期限を短くし、終わったら失効させます。
- client_secret やAppの秘密鍵は配布物に入れません。入れると取り出せるためです。
- GitHub App のDevice flow（ブラウザでのログイン）は、GitHubが推奨していないため使いません。

## ランチャーの動き

1. 起動時に、まず前回キャッシュした分で表示し、裏でdataのzipball（リポジトリ全体）とReleaseの一覧をPATで取得してキャッシュする。内容が変わっていれば描き直す。取得できなければ前回の分で動く。
2. `core/` で読み込み・検証し、選んだイベントのゲームを表示する。
3. 「遊ぶ」で `distribution.json` を読み、Releaseのzipをダウンロード → GitHubが返すSHA-256（`digest`）で検証 → 展開 → 起動する。zipの更新日時が変われば新しい版として取り直し、古い版を削除する。
4. `"type": "web"` のゲームはダウンロードせずにブラウザで開く。

## 安全のための制限

- Markdownの生のHTMLは文字として表示し、リンクは http(s) のみにする。
- ランチャーの画面は外部のページに遷移できない（外部リンクはOSのブラウザで開く）。CSPで読み込み元を制限する。
- ランチャーが配信するデータの画像は `games/<slug>/images/` 以下だけ。`distribution.json` はサイトに出力しない。
