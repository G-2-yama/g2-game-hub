//! ゲームランチャー本体。
//! 非公開のデータリポジトリ（GitHub）を zipball で取得してキャッシュし、画面（launcher/src/app.ts）に渡す。
//! 各ゲームの distribution.json に従って Release の zip をダウンロード・検証・展開・起動する。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::http::Response;
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// トークンを保存する資格情報ストア（Windows の資格情報マネージャー、macOS のキーチェーン等）のサービス名。
const KEYRING_SERVICE: &str = "jp.g2.game-launcher";
const API: &str = "https://api.github.com";
/// distribution.json で tag を省略したときの Release のタグ。
const DEFAULT_TAG: &str = "playtest";

type CmdResult<T> = Result<T, String>;

fn msg<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

struct AppState {
    client: reqwest::Client,
    running: Mutex<HashSet<String>>,
    /// 同じゲームの取得が重複しないよう、ゲームごとに取得を直列にする。
    installing: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

// ---------- 設定 ----------

/// 保存する設定。トークンはここに含めず、資格情報ストアに保存する。
#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    repo: String,
    event: Option<String>,
}

/// ゲームやキャッシュを1フォルダにまとめ、このフォルダを消せば元に戻せるようにする。
/// 大きなゲームが移動プロファイルで同期されないよう Local に置く。
fn data_root(app: &AppHandle) -> CmdResult<PathBuf> {
    app.path().app_local_data_dir().map_err(msg)
}

fn content_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(data_root(app)?.join("content"))
}

fn games_root(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(data_root(app)?.join("games"))
}

fn read_settings(app: &AppHandle) -> Option<Settings> {
    let text = fs::read_to_string(data_root(app).ok()?.join("settings.json")).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_settings(app: &AppHandle, settings: &Settings) -> CmdResult<()> {
    let root = data_root(app)?;
    fs::create_dir_all(&root).map_err(msg)?;
    fs::write(root.join("settings.json"), serde_json::to_string(settings).map_err(msg)?).map_err(msg)
}

fn token_entry(repo: &str) -> CmdResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, repo).map_err(msg)
}

fn read_token(repo: &str) -> CmdResult<String> {
    token_entry(repo)?
        .get_password()
        .map_err(|_| "トークンが保存されていません。設定画面（Ctrl+Shift+M）から入力してください".to_string())
}

/// パスの1要素として安全な文字列（slug・バージョン）。
fn safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

fn valid_repo(repo: &str) -> bool {
    let parts: Vec<&str> = repo.split('/').collect();
    parts.len() == 2 && parts.iter().all(|part| safe_segment(part))
}

// ---------- GitHub ----------

fn github(client: &reqwest::Client, url: &str, token: &str, accept: &str) -> reqwest::RequestBuilder {
    client
        .get(url)
        .bearer_auth(token)
        .header("Accept", accept)
        .header("X-GitHub-Api-Version", "2022-11-28")
}

async fn send(request: reqwest::RequestBuilder) -> CmdResult<reqwest::Response> {
    let res = request.send().await.map_err(|e| format!("接続できません: {e}"))?;
    match res.status().as_u16() {
        200..=299 => Ok(res),
        status @ (401 | 403 | 404) => Err(format!(
            "取得できません (HTTP {status})。リポジトリ名と、トークンの対象リポジトリ・権限（Contents の読み取り）・有効期限を確認してください"
        )),
        status => Err(format!("取得できません (HTTP {status})")),
    }
}

// ---------- データ ----------

/// データリポジトリの既定ブランチを取得し、content/ を置き換える。
async fn sync_content(app: &AppHandle, state: &AppState, repo: &str, token: &str) -> CmdResult<()> {
    let request = github(&state.client, &format!("{API}/repos/{repo}/zipball"), token, "application/vnd.github+json")
        .timeout(Duration::from_secs(60));
    let bytes = send(request).await?.bytes().await.map_err(msg)?;
    let root = data_root(app)?;
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<()> {
        let tmp = root.join("content.new");
        let _ = fs::remove_dir_all(&tmp);
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(msg)?;
        archive
            .extract_unwrapped_root_dir(&tmp, zip::read::root_dir_common_filter)
            .map_err(msg)?;
        let dir = root.join("content");
        let _ = fs::remove_dir_all(&dir);
        fs::rename(&tmp, &dir).map_err(msg)
    })
    .await
    .map_err(msg)?
}

