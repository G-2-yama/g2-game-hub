---
type: Guide
title: ランチャーの使い方
description: 試遊PCでの設定と操作、データの保存場所、トラブル時の確認点。
tags: [launcher, windows]
status: draft
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-14T18:00:00+09:00 }
---

# ランチャーの使い方

## 初回の設定

1. インストーラー（hubのReleaseの `.exe`）を実行する。管理者権限は不要。
2. 起動すると設定画面が開くので、データリポジトリ（`<org>/g2-game-data`）とPATを入力して「接続」する。
3. 表示するイベント（または「すべてのゲーム」）を選ぶ。

設定画面はヘッダーの「設定」か `Ctrl+Shift+M` でいつでも開けます。

## 画面

| 画面 | できること |
|---|---|
| 一覧・詳細 | サイトと同じ表示。詳細ページの「このゲームで遊ぶ」で起動（未取得なら取得してから起動） |
| 事前取得 | ゲームごとの取得状況、個別・すべての取得、「最新の情報に更新」 |
| 設定 | 接続先とトークンの変更・削除、イベントの選択、取得済みゲームの一覧・削除・フォルダを開く |

## 保存場所

| もの | 場所 |
|---|---|
| アプリ本体 | `%LOCALAPPDATA%\G2 Game Launcher\` |
| 設定・データ・ゲーム | `%LOCALAPPDATA%\jp.g2.game-launcher\`（macOS は `~/Library/Application Support/jp.g2.game-launcher/`、Linux は `~/.local/share/jp.g2.game-launcher/`） |
| トークン | OSの資格情報ストア（Windowsの資格情報マネージャー、macOSのキーチェーン） |

```text
jp.g2.game-launcher\
├─ settings.json    接続先と選んだイベント（トークンは含まない）
├─ releases.json    取得したReleaseの一覧（版の判断に使う）
├─ content\         取得したデータ（md・画像・distribution.json）
└─ games\<slug>\    ダウンロードして展開したゲーム
```

アンインストールしても、このフォルダとトークンは既定では残ります。先に設定画面で削除してください。

## うまく動かないとき

| 症状 | 確認すること |
|---|---|
| 接続できない | PATの期限・対象リポジトリ・Organizationの承認 |
| 「遊ぶ」が出ない | そのOSの配布情報が `distribution.json` にあるか |
| ダウンロードが失敗する | Release（既定は `playtest`）に `asset` の名前のzipがあるか。差し替え直後なら「最新の情報に更新」してから再度試す |
| 起動しない | `exe` のパス（zip内の相対パス）。設定画面の「フォルダを開く」で中身を確認 |
| 削除できない | ゲームを終了してから削除する |
