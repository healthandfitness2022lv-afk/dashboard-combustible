// Firebase compat SDK (funciona desde file://)
// Se carga ANTES que app.js via <script> normal (no module)

(function () {
  // Espera a que los scripts compat estén listos
  function initFirebase() {
    const firebaseConfig = {
      apiKey:            "AIzaSyBqwlL2lcYT6yqC8auoGVNt2Jh0qXUbOoY",
      authDomain:        "controlcombustiblebesalco.firebaseapp.com",
      projectId:         "controlcombustiblebesalco",
      storageBucket:     "controlcombustiblebesalco.firebasestorage.app",
      messagingSenderId: "872539793763",
      appId:             "1:872539793763:web:f9373265645518cd2ccb56",
    };

    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }
    window.__firestore_db    = firebase.firestore();
    window.__firebase_ready  = true;
  }

  if (typeof firebase !== 'undefined') {
    initFirebase();
  } else {
    window.addEventListener('load', initFirebase);
  }
})();