/// データリポジトリの Release 一覧を取得し、releases.json に保存する。取得できなければ前回の分を使う。
async fn sync_releases(app: &AppHandle, state: &AppState, repo: &str, token: &str) -> CmdResult<()> {
    let url = format!("{API}/repos/{repo}/releases?per_page=100");
    let releases: Vec<serde_json::Value> =
        send(github(&state.client, &url, token, "application/vnd.github+json")).await?.json().await.map_err(msg)?;
    fs::write(data_root(app)?.join("releases.json"), serde_json::to_string(&releases).map_err(msg)?).map_err(msg)
}

/// 保存済みの Release 一覧から、タグとファイル名で添付ファイルを探す。
fn cached_asset(app: &AppHandle, tag: &str, name: &str) -> Option<serde_json::Value> {
    let text = fs::read_to_string(data_root(app).ok()?.join("releases.json")).ok()?;
    let releases: Vec<serde_json::Value> = serde_json::from_str(&text).ok()?;
    let release = releases.into_iter().find(|r| r["tag_name"] == tag)?;
    release["assets"].as_array()?.iter().find(|a| a["name"] == name).cloned()
}

/// 画面に渡すデータ（core/content.ts の RawContent）。distribution.json は渡さない。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Loaded {
    site: Option<String>,
    events: BTreeMap<String, String>,
    games: BTreeMap<String, String>,
    sync_error: Option<String>,
}

fn read_content(dir: &Path) -> Loaded {
    let entries = |sub: &str| fs::read_dir(dir.join(sub)).into_iter().flatten().flatten();
    let events = entries("events")
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let id = name.strip_suffix(".md")?.to_string();
            Some((id, fs::read_to_string(entry.path()).ok()?))
        })
        .collect();
    let games = entries("games")
        .filter_map(|entry| {
            let slug = entry.file_name().into_string().ok()?;
            Some((slug, fs::read_to_string(entry.path().join("index.md")).ok()?))
        })
        .collect();
    Loaded { site: fs::read_to_string(dir.join("site.yml")).ok(), events, games, sync_error: None }
}

/// 画面に返す設定。トークンそのものは返さず、保存済みかどうかだけを返す。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    repo: String,
    event: Option<String>,
    has_token: bool,
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Option<SettingsView> {
    let settings = read_settings(&app)?;
    let has_token = read_token(&settings.repo).is_ok();
    Some(SettingsView { repo: settings.repo, event: settings.event, has_token })
}

/// 保存済みのトークンを資格情報ストアから削除する（イベント終了時など）。
#[tauri::command]
fn delete_token(app: AppHandle) -> CmdResult<()> {
    let settings = read_settings(&app).ok_or("まだ設定されていません")?;
    match token_entry(&settings.repo)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(msg(error)),
    }
}

/// 入力されたリポジトリに接続してデータを取得し、成功したら設定とトークンを保存する。
/// 同じリポジトリでトークンを空欄にした場合は、保存済みのトークンを使う。
#[tauri::command]
async fn connect(app: AppHandle, state: State<'_, AppState>, repo: String, token: String) -> CmdResult<()> {
    if !valid_repo(&repo) {
        return Err("データリポジトリは owner/name の形式で入力してください".into());
    }
    let token = if token.is_empty() { read_token(&repo)? } else { token };
    sync_content(&app, &state, &repo, &token).await?;
    sync_releases(&app, &state, &repo, &token).await?;
    token_entry(&repo)?.set_password(&token).map_err(msg)?;
    let event = read_settings(&app).filter(|s| s.repo == repo).and_then(|s| s.event);
    write_settings(&app, &Settings { repo, event })
}

#[tauri::command]
fn select_event(app: AppHandle, event: Option<String>) -> CmdResult<()> {
    let mut settings = read_settings(&app).ok_or("まだ設定されていません")?;
    settings.event = event;
    write_settings(&app, &settings)
}

