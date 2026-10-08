/**
 * Drag-and-drop field for file uploads
 *
 * When a file is dragged over a field, the field is highlighted
 *
 */
import { configForm } from './config-form-handle';

const ZONE = '[data-spr-drop-zone]';
const PICKER = '.spr-pickable input[type="file"]';

export function mountFileDrops(): void {
  const form = configForm();
  if (!form) return;
  const zones = Array.from(form.querySelectorAll<HTMLElement>(ZONE));
  if (zones.length === 0) return;

  form.addEventListener('click', (event) => {
    const clear = (event.target as Element).closest('[data-spr-unpick]');
    const pickable = clear?.closest('.spr-pickable');
    const picker = pickable?.querySelector<HTMLInputElement>('input[type="file"]');
    if (!picker) return;
    picker.value = '';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    pickable?.querySelector<HTMLInputElement>('input:not([type="file"])')?.focus();
  });

  // dragenter and dragleave fire for every element crossed, so we track depth to know when the drag is over the form
  let depth = 0;
  const show = (dragging: boolean, over: Element | null = null): void => {
    for (const zone of zones) {
      zone.toggleAttribute('data-spr-dragging', dragging);
      zone.toggleAttribute('data-spr-drop-over', dragging && zone === over);
    }
  };

  document.addEventListener('dragenter', (event) => {
    if (!carriesFiles(event)) return;
    depth += 1;
    show(true, zoneOf(event.target));
  });
  document.addEventListener('dragleave', (event) => {
    if (!carriesFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(false);
  });
  document.addEventListener('dragover', (event) => {
    if (!carriesFiles(event) || isNativePicker(event.target)) return;
    const zone = zoneOf(event.target);
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = zone ? 'copy' : 'none';
    show(true, zone);
  });
  document.addEventListener('drop', (event) => {
    if (!carriesFiles(event)) return;
    depth = 0;
    show(false);
    if (isNativePicker(event.target)) return;
    event.preventDefault();

    const picker = zoneOf(event.target)?.querySelector<HTMLInputElement>(PICKER);
    const file = event.dataTransfer?.files[0];
    if (!picker || !file) return;
    // Only the first file is kept, since the field holds one value
    const one = new DataTransfer();
    one.items.add(file);
    picker.files = one.files;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

function zoneOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(ZONE) : null;
}

// A visible file input takes a dropped file itself
function isNativePicker(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement &&
    target.type === 'file' &&
    !target.classList.contains('spr-file-tucked')
  );
}
