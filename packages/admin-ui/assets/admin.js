// SPDX-License-Identifier: Apache-2.0
// relic-bridge admin UI (P4-03): optional enhancements only. Every page works without this file. Loaded as a static
// asset (`script-src 'self'` + SRI); no inline handlers, no HTML sinks (Trusted Types are enforced).
(() => {
  document.documentElement.classList.add('js');

  // Setup link (P8-86): the one-time code is in the URL fragment (`#setup=rb_setup_…`), which is never sent to a
  // server. Copy it into the setup form, remove it from the address bar and history, and post the form.
  const setupForm = document.querySelector('form[data-setup-form]');
  const setupMatch = /^#setup=(rb_setup_[0-9a-f]{64})$/.exec(location.hash);
  if (location.hash.startsWith('#setup='))
    history.replaceState(null, '', location.pathname + location.search);
  if (setupForm && setupMatch) {
    const field = setupForm.querySelector('input[name="code"]');
    if (field) {
      field.value = setupMatch[1];
      setupForm.submit();
    }
  }

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