/// データを返す。sync なら先に最新を取得する。取得できなければ前回の取得分を返し、理由を sync_error に入れる。
#[tauri::command]
async fn load_content(app: AppHandle, state: State<'_, AppState>, sync: bool) -> CmdResult<Loaded> {
    let settings = read_settings(&app).ok_or("まだ設定されていません")?;
    let mut sync_error = None;
    if sync {
        let result = async {
            let token = read_token(&settings.repo)?;
            sync_content(&app, &state, &settings.repo, &token).await?;
            sync_releases(&app, &state, &settings.repo, &token).await
        }
        .await;
        sync_error = result.err();
    }
    let dir = content_dir(&app)?;
    if !dir.exists() {
        return Err(sync_error.unwrap_or_else(|| "データがありません".into()));
    }
    Ok(Loaded { sync_error, ..read_content(&dir) })
}

// ---------- ゲーム ----------

/// games/<slug>/distribution.json。`type: "web"` は unityroom などブラウザで遊ぶゲーム。
#[derive(Deserialize)]
struct Distribution {
    #[serde(rename = "type")]
    kind: Option<String>,
    url: Option<String>,
    version: Option<String>,
    tag: Option<String>,
    windows: Option<Build>,
    macos: Option<Build>,
    linux: Option<Build>,
}

/// OSごとの配布物。Release の添付ファイル名（asset）か、直接ダウンロードできる https の url を書く。
/// asset の版は添付ファイルの更新日時で判断し、破損は GitHub が返す SHA-256（digest）で検出する。
/// url の場合は distribution.json の version で版を判断し、sha256 があれば検証する。
#[derive(Deserialize, Clone)]
struct Build {
    asset: Option<String>,
    url: Option<String>,
    sha256: Option<String>,
    exe: String,
    #[serde(default)]
    args: Vec<String>,
}

enum Game {
    Web(String),
    Zip { version: String, tag: String, build: Build },
}

/// 遊べるゲームの配布情報。distribution.json がない、またはこのOS向けがなければ None。
fn get_game(app: &AppHandle, id: &str) -> CmdResult<Option<Game>> {
    if !safe_segment(id) {
        return Ok(None);
    }
    let file = content_dir(app)?.join("games").join(id).join("distribution.json");
    let Ok(text) = fs::read_to_string(file) else { return Ok(None) };
    let invalid = |reason: &str| format!("games/{id}/distribution.json: {reason}");
    let d: Distribution = serde_json::from_str(&text).map_err(|e| invalid(&e.to_string()))?;
    if d.kind.as_deref() == Some("web") {
        let url = d.url.filter(|u| u.starts_with("https://") || u.starts_with("http://"));
        return url.map(|u| Some(Game::Web(u))).ok_or_else(|| invalid("url に http(s) のURLを指定してください"));
    }
    let build = if cfg!(target_os = "windows") {
        d.windows
    } else if cfg!(target_os = "macos") {
        d.macos
    } else {
        d.linux
    };
    let Some(build) = build else { return Ok(None) };
    let tag = d.tag.unwrap_or_else(|| DEFAULT_TAG.to_string());
    let version = match &build.asset {
        Some(asset) => {
            let found = cached_asset(app, &tag, asset)
                .ok_or_else(|| invalid(&format!("Release「{tag}」に「{asset}」がありません（最新の情報に更新してください）")))?;
            // 例: 2026-11-14T01:30:00Z → 2026.11.14-013000
            let updated = found["updated_at"].as_str().unwrap_or_default();
            updated.replacen('-', ".", 2).replace('T', "-").replace([':', 'Z'], "")
        }
        None if build.url.as_deref().is_some_and(|u| u.starts_with("https://")) => d.version.unwrap_or_default(),
        None => return Err(invalid("asset か https の url を指定してください")),
    };
    if !safe_segment(&version) {
        return Err(invalid("version がない、または使えない文字が含まれています（url の場合は version が必要です）"));
    }
    Ok(Some(Game::Zip { version, tag, build }))
}

/// 展開済み（.installed あり）のバージョン。
fn installed_version(app: &AppHandle, id: &str) -> Option<String> {
    let dir = games_root(app).ok()?.join(id);
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .find(|entry| entry.path().join(".installed").exists())
        .and_then(|entry| entry.file_name().into_string().ok())
}

/// state は none（未登録）/ web（ダウンロード不要）/ missing（未取得）/ outdated（更新あり）/ installed（最新を取得済み）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GameStatus {
    state: &'static str,
    installed_version: Option<String>,
    latest_version: Option<String>,
}

