import { SetupStep } from '../../../../setup/steps';
import { renderIconRef } from '../../../../../content-reader/icons';
import { escapeHtml } from '../../../../../content-reader/views';

/** First-run step rail: done steps get a check, the current one is marked */
export function renderSetupProgress(steps: SetupStep[]): { html: string; icons: string[] } {
  const icons: string[] = [];
  const points = steps
    .map((step, index) => {
      const classes = ['spr-progress-step'];
      if (step.done) classes.push('spr-progress-done');
      if (step.current) classes.push('spr-progress-current');

      // A finished step borrows the check icon from the shared sprite
      if (step.done) icons.push('check');
      const mark = step.done
        ? renderIconRef('check')
        : `<span aria-hidden="true">${index + 1}</span>`;
      return (
        `<li class="${classes.join(' ')}">` +
        `<a href="${step.href}"${step.current ? ' aria-current="step"' : ''}>` +
        `<span class="spr-progress-mark">${mark}</span>` +
        `<span class="spr-progress-label">${escapeHtml(step.title)}</span>` +
        (step.done ? '<span class="spr-clipped">done</span>' : '') +
        `</a></li>`
      );
    })
    .join('');

  return {
    html:
      `<nav class="spr-progress" aria-label="Setting up this instance">` +
      `<ol>${points}</ol></nav>`,
    icons,
  };
}
