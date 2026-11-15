/** YouTubeのURL（watch / youtu.be / shorts / embed）から動画IDを取り出す。 */
export const youtubeUrl = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/;

/**
 * 動画は最初はサムネイルだけを表示し、クリックされたときに埋め込みを読み込む。
 * 埋め込みの読み込みは重く、ページを開いた直後に読み込むと操作できなくなることがあるため。
 */
export function enableYoutubeFacade() {
  document.addEventListener('click', (event) => {
    const button = (event.target as Element).closest?.<HTMLElement>('[data-youtube-id]');
    if (!button) return;
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(button.dataset.youtubeId!)}?autoplay=1`;
    iframe.title = button.getAttribute('aria-label') ?? '';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    iframe.allowFullscreen = true;
    button.replaceWith(iframe);
  });
}