fn game_status(app: &AppHandle, id: &str) -> GameStatus {
    let none = |state| GameStatus { state, installed_version: None, latest_version: None };
    match get_game(app, id) {
        Ok(Some(Game::Web(_))) => none("web"),
        Ok(Some(Game::Zip { version, .. })) => {
            let installed = installed_version(app, id);
            let state = match &installed {
                None => "missing",
                Some(v) if *v == version => "installed",
                Some(_) => "outdated",
            };
            GameStatus { state, installed_version: installed, latest_version: Some(version) }
        }
        Ok(None) => none("none"),
        Err(error) => {
            eprintln!("{error}");
            none("none")
        }
    }
}

fn progress(app: &AppHandle, id: &str, message: &str) {
    let _ = app.emit("launcher:progress", (id, message));
}

async fn download_zip(app: &AppHandle, state: &AppState, id: &str, tag: &str, build: &Build, zip_path: &Path) -> CmdResult<()> {
    progress(app, id, "ダウンロード中…");
    let mut expected = build.sha256.clone();
    let mut res = match &build.asset {
        Some(asset) => {
            let repo = read_settings(app).ok_or("まだ設定されていません")?.repo;
            let token = read_token(&repo)?;
            let release_url = format!("{API}/repos/{repo}/releases/tags/{tag}");
            let release: serde_json::Value =
                send(github(&state.client, &release_url, &token, "application/vnd.github+json")).await?.json().await.map_err(msg)?;
            let found = release["assets"]
                .as_array()
                .and_then(|assets| assets.iter().find(|a| a["name"] == asset.as_str()))
                .ok_or_else(|| format!("Release「{tag}」に「{asset}」がありません"))?;
            let url = found["url"].as_str().unwrap_or_default().to_string();
            if let Some(digest) = found["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")) {
                expected = Some(digest.to_string());
            }
            // トークンは api.github.com にだけ送られ、実体へのリダイレクト先には送られない。
            send(github(&state.client, &url, &token, "application/octet-stream")).await?
        }
        None => send(state.client.get(build.url.as_deref().unwrap_or_default())).await?,
    };

    let total = res.content_length().unwrap_or(0);
    let mut file = fs::File::create(zip_path).map_err(msg)?;
    let mut hasher = Sha256::new();
    let (mut received, mut reported) = (0u64, 0u64);
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("ダウンロードに失敗しました: {e}"))? {
        file.write_all(&chunk).map_err(msg)?;
        hasher.update(&chunk);
        received += chunk.len() as u64;
        if received - reported >= 1 << 20 {
            reported = received;
            let mb = received as f64 / 1024.0 / 1024.0;
            let text = if total > 0 {
                format!("ダウンロード中… {}% ({mb:.1}MB)", received * 100 / total)
            } else {
                format!("ダウンロード中… {mb:.1}MB")
            };
            progress(app, id, &text);
        }
    }
    drop(file);
    if let Some(expected) = &expected {
        let actual: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if !actual.eq_ignore_ascii_case(expected.trim()) {
            return Err("ファイルのハッシュが一致しません（ダウンロードが壊れたか、配布中に差し替えられた可能性があります）".into());
        }
    }
    Ok(())
}

