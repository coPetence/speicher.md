/** Whether anything on the form differs from what the page arrived with. */

// Serialises the form to a JSON string for change detection
export function snapshot(form: HTMLFormElement): string {
  const parts: string[] = [];

  for (const element of Array.from(form.elements)) {
    const control = element as HTMLInputElement & { dataset: DOMStringMap };
    if (!control.name || control.dataset.sprTransient !== undefined) continue;
    if (control.type === 'submit' || control.type === 'button') continue;

    if (control.type === 'file') {
      const picked = Array.from(control.files ?? []).map((file) => `${file.name}:${file.size}`);
      parts.push(`${control.name}=${picked.join(',')}`);
      continue;
    }
    if (control.type === 'checkbox' || control.type === 'radio') {
      parts.push(`${control.name}:${control.value}=${control.checked ? '1' : '0'}`);
      continue;
    }
    parts.push(`${control.name}=${control.value}`);
  }

  return JSON.stringify(parts);
}
