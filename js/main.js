// App bootstrap.
window.App = window.App || {};

App.toast = function (message, isError) {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    el.style.cssText = 'position:fixed;bottom:16px;right:16px;padding:10px 16px;border-radius:6px;' +
      'font-size:13px;z-index:2000;max-width:360px;box-shadow:0 4px 12px rgba(0,0,0,0.4);transition:opacity .2s;';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.background = isError ? '#5a2b2b' : '#2b5f8a';
  el.style.color = '#fff';
  el.style.opacity = '1';
  clearTimeout(App._toastTimer);
  App._toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 3500);
};

document.addEventListener('DOMContentLoaded', () => {
  App.canvas.init();
  App.sidebar.init();
  App.motiveCapture.init();
  App.cameraCapture.init();
  App.liveTrackingUi.init();
  App.githubSync.init();
  App.toolbar.init();
  App.canvas.fitToStudioSketch();

  window.addEventListener('beforeunload', (e) => {
    const setup = App.Store.getSetup();
    if (setup.scenes.some(s => s.props.length > 0 || s.cameras.length > 0)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
});