/// ゲームが未導入ならダウンロード・展開し、展開先を返す。古いバージョンは削除する。
async fn ensure_installed(app: &AppHandle, state: &AppState, id: &str, version: &str, tag: &str, build: &Build) -> CmdResult<PathBuf> {
    let lock = state.installing.lock().unwrap().entry(id.to_string()).or_default().clone();
    let _guard = lock.lock().await;

    let game_root = games_root(app)?.join(id);
    let dir = game_root.join(version);
    if installed_version(app, id).as_deref() == Some(version) {
        return Ok(dir);
    }
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(msg)?;
    let zip_path = game_root.join(format!("{version}.zip"));

    let result = async {
        download_zip(app, state, id, tag, build, &zip_path).await?;
        progress(app, id, "展開中…");
        let (zip_file, target) = (zip_path.clone(), dir.clone());
        tauri::async_runtime::spawn_blocking(move || -> CmdResult<()> {
            let mut archive = zip::ZipArchive::new(fs::File::open(zip_file).map_err(msg)?).map_err(msg)?;
            archive.extract(&target).map_err(|e| format!("展開に失敗しました: {e}"))?;
            fs::write(target.join(".installed"), "").map_err(msg)
        })
        .await
        .map_err(msg)?
    }
    .await;
    let _ = fs::remove_file(&zip_path);
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&dir);
        return Err(error);
    }

    // 旧版が起動中などで消せない場合は次回に回す。
    for entry in fs::read_dir(&game_root).into_iter().flatten().flatten() {
        if entry.file_name() != version {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    Ok(dir)
}

async fn install(app: &AppHandle, state: &AppState, id: &str) -> CmdResult<()> {
    match get_game(app, id)? {
        None => Err("このゲームは登録されていません".into()),
        Some(Game::Web(_)) => Ok(()),
        Some(Game::Zip { version, tag, build }) => {
            ensure_installed(app, state, id, &version, &tag, &build).await?;
            progress(app, id, "");
            Ok(())
        }
    }
}

#[tauri::command]
fn status(app: AppHandle, id: String) -> GameStatus {
    game_status(&app, &id)
}

#[tauri::command]
async fn download(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    install(&app, &state, &id).await
}

#[derive(Serialize)]
struct DownloadAll {
    total: usize,
    failed: Vec<String>,
}

/// 指定したゲームのうち、未取得・更新ありのものを順番に取得する。
#[tauri::command]
async fn download_all(app: AppHandle, state: State<'_, AppState>, ids: Vec<String>) -> CmdResult<DownloadAll> {
    let targets: Vec<String> = ids
        .into_iter()
        .filter(|id| matches!(game_status(&app, id).state, "missing" | "outdated"))
        .collect();
    let mut failed = Vec::new();
    for (i, id) in targets.iter().enumerate() {
        progress(&app, "*", &format!("取得中… {} / {}（{id}）", i + 1, targets.len()));
        if let Err(error) = install(&app, &state, id).await {
            failed.push(format!("{id}: {error}"));
        }
        progress(&app, id, "");
    }
    progress(&app, "*", "");
    Ok(DownloadAll { total: targets.len(), failed })
}

fn open_web_game(app: &AppHandle, id: &str, url: &str) -> CmdResult<()> {
    let label = format!("web-{id}");
    if let Some(window) = app.get_webview_window(&label) {
        return window.set_focus().map_err(msg);
    }
    let url: Url = url.parse().map_err(msg)?;
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .inner_size(1280.0, 800.0)
        .build()
        .map_err(msg)?;
    Ok(())
}

async fn launch(app: &AppHandle, state: &AppState, id: &str, version: &str, tag: &str, build: &Build) -> CmdResult<()> {
    let dir = ensure_installed(app, state, id, version, tag, build).await?;
    let exe = dir.join(&build.exe);
    let not_found = || format!("実行ファイルが見つかりません: {}", build.exe);
    let resolved = exe.canonicalize().map_err(|_| not_found())?;
    if !resolved.starts_with(dir.canonicalize().map_err(msg)?) {
        return Err(not_found());
    }

    let mut command = if cfg!(target_os = "macos") && exe.extension().is_some_and(|ext| ext == "app") {
        let mut c = Command::new("open");
        c.arg("-W").arg("-n").arg(&exe);
        if !build.args.is_empty() {
            c.arg("--args").args(&build.args);
        }
        c
    } else {
        let mut c = Command::new(&exe);
        c.args(&build.args);
        if let Some(parent) = exe.parent() {
            c.current_dir(parent);
        }
        c
    };
    let mut child = command.spawn().map_err(|e| format!("起動できません: {e}"))?;
    progress(app, id, "プレイ中");
    let (app, id) = (app.clone(), id.to_string());
    std::thread::spawn(move || {
        let _ = child.wait();
        app.state::<AppState>().running.lock().unwrap().remove(&id);
        progress(&app, &id, "");
    });
    Ok(())
}

#[tauri::command]
async fn play(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    if state.running.lock().unwrap().contains(&id) {
        return Err("このゲームはすでに起動しています".into());
    }
    match get_game(&app, &id)? {
        None => Err("このゲームは登録されていません".into()),
        Some(Game::Web(url)) => open_web_game(&app, &id, &url),
        Some(Game::Zip { version, tag, build }) => {
            state.running.lock().unwrap().insert(id.clone());
            let result = launch(&app, &state, &id, &version, &tag, &build).await;
            if result.is_err() {
                state.running.lock().unwrap().remove(&id);
            }
            result
        }
    }
}

// ---------- キャッシュの管理 ----------

fn dir_size(path: &Path) -> u64 {
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(t) if t.is_dir() => dir_size(&entry.path()),
            Ok(t) if t.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

#[derive(Serialize)]
struct InstalledGame {
    id: String,
    version: Option<String>,
    size: u64,
}

/// 取得済み（展開途中を含む）のゲームと使用容量。
#[tauri::command]
fn installed_games(app: AppHandle) -> CmdResult<Vec<InstalledGame>> {
    let mut games: Vec<InstalledGame> = fs::read_dir(games_root(&app)?)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let id = entry.file_name().into_string().ok()?;
            Some(InstalledGame { version: installed_version(&app, &id), size: dir_size(&entry.path()), id })
        })
        .collect();
    games.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(games)
}

