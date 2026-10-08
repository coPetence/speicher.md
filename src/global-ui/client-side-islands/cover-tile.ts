/**
 * Failed cover images removed to reveal the fallback SVG tile
 *
 * Images inside `.spr-cover` sit on top of the `.spr-cover-art` SVG tile
 * When the image fails to load it is removed, letting the tile show
 * through the `overflow: hidden` box
 *
 * Already-failed images are caught on mount; loading ones get a one-shot
 * error listener
 */

function failed(img: HTMLImageElement): boolean {
  return img.complete && img.naturalWidth === 0;
}

export function mountCovers(root: ParentNode = document): void {
  for (const img of root.querySelectorAll<HTMLImageElement>('.spr-cover img')) {
    if (img.complete) {
      if (failed(img)) img.remove();
      continue;
    }
    img.addEventListener('error', () => img.remove(), { once: true });
  }
}
