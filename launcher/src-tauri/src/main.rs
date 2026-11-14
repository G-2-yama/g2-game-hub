// リリースビルドの Windows でコンソールウィンドウを出さない。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    g2_game_launcher_lib::run()
}
