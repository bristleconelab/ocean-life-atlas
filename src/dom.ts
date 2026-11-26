// Tiny DOM builder. All remote text goes in through textContent, never innerHTML.
type Child = Node | string | number | null | undefined | false;
interface Props {
  class?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  on?: Partial<Record<keyof HTMLElementEventMap, (e: Event) => void>>;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text != null) el.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) {
    if (v === false || v == null) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const [k, fn] of Object.entries(props.on ?? {})) if (fn) el.addEventListener(k, fn);
  for (const c of children) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export const fmt = (n: number) => n.toLocaleString('en-US');
/** "1 place", "3 places", "2 studies". */
export const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

/** Load a photo into a frame, trying each URL in turn. The frame's data-photo says what the reader sees:
 *  "loading" (shimmer), "ok", or "none" (a quiet "No photo yet"). */
export function loadPhoto(frame: HTMLElement, urls: string[], alt: string, eager = false, onLoad?: (img: HTMLImageElement) => void) {
  frame.dataset.photo = 'loading';
  const img = document.createElement('img');
  img.alt = alt;
  img.decoding = 'async';
  if (eager) img.setAttribute('fetchpriority', 'high'); else img.loading = 'lazy';
  let i = 0;
  img.addEventListener('load', () => { img.classList.add('in'); frame.dataset.photo = 'ok'; onLoad?.(img); });
  img.addEventListener('error', () => {
    if (++i < urls.length) img.src = urls[i];
    else { img.remove(); frame.dataset.photo = 'none'; }
  });
  img.src = urls[0];
  frame.append(img);
  return img;
}

/** Hand the reader a file made in the browser. */
export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
