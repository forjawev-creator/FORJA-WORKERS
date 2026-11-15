/* The secret is entered once and exchanged for an HttpOnly session cookie. */
(() => {
  const original = window.fetch.bind(window);
  let login;
  function requestLogin() {
    return new Promise(resolve => {
      const show = () => {
        const dialog = document.createElement('dialog');
        dialog.setAttribute('aria-labelledby', 'control-login-title');
        dialog.style.cssText = 'max-width:440px;width:calc(100% - 48px);border:1px solid #475569;border-radius:16px;padding:28px;background:#0f172a;color:#f8fafc;font:15px system-ui';
        dialog.innerHTML = '<form><h2 id="control-login-title">Acceso al panel</h2><p>Introduce la clave local de <code>data/control-token.txt</code>.</p><label for="control-login-token">Clave de control</label><input id="control-login-token" type="password" required autocomplete="off" style="display:block;box-sizing:border-box;width:100%;padding:12px;margin:12px 0;border-radius:8px;border:1px solid #64748b;background:#1e293b;color:white"><p role="alert" style="color:#fca5a5"></p><button type="submit" style="padding:12px 20px;border:0;border-radius:8px;background:#38bdf8;color:#082f49;font-weight:700;cursor:pointer">Entrar al panel</button></form>';
        const form = dialog.querySelector('form'), input = dialog.querySelector('input'), error = dialog.querySelector('[role="alert"]'), button = dialog.querySelector('button');
        const fileButton = document.createElement('button'), fileInput = document.createElement('input');
        fileInput.type = 'file';fileInput.accept = '.txt';fileInput.hidden = true;
        fileButton.type = 'button';fileButton.textContent = 'Seleccionar archivo de clave';
        fileButton.style.cssText = 'display:block;margin:12px 0;padding:8px;border:1px solid #64748b;border-radius:6px;background:#1e293b;color:white;cursor:pointer';
        fileButton.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
          try {
            const file = fileInput.files[0];
            if (!file || file.size > 2048) throw new Error();
            input.value = (await file.text()).trim();error.textContent = '';input.focus();
          } catch { error.textContent = 'No se pudo leer la clave. Selecciona data/control-token.txt.'; }
          fileInput.value = '';
        });
        form.insertBefore(fileButton,error);form.append(fileInput);
        dialog.addEventListener('cancel', event => event.preventDefault());
        form.addEventListener('submit', async event => {
          event.preventDefault();button.disabled = true;error.textContent = '';
          try {
            const result = await original('/api/control/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:input.value.trim()})});
            if (!result.ok) { error.textContent = 'La clave no es válida. Revisa el archivo local.'; return; }
            input.value = '';dialog.close();dialog.remove();resolve(true);
          } catch { error.textContent = 'No se pudo conectar con el servicio. Inténtalo de nuevo.'; }
          finally { button.disabled = false; }
        });
        document.body.append(dialog);dialog.showModal();input.focus();
      };
      if (document.body) show(); else document.addEventListener('DOMContentLoaded',show,{once:true});
    });
  }
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url || input, location.href);
    const response = await original(input, init);
    if (url.origin !== location.origin || response.status !== 401 || url.pathname === '/api/control/login') return response;
    if (!login) login = requestLogin().finally(() => { login = undefined; });
    return await login ? original(input, init) : response;
  };
})();

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const response = await fetch('/api/safety');
    if (!response.ok) return;
    const policy = await response.json();
    if (policy.controlOnly) {
      const notice = document.createElement('div');
      notice.id = 'workers-safety-notice';
      notice.setAttribute('role', 'status');
      notice.style.cssText = 'position:sticky;top:0;z-index:9999;background:#fef3c7;color:#78350f;padding:14px 20px;text-align:center;font:600 15px system-ui;border-bottom:2px solid #d97706';
      notice.textContent = 'Modo seguro: llamadas y envíos reales DESACTIVADOS. Puedes iniciar y pausar los workers sin contactar con nadie.';
      document.body.prepend(notice);
    }
  } catch { /* The protected endpoints still enforce the policy if the banner cannot load. */ }
});
