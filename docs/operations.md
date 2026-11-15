---
type: Runbook
title: 運用
description: 初期設定、イベントの準備と後片付け、ランチャーのリリース、鍵とトークンの管理。
tags: [operations, release, security]
status: draft
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-15T12:00:00+09:00 }
---

# 運用

`<org>` はOrganization名です。

## 初期設定（一度だけ）

### 1. サイトのビルドでdataを読めるようにする（Deploy key）

```bash
cd ~ && ssh-keygen -t ed25519 -f content_deploy_key -N "" -C "g2-game-hub site build"
```

1. **data** → `Settings > Deploy keys` に `content_deploy_key.pub` を登録（Allow write access はオフ）。
2. **hub** → `Settings > Secrets and variables > Actions`
   - Secrets `CONTENT_DEPLOY_KEY`：`content_deploy_key` の中身
   - Variables `CONTENT_REPOSITORY`：`<org>/g2-game-data`
3. 手元の鍵ファイルを2つとも削除する。

### 2. GitHub Pages

**hub** → `Settings > Pages > Source` を **GitHub Actions** にする。Actions の「Deploy site」を手動実行して表示を確認する。

### 3. dataの更新でサイトを自動更新する（GitHub App）

1. Organization の `Settings > Developer settings > GitHub Apps > New GitHub App`
   - Webhook：Active を外す
   - Repository permissions：**Actions: Read and write のみ**
   - Device flow：有効にしない
   - インストール先：Only on this account
2. Client ID（General のページ）を控え、`Credentials > Key pairs > New key` で .pem を作る（`Client secrets` は作らない）。
3. `Install App` で **hubだけ**にインストールする。
4. **data** → `Settings > Secrets and variables > Actions`
   - Variables `HUB_APP_CLIENT_ID`：Client ID
   - Variables `HUB_REPOSITORY`：`g2-game-hub`（owner は付けない）
   - Secrets `HUB_APP_PRIVATE_KEY`：.pem の中身
5. .pem を削除する。dataの Actions「Notify hub」を手動実行し、hubの「Deploy site」が動けば完了。

### 4. トークンのポリシー（任意）

なくても動くが、メンバーが加わる前に設定することをおすすめする（理由は [リポジトリの連携とCI](integration.md#任意の設定)）。

Organization の `Settings > Personal access tokens`：Fine-grained は承認制、期限の上限は30日程度、Classic は禁止。

## イベントの準備

1. dataに `events/<id>.md` を作り、出展するゲームを並べる（書き方はdataの `docs/`）。
2. 配布するゲームの Release と `distribution.json` を確認する。
3. ランチャー用のPATを発行する（個人の `Settings > Developer settings > Fine-grained tokens`）。
   - Resource owner：Organization／Repository：**dataのみ**／Contents：**Read-only**／期限：イベント終了日まで
   - 管理者が承認する。
4. 試遊PCにランチャーを入れ、PATで接続してイベントを選び、「事前取得」でゲームをダウンロードしておく（[ランチャーの使い方](./launcher.md)）。

## イベントの後片付け

1. PATを**失効**させる（発行者の設定画面、または Organization の設定から）。
2. 試遊PCで、ランチャーの設定画面から「トークンの削除」と「すべて削除」を行う。
3. 返却するPCなら、その後アンインストールする（データフォルダは既定では残るため、2を先に行う）。

## ランチャーのリリース

データの更新ではリリースは不要です。ランチャーのコードを変えたときだけ行います。

1. 変更をコミットし、pushする。
2. 版のタグを付ける：`git tag v0.2.0 && git push origin v0.2.0`
   - 版はタグだけで決まり、CIがビルド前に `package.json` へ設定する。`package.json` と `Cargo.toml` の `0.0.0` は手元でのビルド用の仮の値なので、書き換えない。
   - タグを間違えたら消して付け直す：`git push origin :refs/tags/<タグ> && git tag -d <タグ>`
3. Actions がWindows用インストーラー（NSIS）を作り、hubのReleaseに添付する。サイトも再公開される。

インストーラーは Windows の「アプリ」に登録され、`winget list` にも表示されます（wingetのリポジトリには登録していないので `winget install` はできません）。署名していないため、初回はSmartScreenの警告が出ます。

## 鍵とトークンの管理

| もの | 漏れたときにできること | 対処 |
|---|---|---|
| ランチャーのPAT | dataとReleaseの読み取り | 失効させ、新しいPATを発行 |
| Deploy key | dataの読み取り（Releaseは不可） | dataの Deploy keys から削除し、作り直す |
| Appの秘密鍵 | hubのワークフローの起動のみ | Appの設定で鍵を削除し、作り直す |

鍵を扱った人がサークルを抜けるときも、同じ手順で作り直します。
