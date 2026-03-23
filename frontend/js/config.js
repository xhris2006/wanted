/**
 * WANTED — URL de l'API
 * ══════════════════════════════════════════════════════════
 *  Remplacez l'URL ci-dessous par celle de votre backend Railway.
 *  Exemple : 'https://wanted-api-production.up.railway.app/api'
 *
 *  Comment trouver votre URL Railway :
 *  Projet Railway → votre service Node → onglet Settings
 *  → Networking → Public Networking → Generate Domain
 * ══════════════════════════════════════════════════════════
 */
const BACKEND_RAILWAY_URL = 'https://wanted-production-4041.up.railway.app/';

// ── Ne rien modifier en dessous ──────────────────────────
(function () {
  const host = window.location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';

  window.WANTED_API = isLocal ? 'http://localhost:5000/api' : BACKEND_RAILWAY_URL;

  if (window.WANTED_API.includes('REMPLACEZ')) {
    console.error(
      '%c⚠️ WANTED : URL backend non configurée !%c\n' +
      'Ouvrez frontend/js/config.js et remplacez BACKEND_RAILWAY_URL par votre URL Railway.',
      'color:red;font-weight:bold;font-size:14px', 'color:orange'
    );
  } else {
    console.log('%c✅ WANTED API%c', 'color:green;font-weight:bold', 'color:gray', window.WANTED_API);
  }
})();