/// 取得済みのゲームを削除する。起動中・取得中のゲームは削除しない。
#[tauri::command]
async fn remove_game(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    if !safe_segment(&id) {
        return Err("ゲームの指定が正しくありません".into());
    }
    if state.running.lock().unwrap().contains(&id) {
        return Err("起動中のゲームは削除できません".into());
    }
    let lock = state.installing.lock().unwrap().get(&id).cloned();
    let _guard = match &lock {
        Some(lock) => Some(lock.try_lock().map_err(|_| "取得中のゲームは削除できません".to_string())?),
        None => None,
    };
    let dir = games_root(&app)?.join(&id);
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("削除できません（ゲームのファイルが使用中の可能性があります）: {error}")),
    }
}

/// ゲームやデータのキャッシュを置いているフォルダを開く。
#[tauri::command]
fn open_data_dir(app: AppHandle) -> CmdResult<()> {
    let root = data_root(&app)?;
    fs::create_dir_all(&root).map_err(msg)?;
    app.opener().open_path(root.to_string_lossy(), None::<&str>).map_err(msg)
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> CmdResult<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("http(s) のURLのみ開けます".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(msg)
}

// ---------- 画像の配信 ----------

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(byte)) => {
                out.push(byte);
                i += 3;
            }
            (byte, _) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// content://localhost/games/<slug>/images/... で、キャッシュした画像だけを配信する。
fn serve_content(app: &AppHandle, path: &str) -> Response<Vec<u8>> {
    let not_found = || Response::builder().status(404).body(Vec::new()).unwrap();
    let segments: Vec<String> = path.trim_start_matches('/').split('/').map(percent_decode).collect();
    let valid = segments.len() >= 4
        && segments[0] == "games"
        && segments[2] == "images"
        && segments.iter().all(|s| !s.is_empty() && s != "." && s != ".." && !s.contains(['/', '\\', ':']));
    let Some(root) = content_dir(app).ok().filter(|_| valid) else { return not_found() };
    let file = segments.iter().fold(root, |path, segment| path.join(segment));
    match fs::read(&file) {
        Ok(body) => Response::builder().header("Content-Type", content_type(&file)).body(body).unwrap(),
        Err(_) => not_found(),
    }
}

/// ランチャー自身の画面か（それ以外への遷移は既定のブラウザで開く）。
fn is_app_url(url: &Url) -> bool {
    matches!(url.scheme(), "tauri" | "about" | "data" | "blob")
        || matches!(url.host_str(), Some("tauri.localhost" | "www.youtube-nocookie.com"))
        || (cfg!(debug_assertions) && url.host_str() == Some("localhost"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState {
        client: reqwest::Client::builder().user_agent("g2-game-launcher").build().expect("HTTPクライアントを作成できません"),
        running: Mutex::default(),
        installing: Mutex::default(),
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .register_uri_scheme_protocol("content", |ctx, request| serve_content(ctx.app_handle(), request.uri().path()))
        .invoke_handler(tauri::generate_handler![
            get_settings,
            delete_token,
            connect,
            select_event,
            load_content,
            status,
            download,
            download_all,
            play,
            installed_games,
            remove_game,
            open_data_dir,
            open_external
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("G2 Game Launcher")
                .inner_size(1280.0, 800.0)
                .on_navigation(move |url| {
                    if is_app_url(url) {
                        return true;
                    }
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("ランチャーを起動できません");
}
