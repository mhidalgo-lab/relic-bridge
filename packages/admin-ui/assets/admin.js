// SPDX-License-Identifier: Apache-2.0
// relic-bridge admin UI (P4-03): optional enhancements only. Every page works without this file. Loaded as a static
// asset (`script-src 'self'` + SRI); no inline handlers, no HTML sinks (Trusted Types are enforced).
(() => {
  document.documentElement.classList.add('js');

  // Copy buttons: <button type="button" data-copy="<element id>" hidden>. Shown only when the clipboard API exists.
  const canCopy = Boolean(navigator.clipboard && window.isSecureContext);
  for (const button of document.querySelectorAll('button[data-copy]')) {
    if (!canCopy) continue;
    const target = document.getElementById(button.getAttribute('data-copy') || '');
    if (!target) continue;
    button.hidden = false;
    const label = button.textContent;
    button.addEventListener('click', () => {
      navigator.clipboard.writeText(target.textContent || '').then(
        () => {
          button.textContent = 'Copied';
          setTimeout(() => {
            button.textContent = label;
          }, 2000);
        },
        () => {
          button.textContent = 'Copy failed: select the text instead';
        },
      );
    });
  }
})();
