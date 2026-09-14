// Lightweight on-screen debug logger: shows JS errors directly in the page
// (bottom banner) so problems can be diagnosed from a phone/screenshot too,
// without needing to open the browser's developer console.
window.debugLog = function(msg){
  try{
    var b = document.getElementById('debugBox');
    if(b){
      b.style.display = 'block';
      var line = document.createElement('div');
      line.textContent = '• ' + msg;
      b.appendChild(line);
      b.scrollTop = b.scrollHeight;
      var closeBtn = document.getElementById('debugBoxClose');
      if(closeBtn) closeBtn.style.display = 'block';
    }
    console.warn('[debug]', msg);
  } catch(e){ console.error(msg); }
};
window.addEventListener('error', function(e){
  window.debugLog('Lỗi JS: ' + (e.message || e) + (e.filename ? (' @' + e.filename.split('/').pop() + ':' + e.lineno) : ''));
});
window.addEventListener('unhandledrejection', function(e){
  window.debugLog('Lỗi Promise: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
});
