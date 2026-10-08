/**
 * Opens the folded section containing a fragment target
 *
 * The browser scrolls to the hash target on load and on hash change, but a
 * closed `<details>` hides its contents, so there is no box to scroll to
 */
export function mountFragments(): void {
  const open = (): void => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;

    const target = document.getElementById(id);
    const block = target?.closest('details');
    if (block) block.open = true;
  };

  open();
  window.addEventListener('hashchange', open);
}
