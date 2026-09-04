  const STORAGE_KEY = "note_journaliere_v1";

  /* ========== FIREBASE ========== */
  const firebaseConfig = {
    apiKey: "AIzaSyDvnZZw8HW0LSuC2mlWecf6aVGiKzk6o6Y",
    authDomain: "note-journaliere.firebaseapp.com",
    projectId: "note-journaliere",
    storageBucket: "note-journaliere.firebasestorage.app",
    messagingSenderId: "412765917805",
    appId: "1:412765917805:web:8dc8ba387195ed05026564",
    measurementId: "G-QVPHXN13MS"
  };

  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  let analytics = null;
  try { analytics = firebase.analytics(); } catch (e) {}

  let currentUser = null;
  let syncing = false;
  let lastCloudSave = 0;

  function logEvent(name, params) {
    try { if (analytics) analytics.logEvent(name, params || {}); } catch (e) {}
  }

  function setAuthStatus(text, type) {
    const out = document.getElementById('authStatusOut');
    const inn = document.getElementById('authStatusIn');
    [out, inn].forEach(el => {
      if (!el) return;
      el.textContent = text;
      el.classList.remove('synced', 'error');
      if (type === 'synced') el.classList.add('synced');
      if (type === 'error') el.classList.add('error');
    });
  }

  function updateAuthUI(user) {
    const loggedOut = document.getElementById('authLoggedOut');
    const loggedIn = document.getElementById('authLoggedIn');
    if (!loggedOut || !loggedIn) return;
    if (user) {
      loggedOut.style.display = 'none';
      loggedIn.style.display = 'block';
      const display = (state && state.pseudo) ? state.pseudo
        : (user.displayName || user.email?.split('@')[0] || 'Utilisateur');
      document.getElementById('authDisplayName').textContent = display;
      document.getElementById('authEmail').textContent = state && state.pseudo
        ? ('@' + state.pseudo + (user.email ? ' · ' + user.email : ''))
        : (user.email || user.uid);
      setAuthStatus('Connecté — synchronisation active', 'synced');
    } else {
      loggedOut.style.display = 'block';
      loggedIn.style.display = 'none';
      setAuthStatus('Données locales uniquement', null);
    }
  }

  function normalizePseudo(raw) {
    return String(raw || '').trim().toLowerCase().replace(/\s+/g, '_');
  }

  function validatePseudo(pseudo) {
    if (!pseudo || pseudo.length < 3) return 'Le pseudo doit faire au moins 3 caractères.';
    if (pseudo.length > 20) return 'Le pseudo ne peut pas dépasser 20 caractères.';
    if (!/^[a-z0-9_]+$/.test(pseudo)) return 'Lettres, chiffres et underscore (_) uniquement.';
    if (/^[0-9]+$/.test(pseudo)) return 'Le pseudo ne peut pas être uniquement des chiffres.';
    return null;
  }

  function openPseudoModal(force) {
    const el = document.getElementById('pseudoOverlay');
    if (!el) return;
    document.getElementById('pseudoFlash').textContent = '';
    document.getElementById('pseudoInput').value = state.pseudo || '';
    el.classList.add('open');
    if (force) {
      // Empêche de fermer en cliquant à l'extérieur tant que pas de pseudo
      el.dataset.force = '1';
    } else {
      delete el.dataset.force;
    }
    setTimeout(() => document.getElementById('pseudoInput').focus(), 100);
  }

  function closePseudoModal() {
    const el = document.getElementById('pseudoOverlay');
    if (!el) return;
    if (el.dataset.force === '1' && !state.pseudo) return; // bloqué si obligatoire
    el.classList.remove('open');
  }

  async function claimPseudo(newPseudo) {
    if (!currentUser) throw new Error('Non connecté');
    const pseudo = normalizePseudo(newPseudo);
    const err = validatePseudo(pseudo);
    if (err) throw new Error(err);

    const unameRef = db.collection('usernames').doc(pseudo);
    const userRef = db.collection('users').doc(currentUser.uid);

    await db.runTransaction(async (tx) => {
      const unameSnap = await tx.get(unameRef);
      if (unameSnap.exists) {
        const owner = unameSnap.data().uid;
        if (owner !== currentUser.uid) {
          throw new Error('Ce pseudo est déjà pris.');
        }
      }
      // Libérer l'ancien pseudo si changement
      if (state.pseudo && state.pseudo !== pseudo) {
        const oldRef = db.collection('usernames').doc(state.pseudo);
        const oldSnap = await tx.get(oldRef);
        if (oldSnap.exists && oldSnap.data().uid === currentUser.uid) {
          tx.delete(oldRef);
        }
      }
      tx.set(unameRef, {
        uid: currentUser.uid,
        pseudo: pseudo,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      tx.set(userRef, {
        pseudo: pseudo,
        pseudoUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });

    state.pseudo = pseudo;
    saveState();
    updateAuthUI(currentUser);
    logEvent('pseudo_set', { pseudo });
    return pseudo;
  }

  async function ensurePseudo() {
    if (!currentUser) return;
    if (state.pseudo && state.pseudo.length >= 3) {
      updateAuthUI(currentUser);
      return;
    }
    // Recharger depuis le cloud au cas où
    try {
      const snap = await db.collection('users').doc(currentUser.uid).get();
      if (snap.exists && snap.data().pseudo) {
        state.pseudo = snap.data().pseudo;
        saveState();
        updateAuthUI(currentUser);
        return;
      }
    } catch (e) {}
    openPseudoModal(true);
  }

  async function publishPublicProfile() {
    if (!currentUser) return;
    try {
      const score = Math.round(computeScore(state));
      const { current } = getRank(score);
      const level = typeof levelFromXp === 'function' ? levelFromXp(state.xp || 0) : 1;
      const badges = typeof getBadges === 'function' ? getBadges() : [];
      const badgesUnlocked = badges.filter(b => b.done).length;
      await db.collection('publicProfiles').doc(currentUser.uid).set({
        uid: currentUser.uid,
        pseudo: state.pseudo || '',
        userName: state.userName || '',
        xp: state.xp || 0,
        level,
        todayScore: score,
        rankName: current.name,
        rankColor: current.color,
        badgesUnlocked,
        badgesTotal: badges.length,
        dayKey: state.dayKey,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (e) {
      console.warn('public profile', e);
    }
  }

  async function saveToCloud() {
    if (!currentUser || syncing) return;
    syncing = true;
    try {
      const payload = {
        ...state,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        clientUpdatedAt: Date.now()
      };
      await db.collection('users').doc(currentUser.uid).set(payload, { merge: true });
      await publishPublicProfile();
      lastCloudSave = Date.now();
      setAuthStatus('Synchronisé ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), 'synced');
    } catch (err) {
      console.error('Cloud save error', err);
      setAuthStatus('Erreur de sync', 'error');
    } finally {
      syncing = false;
    }
  }

  async function loadFromCloud(user) {
    try {
      setAuthStatus('Chargement du cloud…', null);
      const snap = await db.collection('users').doc(user.uid).get();
      if (snap.exists) {
        const cloud = snap.data();
        // Prefer cloud data when it exists
        const base = defaultState();
        state = {
          userName: typeof cloud.userName === 'string' ? cloud.userName : base.userName,
          pseudo: typeof cloud.pseudo === 'string' ? cloud.pseudo : base.pseudo,
          dayKey: cloud.dayKey || base.dayKey,
          exercises: Array.isArray(cloud.exercises) && cloud.exercises.length ? cloud.exercises : base.exercises,
          history: Array.isArray(cloud.history) ? cloud.history : [],
          records: cloud.records && typeof cloud.records === 'object' ? cloud.records : { bestScore: null, perExercise: {} },
          dailyGoal: typeof cloud.dailyGoal === 'number' ? cloud.dailyGoal : base.dailyGoal,
          dayNotes: cloud.dayNotes && typeof cloud.dayNotes === 'object' ? cloud.dayNotes : {},
          xp: typeof cloud.xp === 'number' ? cloud.xp : 0,
          xpClaimedChallenges: Array.isArray(cloud.xpClaimedChallenges) ? cloud.xpClaimedChallenges : [],
          seenBadges: Array.isArray(cloud.seenBadges) ? cloud.seenBadges : [],
          secretBadgeUnlocked: typeof cloud.secretBadgeUnlocked === 'boolean' ? cloud.secretBadgeUnlocked : false,
          hackerCelebratedToday: typeof cloud.hackerCelebratedToday === 'boolean' ? cloud.hackerCelebratedToday : false,
          difficultyBonus: typeof cloud.difficultyBonus === 'number' ? cloud.difficultyBonus : 0
        };
        if (!state.exercises.some(ex => ex.id === 'gainage')) {
          state.exercises = [...state.exercises, { id: "gainage", name: "Gainage", points: 5, unit: "minute", decimal: true, value: 0 }];
        }
        finalizeDayIfNeeded();
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
        setAuthStatus('Données cloud chargées', 'synced');
        logEvent('cloud_load');
        return true;
      } else {
        // First time on cloud → upload local data
        await saveToCloud();
        setAuthStatus('Première sync réussie', 'synced');
        logEvent('cloud_first_upload');
        return false;
      }
    } catch (err) {
      console.error('Cloud load error', err);
      setAuthStatus('Erreur de chargement cloud', 'error');
      return false;
    }
  }

  auth.onAuthStateChanged(async (user) => {
    currentUser = user;
    updateAuthUI(user);
    if (user) {
      logEvent('login', { method: user.providerData?.[0]?.providerId || 'unknown' });
      const loaded = await loadFromCloud(user);
      if (loaded) {
        // Rebuild UI after loading cloud data
        buildTubeBands();
        buildForm();
        buildTimerExerciseSelect();
        buildChartTabs();
        buildLegend();
        render();
      }
      await ensurePseudo();
      refreshSocialLoginGate();
      loadSocialData();
    } else {
      logEvent('logout');
      closePseudoModal();
      stopSocialListeners();
    }
  });

  function openLoginModal() {
    document.getElementById('loginFlash').textContent = '';
    document.getElementById('loginOverlay').classList.add('open');
  }
  function closeLoginModal() {
    document.getElementById('loginOverlay').classList.remove('open');
  }

  document.getElementById('openLoginBtn').addEventListener('click', openLoginModal);
  document.getElementById('closeLoginBtn').addEventListener('click', closeLoginModal);
  document.getElementById('loginOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'loginOverlay') closeLoginModal();
  });

  document.getElementById('pseudoSaveBtn').addEventListener('click', async () => {
    const raw = document.getElementById('pseudoInput').value;
    const flashEl = document.getElementById('pseudoFlash');
    flashEl.textContent = 'Vérification…';
    try {
      await claimPseudo(raw);
      const el = document.getElementById('pseudoOverlay');
      delete el.dataset.force;
      closePseudoModal();
      flash('Pseudo enregistré : @' + state.pseudo);
    } catch (err) {
      flashEl.textContent = err.message || 'Erreur';
    }
  });
  document.getElementById('pseudoOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'pseudoOverlay') closePseudoModal();
  });
  document.getElementById('pseudoInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('pseudoSaveBtn').click();
  });

  document.getElementById('googleLoginBtn').addEventListener('click', async () => {
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      document.getElementById('loginFlash').textContent = 'Connexion Google…';
      await auth.signInWithPopup(provider);
      closeLoginModal();
    } catch (err) {
      console.error(err);
      document.getElementById('loginFlash').textContent = err.message || 'Erreur Google';
    }
  });

  document.getElementById('emailLoginBtn').addEventListener('click', async () => {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!email || !password) {
      document.getElementById('loginFlash').textContent = 'Email et mot de passe requis.';
      return;
    }
    try {
      document.getElementById('loginFlash').textContent = 'Connexion…';
      await auth.signInWithEmailAndPassword(email, password);
      closeLoginModal();
    } catch (err) {
      document.getElementById('loginFlash').textContent = err.code === 'auth/user-not-found'
        ? 'Compte introuvable. Créez-en un.'
        : (err.message || 'Erreur de connexion');
    }
  });

  document.getElementById('emailRegisterBtn').addEventListener('click', async () => {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!email || !password) {
      document.getElementById('loginFlash').textContent = 'Email et mot de passe requis.';
      return;
    }
    if (password.length < 6) {
      document.getElementById('loginFlash').textContent = 'Mot de passe : 6 caractères minimum.';
      return;
    }
    try {
      document.getElementById('loginFlash').textContent = 'Création du compte…';
      await auth.createUserWithEmailAndPassword(email, password);
      closeLoginModal();
    } catch (err) {
      document.getElementById('loginFlash').textContent = err.message || 'Erreur création compte';
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
      await auth.signOut();
      setAuthStatus('Déconnecté — données locales', null);
    } catch (err) {
      setAuthStatus('Erreur déconnexion', 'error');
    }
  });

  /* ========== END FIREBASE ========== */

  const RANKS = [
    { name: "Débutant",           min: 0,    color: "var(--r1)", ink: "var(--r1-ink)" },
    { name: "Bon",                min: 60,   color: "var(--r2)", ink: "var(--r2-ink)" },
    { name: "Sportif",            min: 160,  color: "var(--r3)", ink: "var(--r3-ink)" },
    { name: "Haut niveau",        min: 350,  color: "var(--r4)", ink: "var(--r4-ink)" },
    { name: "Performance extrême",min: 700,  color: "var(--r5)", ink: "var(--r5-ink)" },
    { name: "Hacker",             min: 1200, color: "var(--r6)", ink: "var(--r6-ink)" },
  ];
  const TUBE_CAP = 1200;

  function defaultExercises() {
    return [
      { id: "pompes",    name: "Pompes",    points: 2, unit: "répétition", decimal: false, value: 0 },
      { id: "tractions", name: "Tractions", points: 4, unit: "répétition", decimal: false, value: 0 },
      { id: "abdos",     name: "Abdos",     points: 1, unit: "répétition", decimal: false, value: 0 },
      { id: "course",    name: "Course",    points: 8, unit: "km",         decimal: true,  value: 0 },
      { id: "gainage",   name: "Gainage",   points: 5, unit: "minute",     decimal: true,  value: 0 },
    ];
  }

  function defaultState() {
    return {
      userName: "",
      pseudo: "",
      dayKey: todayKey(),
      exercises: defaultExercises(),
      history: [],
      records: { bestScore: null, perExercise: {} },
      dailyGoal: 150,
      seenBadges: [],
      secretBadgeUnlocked: false,
      hackerCelebratedToday: false,
      difficultyBonus: 0,
      dayNotes: {},
      xp: 0,
      xpClaimedChallenges: []
    };
  }

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + (d.getMonth()+1) + '-' + d.getDate();
  }

  function slugify(name) {
    return 'ex_' + name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'') + '_' + Math.random().toString(36).slice(2,7);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  let state = loadState();
  finalizeDayIfNeeded();

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const base = defaultState();
      let exercises = Array.isArray(parsed.exercises) && parsed.exercises.length ? parsed.exercises : base.exercises;

      if (!exercises.some(ex => ex.id === 'gainage')) {
        exercises = [...exercises, { id: "gainage", name: "Gainage", points: 5, unit: "minute", decimal: true, value: 0 }];
      }

      return {
        userName: typeof parsed.userName === 'string' ? parsed.userName : base.userName,
        pseudo: typeof parsed.pseudo === 'string' ? parsed.pseudo : base.pseudo,
        dayKey: parsed.dayKey || base.dayKey,
        exercises: exercises,
        history: Array.isArray(parsed.history) ? parsed.history : [],
        records: parsed.records && typeof parsed.records === 'object' ? parsed.records : { bestScore: null, perExercise: {} },
        dailyGoal: typeof parsed.dailyGoal === 'number' ? parsed.dailyGoal : base.dailyGoal,
        dayNotes: parsed.dayNotes && typeof parsed.dayNotes === 'object' ? parsed.dayNotes : {},
        xp: typeof parsed.xp === 'number' ? parsed.xp : 0,
        xpClaimedChallenges: Array.isArray(parsed.xpClaimedChallenges) ? parsed.xpClaimedChallenges : [],
        seenBadges: Array.isArray(parsed.seenBadges) ? parsed.seenBadges : null,
        secretBadgeUnlocked: typeof parsed.secretBadgeUnlocked === 'boolean' ? parsed.secretBadgeUnlocked : null,
        hackerCelebratedToday: typeof parsed.hackerCelebratedToday === 'boolean' ? parsed.hackerCelebratedToday : false,
        difficultyBonus: typeof parsed.difficultyBonus === 'number' ? parsed.difficultyBonus : 0
      };
    } catch (e) {
      return defaultState();
    }
  }

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    // Sync to cloud (debounced a little)
    if (currentUser) {
      clearTimeout(window._cloudSaveTimer);
      window._cloudSaveTimer = setTimeout(() => saveToCloud(), 800);
    }
  }

  function computeScore(s) {
    return s.exercises.reduce((sum, ex) => sum + (ex.value * ex.points), 0) + (s.difficultyBonus || 0);
  }

  function getRank(score) {
    let current = RANKS[0], next = RANKS[1];
    for (let i = 0; i < RANKS.length; i++) {
      if (score >= RANKS[i].min) {
        current = RANKS[i];
        next = RANKS[i+1] || null;
      }
    }
    return { current, next };
  }

  function updateRecordsFromToday() {
    const score = computeScore(state);
    const dayLabel = formatDayShort(state.dayKey);
    let newBest = false;
    if (!state.records.bestScore || score > state.records.bestScore.score) {
      state.records.bestScore = { score, day: dayLabel };
      newBest = true;
    }
    state.exercises.forEach(ex => {
      const cur = state.records.perExercise[ex.id];
      if (!cur || ex.value > cur.value) {
        state.records.perExercise[ex.id] = { value: ex.value, day: dayLabel, name: ex.name, unit: ex.unit };
      }
    });
    return newBest;
  }

  function finalizeDayIfNeeded() {
    const key = todayKey();
    if (key !== state.dayKey) {
      const score = computeScore(state);
      if (score > 0) {
        const { current } = getRank(score);
        updateRecordsFromToday();
        const byExercise = {};
        state.exercises.forEach(ex => { byExercise[ex.id] = { value: ex.value, name: ex.name, unit: ex.unit }; });
        state.history.push({ day: state.dayKey, score, rank: current, byExercise });
      }
      state.exercises = state.exercises.map(ex => ({ ...ex, value: 0 }));
      state.difficultyBonus = 0;
      state.dayKey = key;
      state.hackerCelebratedToday = false;
      saveState();
    }
  }

  function formatDayShort(dayKey) {
    const [y,m,d] = dayKey.split('-').map(Number);
    const dt = new Date(y, m-1, d);
    return dt.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
  }

  function buildTubeBands() {
    const tube = document.getElementById('gaugeTube');
    tube.querySelectorAll('.band, .goal-mark').forEach(b => b.remove());
    RANKS.forEach((r, i) => {
      if (i === 0) return;
      const pct = Math.min(100, (r.min / TUBE_CAP) * 100);
      const band = document.createElement('div');
      band.className = 'band';
      band.style.bottom = pct + '%';
      tube.insertBefore(band, document.getElementById('fill'));
    });
    const goalPct = Math.min(100, (state.dailyGoal / TUBE_CAP) * 100);
    const mark = document.createElement('div');
    mark.className = 'goal-mark';
    mark.style.bottom = goalPct + '%';
    tube.appendChild(mark);
  }

  function updateTickLabels(offset) {
    const tickWrap = document.getElementById('tickLabels');
    tickWrap.innerHTML = '';
    [0, 60, 160, 350, 700, 1200].forEach(v => {
      const pct = Math.min(100, (v / TUBE_CAP) * 100);
      const el = document.createElement('div');
      el.className = 'tick';
      el.style.bottom = pct + '%';
      el.textContent = v + offset;
      tickWrap.appendChild(el);
    });
  }

  function buildLegend() {
    const legend = document.getElementById('legend');
    legend.innerHTML = '';
    RANKS.forEach(r => {
      const chip = document.createElement('div');
      chip.className = 'legend-chip';
      chip.innerHTML = `<span class="dot" style="background:${r.color}"></span>${r.name} · ${r.min}+`;
      legend.appendChild(chip);
    });
  }

  function buildForm() {
    const form = document.getElementById('exerciseForm');
    form.innerHTML = '';
    state.exercises.forEach(ex => {
      const field = document.createElement('div');
      field.className = 'field';
      field.innerHTML = `
        <label>${escapeHtml(ex.name)} <span class="pts">${ex.points} pts / ${escapeHtml(ex.unit)}</span></label>
        <input type="number" min="0" ${ex.decimal ? 'step="0.1"' : 'step="1"'} inputmode="${ex.decimal ? 'decimal' : 'numeric'}" placeholder="0" data-ex-id="${ex.id}">
      `;
      form.appendChild(field);
    });
  }

  function isTimeUnit(unit) {
    return /minute|seconde|heure/i.test(unit);
  }

  function buildTimerExerciseSelect() {
    const select = document.getElementById('timerExercise');
    const selectedId = select.value;
    select.innerHTML = '';
    const timeExercises = state.exercises.filter(ex => isTimeUnit(ex.unit));
    const ordered = [...timeExercises].sort((a, b) => (a.id === 'gainage' ? -1 : b.id === 'gainage' ? 1 : 0));

    if (ordered.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Aucun exercice en minute/seconde/heure';
      select.appendChild(option);
      document.getElementById('timerAddBtn').disabled = true;
      return;
    }

    ordered.forEach(ex => {
      const option = document.createElement('option');
      option.value = ex.id;
      option.textContent = `${ex.name} — ${ex.points} pts / ${ex.unit}`;
      select.appendChild(option);
    });
    select.value = ordered.some(ex => ex.id === selectedId) ? selectedId : (ordered.find(ex => ex.id === 'gainage') || ordered[0]).id;
    document.getElementById('timerAddBtn').disabled = false;
  }

  function buildBreakdown() {
    const bd = document.getElementById('breakdown');
    bd.innerHTML = '';
    state.exercises.forEach(ex => {
      const item = document.createElement('div');
      item.className = 'bd-item';
      const displayVal = ex.decimal ? ex.value : Math.round(ex.value);
      item.innerHTML = `<div class="label">${escapeHtml(ex.name)}</div><div class="val">${displayVal} ${escapeHtml(ex.unit)} (${Math.round(ex.value*ex.points)} pts)</div>`;
      bd.appendChild(item);
    });
    if (state.difficultyBonus) {
      const item = document.createElement('div');
      item.className = 'bd-item';
      item.innerHTML = `<div class="label">Bonus difficulté</div><div class="val">+${Math.round(state.difficultyBonus * 10) / 10} pts</div>`;
      bd.appendChild(item);
    }
  }

  function buildRecords() {
    const wrap = document.getElementById('recordsWrap');
    wrap.innerHTML = '';
    if (!state.records.bestScore && Object.keys(state.records.perExercise).length === 0) {
      wrap.innerHTML = '<div class="chart-empty">Vos records apparaîtront ici après votre première journée enregistrée.</div>';
      return;
    }
    if (state.records.bestScore) {
      const row = document.createElement('div');
      row.className = 'record-row';
      row.innerHTML = `<span class="rlabel">Meilleur score en une journée</span><span><span class="rval">${Math.round(state.records.bestScore.score)} pts</span><span class="rday">${state.records.bestScore.day}</span></span>`;
      wrap.appendChild(row);
    }
    Object.values(state.records.perExercise).forEach(rec => {
      if (rec.value <= 0) return;
      const row = document.createElement('div');
      row.className = 'record-row';
      const isDecimalUnit = /km|kilom|litre|heure|minute|seconde/i.test(rec.unit);
      const displayVal = isDecimalUnit ? rec.value : Math.round(rec.value);
      row.innerHTML = `<span class="rlabel">${escapeHtml(rec.name)} — meilleur jour</span><span><span class="rval">${displayVal} ${escapeHtml(rec.unit)}</span><span class="rday">${rec.day}</span></span>`;
      wrap.appendChild(row);
    });
  }

  function computeAllTimeScore() {
    return state.history.reduce((sum, h) => sum + (h.score || 0), 0) + computeScore(state);
  }

  function computeStreak() {
    const activeDays = new Set(state.history.map(h => h.day));
    const todayK = todayKey();
    if (computeScore(state) > 0) activeDays.add(todayK);

    const keyForDate = d => d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    let cursor = new Date();
    if (!activeDays.has(keyForDate(cursor))) {
      cursor.setDate(cursor.getDate() - 1);
    }
    let streak = 0;
    while (activeDays.has(keyForDate(cursor))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  function getBadges() {
    const allTime = computeAllTimeScore();
    const todayScore = computeScore(state);
    const daysCount = state.history.length + (todayScore > 0 ? 1 : 0);
    const streak = computeStreak();
    const perfExtremeMin = RANKS.find(r => r.name === "Performance extrême").min;
    const hackerMin = RANKS.find(r => r.name === "Hacker").min;
    const bestScoreEver = Math.max(todayScore, state.records.bestScore ? state.records.bestScore.score : 0);
    const reachedPerfExtreme = bestScoreEver >= perfExtremeMin;
    const reachedHacker = bestScoreEver >= hackerMin;

    return [
      { id: 'premier-jour',   icon: '🥉', img: 'badges/premier-jour.png',   label: 'Premier jour',                liveDone: daysCount >= 1,     current: daysCount, target: 1,     unit: 'jour' },
      { id: 'une-semaine',    icon: '📅', img: 'badges/une-semaine.png',    label: 'Une semaine d\'affilée',       liveDone: streak >= 7,        current: streak, target: 7,     unit: 'jours' },
      { id: 'un-mois',        icon: '🗓️', img: 'badges/un-mois.png',        label: 'Un mois d\'affilée',           liveDone: streak >= 30,       current: streak, target: 30,    unit: 'jours' },
      { id: 'premier-record', icon: '🏆', img: 'badges/premier-record.png', label: 'Premier record battu',        liveDone: !!state.records.bestScore, current: null, target: null, unit: '' },
      { id: 'perf-extreme',   icon: '👑', img: 'badges/perf-extreme.png',   label: 'Performance extrême atteint', liveDone: reachedPerfExtreme, current: bestScoreEver, target: perfExtremeMin, unit: 'pts' },
      { id: 'hacker',         icon: '🖥️', img: 'badges/hacker.png',         label: 'Rang Hacker atteint',         liveDone: reachedHacker,      current: bestScoreEver, target: hackerMin, unit: 'pts' },
      { id: 'mille-pts',      icon: '🔥', img: 'badges/mille-pts.png',      label: '1 000 pts cumulés',           liveDone: allTime >= 1000,    current: allTime, target: 1000,  unit: 'pts' },
      { id: 'cinq-mille-pts', icon: '⭐', img: 'badges/cinq-mille-pts.png', label: '5 000 pts cumulés',           liveDone: allTime >= 5000,    current: allTime, target: 5000,  unit: 'pts' },
      { id: 'dix-mille-pts',  icon: '🏔️', img: 'badges/dix-mille-pts.png',  label: '10 000 pts cumulés',          liveDone: allTime >= 10000,   current: allTime, target: 10000, unit: 'pts' },
    ];
  }

  function medalIconHtml(b) {
    return `<img src="${b.img}" alt="" onload="this.style.display='block';" onerror="this.style.display='none';">
      <span class="medal-emoji">${b.icon}</span>`;
  }

  function badgeProgressText(b) {
    if (b.done || b.target === null) return '';
    const current = Math.min(Math.round(b.current), b.target);
    return `<div class="medal-progress">${current} / ${b.target} ${b.unit}</div>`;
  }

  function buildBadges() {
    const wrap = document.getElementById('badgesWrap');
    const rawBadges = getBadges();

    if (state.seenBadges === null) {
      state.seenBadges = rawBadges.filter(b => b.liveDone).map(b => b.id);
      saveState();
    } else {
      const newlyUnlocked = rawBadges.filter(b => b.liveDone && !state.seenBadges.includes(b.id));
      if (newlyUnlocked.length) {
        newlyUnlocked.forEach((b, i) => setTimeout(() => showBadgeToast(b), i * 3200));
        state.seenBadges = [...state.seenBadges, ...newlyUnlocked.map(b => b.id)];
        saveState();
      }
    }

    const badges = rawBadges.map(b => ({ ...b, done: state.seenBadges.includes(b.id) }));

    checkSecretBadge(badges);

    const allBadges = badges.slice();
    if (state.secretBadgeUnlocked) {
      allBadges.push({ ...SECRET_BADGE, done: true, current: null, target: null, unit: '' });
    }

    wrap.innerHTML = allBadges.map(b => `
      <div class="medal">
        <div class="medal-circle ${b.done ? 'unlocked' : 'locked'} ${b.id === SECRET_BADGE.id ? 'secret-unlocked' : ''}">${medalIconHtml(b)}</div>
        <div class="medal-label ${b.done ? '' : 'locked'}">${b.label}</div>
        ${badgeProgressText(b)}
      </div>
    `).join('');
  }

  function showBadgeToast(badge) {
    const toast = document.createElement('div');
    toast.className = 'badge-toast';
    toast.innerHTML = `
      <div class="badge-toast-icon">${medalIconHtml(badge)}</div>
      <div class="badge-toast-text">
        <div class="bt-eyebrow">Nouveau badge débloqué</div>
        <div class="bt-title">${badge.label}</div>
      </div>
    `;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 500);
    }, 2800);
  }

  let chartMode = 'score';

  function buildChartTabs() {
    const tabs = document.getElementById('chartTabs');
    tabs.innerHTML = '';
    if (!state.exercises.find(ex => ex.id === chartMode) && chartMode !== 'score') {
      chartMode = 'score';
    }
    const scoreTab = document.createElement('button');
    scoreTab.type = 'button';
    scoreTab.className = 'chart-tab' + (chartMode === 'score' ? ' active' : '');
    scoreTab.textContent = 'Score global';
    scoreTab.addEventListener('click', () => { chartMode = 'score'; buildChartTabs(); buildChart(); });
    tabs.appendChild(scoreTab);

    state.exercises.forEach(ex => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'chart-tab' + (chartMode === ex.id ? ' active' : '');
      tab.textContent = ex.name;
      tab.addEventListener('click', () => { chartMode = ex.id; buildChartTabs(); buildChart(); });
      tabs.appendChild(tab);
    });
  }

  function getChartPoints() {
    if (chartMode === 'score') {
      const points = state.history.slice(-13).map(h => ({ day: formatDayShort(h.day), val: h.score }));
      points.push({ day: "Auj.", val: computeScore(state) });
      return points;
    }
    const ex = state.exercises.find(e => e.id === chartMode);
    const points = state.history.slice(-13).map(h => {
      const rec = h.byExercise && h.byExercise[chartMode];
      return { day: formatDayShort(h.day), val: rec ? rec.value : 0 };
    });
    points.push({ day: "Auj.", val: ex ? ex.value : 0 });
    return points;
  }

  function buildChart() {
    const wrap = document.getElementById('chartWrap');
    const points = getChartPoints();

    if (points.length < 2) {
      wrap.innerHTML = '<div class="chart-empty">Le graphique apparaîtra ici dès que vous aurez au moins un jour d\'historique.</div>';
      return;
    }

    const isScoreMode = chartMode === 'score';
    const w = 560, h = 170, padL = 34, padR = 12, padT = 14, padB = 24;
    const maxVal = Math.max(isScoreMode ? state.dailyGoal : 0, ...points.map(p => p.val), 10) * 1.1;
    const stepX = (w - padL - padR) / (points.length - 1);
    const toX = i => padL + i * stepX;
    const toY = v => padT + (1 - v / maxVal) * (h - padT - padB);

    let path = points.map((p,i) => `${i===0?'M':'L'} ${toX(i).toFixed(1)} ${toY(p.val).toFixed(1)}`).join(' ');

    let goalLine = '';
    if (isScoreMode) {
      const goalY = toY(state.dailyGoal).toFixed(1);
      goalLine = `<line x1="${padL}" y1="${goalY}" x2="${w-padR}" y2="${goalY}" stroke="#EFC24C" stroke-width="1" stroke-dasharray="4 4" opacity="0.6" />`;
    }

    let circles = points.map((p,i) => `<circle cx="${toX(i).toFixed(1)}" cy="${toY(p.val).toFixed(1)}" r="3.5" fill="${i===points.length-1 ? '#EFC24C' : '#9B6DE0'}" />`).join('');
    let labels = points.map((p,i) => `<text x="${toX(i).toFixed(1)}" y="${h-6}" font-size="9" fill="#9A93AD" text-anchor="middle" font-family="IBM Plex Mono, monospace">${p.day}</text>`).join('');

    wrap.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">
      ${goalLine}
      <path d="${path}" fill="none" stroke="#9B6DE0" stroke-width="2.5" />
      ${circles}
      ${labels}
    </svg>`;
  }

  function computeAllTimePointsByExercise() {
    const totalUnits = {};
    state.exercises.forEach(ex => { totalUnits[ex.id] = ex.value; });
    state.history.forEach(h => {
      if (!h.byExercise) return;
      Object.keys(totalUnits).forEach(id => {
        const rec = h.byExercise[id];
        if (rec) totalUnits[id] += rec.value;
      });
    });
    return state.exercises.map(ex => ({
      name: ex.name,
      points: Math.round(totalUnits[ex.id] * ex.points)
    }));
  }

  function buildRadarChart() {
    const wrap = document.getElementById('radarWrap');
    const data = computeAllTimePointsByExercise();

    if (data.length < 3) {
      wrap.innerHTML = '<div class="chart-empty">Ajoutez au moins 3 exercices pour voir la vue en étoile.</div>';
      return;
    }

    const n = data.length;
    const w = 340, h = 360;
    const cx = w / 2, cy = 165;
    const R = 95;
    const maxVal = Math.max(...data.map(d => d.points), 10) * 1.15;

    function pointFor(i, ratio) {
      const angle = -Math.PI / 2 + i * (2 * Math.PI / n);
      const r = R * ratio;
      return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
    }

    let gridPolys = '';
    [0.25, 0.5, 0.75, 1].forEach(frac => {
      const pts = data.map((_, i) => pointFor(i, frac).join(',')).join(' ');
      gridPolys += `<polygon points="${pts}" fill="none" stroke="#322B44" stroke-width="1" opacity="0.6"/>`;
    });

    const axisLines = data.map((_, i) => {
      const [x, y] = pointFor(i, 1);
      return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#322B44" stroke-width="1" opacity="0.6"/>`;
    }).join('');

    const dataPts = data.map((d, i) => pointFor(i, Math.min(1, d.points / maxVal)).map(v => v.toFixed(1)).join(',')).join(' ');
    const dataPoly = `<polygon points="${dataPts}" fill="rgba(155,109,224,0.28)" stroke="#9B6DE0" stroke-width="2.5"/>`;
    const dataCircles = data.map((d, i) => {
      const [x, y] = pointFor(i, Math.min(1, d.points / maxVal));
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="#EFC24C" />`;
    }).join('');

    const labels = data.map((d, i) => {
      const [x, y] = pointFor(i, 1.3);
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="10" fill="#9A93AD" text-anchor="middle" font-family="IBM Plex Mono, monospace">${escapeHtml(d.name)}</text>
              <text x="${x.toFixed(1)}" y="${(y+12).toFixed(1)}" font-size="10" fill="#EFC24C" font-weight="700" text-anchor="middle" font-family="IBM Plex Mono, monospace">${d.points} pts</text>`;
    }).join('');

    wrap.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" style="max-width: 340px;">
      ${gridPolys}
      ${axisLines}
      ${dataPoly}
      ${dataCircles}
      ${labels}
    </svg>`;
  }

  function render() {
    const score = computeScore(state);
    const { current, next } = getRank(score);
    checkHackerRank(score);

    document.getElementById('greeting').textContent = state.userName ? `Bonjour, ${state.userName}` : "Bonjour";

    document.getElementById('scoreReadout').innerHTML = Math.round(score) + '<span> pts</span>';

    const pill = document.getElementById('rankPill');
    pill.textContent = current.name;
    pill.style.background = current.color;
    pill.style.color = current.ink;

    const fill = document.getElementById('fill');
    let laps = 0;
    let remainder = score;
    if (score > 0) {
      if (score % TUBE_CAP === 0) {
        laps = (score / TUBE_CAP) - 1;
        remainder = TUBE_CAP;
      } else {
        laps = Math.floor(score / TUBE_CAP);
        remainder = score % TUBE_CAP;
      }
    }
    const pct = Math.min(100, (remainder / TUBE_CAP) * 100);
    fill.style.height = pct + '%';
    fill.classList.toggle('extreme', current.name === "Performance extrême");
    fill.classList.toggle('hacker', current.name === "Hacker");
    if (current.name === "Performance extrême" || current.name === "Hacker") {
      fill.style.background = '';
      fill.style.boxShadow = '';
    } else {
      fill.style.background = current.color;
      fill.style.boxShadow = 'none';
    }

    const lapBadge = document.getElementById('lapBadge');
    lapBadge.classList.toggle('show', laps >= 1);
    lapBadge.textContent = '×' + (laps + 1);
    updateTickLabels(laps * TUBE_CAP);

    document.getElementById('gaugeTube').classList.toggle('overflow', laps >= 1);

    const progressText = document.getElementById('progressText');
    const barFill = document.getElementById('barFill');
    if (next) {
      const span = next.min - current.min;
      const done = Math.min(span, score - current.min);
      progressText.textContent = `${Math.round(score)} / ${next.min} pts vers ${next.name}`;
      barFill.style.width = Math.max(0, (done/span)*100) + '%';
      barFill.style.background = next.color;
    } else {
      progressText.textContent = `Rang maximal atteint — ${Math.round(score)} pts`;
      barFill.style.width = '100%';
      barFill.style.background = current.color;
    }

    const goalPct = state.dailyGoal > 0 ? Math.min(100, (score / state.dailyGoal) * 100) : 0;
    document.getElementById('goalText').textContent = score >= state.dailyGoal && state.dailyGoal > 0
      ? `Objectif du jour atteint — ${Math.round(score)} / ${state.dailyGoal} pts 🎉`
      : `Objectif du jour : ${Math.round(score)} / ${state.dailyGoal} pts`;
    document.getElementById('goalBarFill').style.width = goalPct + '%';

    buildBreakdown();
    buildRecords();
    buildBadges();
    buildChart();
    buildRadarChart();

    document.getElementById('dateBadge').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short' });

    renderHistory();
    if (document.getElementById('section-calendar')?.classList.contains('active') ||
        document.getElementById('section-calendar')?.style.display === 'block') {
      renderCalendar();
    }
    saveState();
  }

  /* ---- CALENDRIER ---- */
  let calView = new Date(); // mois affiché
  let calSelectedKey = null;

  function scoreForDay(dayKey) {
    if (dayKey === state.dayKey) return Math.round(computeScore(state));
    const h = (state.history || []).find(x => x.day === dayKey);
    return h ? Math.round(h.score || 0) : null;
  }

  function renderCalendar() {
    const grid = document.getElementById('calGrid');
    const label = document.getElementById('calMonthLabel');
    if (!grid || !label) return;

    const year = calView.getFullYear();
    const month = calView.getMonth(); // 0-11
    label.textContent = calView.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

    // Lundi = 0 ... Dimanche = 6
    const first = new Date(year, month, 1);
    let startPad = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayK = todayKey();

    grid.innerHTML = '';
    for (let i = 0; i < startPad; i++) {
      const empty = document.createElement('div');
      empty.className = 'cal-day empty';
      grid.appendChild(empty);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const key = year + '-' + (month + 1) + '-' + d;
      const sc = scoreForDay(key);
      const note = (state.dayNotes && state.dayNotes[key]) || '';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cal-day';
      if (key === todayK) btn.classList.add('today');
      if (sc !== null && sc > 0) btn.classList.add('has-score');
      if (note) btn.classList.add('has-note');
      if (key === calSelectedKey) btn.classList.add('selected');
      btn.innerHTML = `<span class="cd-num">${d}</span>` +
        (sc !== null && sc > 0 ? `<span class="cd-score">${sc}</span>` : '');
      btn.addEventListener('click', () => selectCalDay(key));
      grid.appendChild(btn);
    }
  }

  function selectCalDay(key) {
    calSelectedKey = key;
    renderCalendar();
    const title = document.getElementById('calDetailTitle');
    const scoreEl = document.getElementById('calDetailScore');
    const noteInput = document.getElementById('calNoteInput');
    const flash = document.getElementById('calFlash');
    if (flash) flash.textContent = '';

    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    title.textContent = date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    const sc = scoreForDay(key);
    if (key === state.dayKey) {
      scoreEl.textContent = sc > 0
        ? `Score du jour (en cours) : ${sc} pts — objectif ${state.dailyGoal} pts`
        : `Aujourd’hui — pas encore de points (objectif ${state.dailyGoal} pts)`;
    } else if (sc !== null && sc > 0) {
      scoreEl.textContent = `Score : ${sc} pts`;
    } else {
      scoreEl.textContent = 'Aucun score enregistré ce jour-là';
    }
    noteInput.value = (state.dayNotes && state.dayNotes[key]) || '';
  }

  function saveCalNote() {
    if (!calSelectedKey) {
      document.getElementById('calFlash').textContent = 'Choisis un jour d’abord.';
      return;
    }
    if (!state.dayNotes) state.dayNotes = {};
    const text = (document.getElementById('calNoteInput').value || '').trim();
    if (text) state.dayNotes[calSelectedKey] = text;
    else delete state.dayNotes[calSelectedKey];
    saveState();
    renderCalendar();
    document.getElementById('calFlash').textContent = 'Note enregistrée.';
    logEvent('day_note_saved');
  }

  /* ---- XP / PROFIL ---- */
  function xpForLevel(level) {
    // XP total needed to REACH this level (level 1 = 0)
    return Math.floor(50 * Math.pow(level - 1, 1.65));
  }
  function levelFromXp(xp) {
    let level = 1;
    while (xpForLevel(level + 1) <= xp && level < 99) level++;
    return level;
  }
  function awardXp(amount, reason) {
    if (!amount || amount <= 0) return;
    state.xp = (state.xp || 0) + amount;
    saveState();
    logEvent('xp_gain', { amount, reason: reason || '' });
    if (typeof flash === 'function') flash('+' + amount + ' XP' + (reason ? ' — ' + reason : ''));
    else if (typeof socialFlash === 'function') socialFlash('+' + amount + ' XP', 'ok');
  }
  function tryClaimChallengeXp(ch) {
    if (!currentUser || !ch || ch.status !== 'completed') return;
    if (!state.xpClaimedChallenges) state.xpClaimedChallenges = [];
    if (state.xpClaimedChallenges.includes(ch.id)) return;
    const uid = currentUser.uid;
    if (ch.fromUid !== uid && ch.toUid !== uid) return;
    let amount = 10;
    let reason = 'Défi terminé';
    if (ch.winnerUid === uid) { amount = 50; reason = 'Défi gagné'; }
    else if (ch.winnerUid === 'draw') { amount = 25; reason = 'Défi égalité'; }
    state.xpClaimedChallenges.push(ch.id);
    // garde une liste raisonnable
    if (state.xpClaimedChallenges.length > 200) {
      state.xpClaimedChallenges = state.xpClaimedChallenges.slice(-150);
    }
    awardXp(amount, reason);
  }
  async function renderProfile() {
    const pseudoEl = document.getElementById('profilePseudo');
    const emailEl = document.getElementById('profileEmail');
    const avatarEl = document.getElementById('profileAvatar');
    if (!pseudoEl) return;

    const pseudo = state.pseudo || (currentUser && (currentUser.displayName || currentUser.email?.split('@')[0])) || 'Invité';
    pseudoEl.textContent = state.pseudo ? '@' + state.pseudo : pseudo;
    emailEl.textContent = currentUser?.email || (currentUser ? 'Connecté' : 'Données locales');
    avatarEl.textContent = (state.pseudo || pseudo || '?').slice(0, 1).toUpperCase();

    const xp = state.xp || 0;
    const level = levelFromXp(xp);
    const curFloor = xpForLevel(level);
    const nextFloor = xpForLevel(level + 1);
    const span = Math.max(1, nextFloor - curFloor);
    const pct = Math.min(100, ((xp - curFloor) / span) * 100);

    document.getElementById('profileLevel').textContent = 'Niveau ' + level;
    document.getElementById('profileXpText').textContent = xp + ' XP';
    document.getElementById('profileXpFill').style.width = pct + '%';
    document.getElementById('profileXpHint').textContent =
      (nextFloor - xp) + ' XP pour le niveau ' + (level + 1);

    // Stats défis depuis le cache
    let won = 0, played = 0;
    if (typeof cachedChallenges === 'object' && cachedChallenges) {
      Object.values(cachedChallenges).forEach(ch => {
        if (!currentUser) return;
        if (ch.status !== 'completed') return;
        if (ch.fromUid !== currentUser.uid && ch.toUid !== currentUser.uid) return;
        played++;
        if (ch.winnerUid === currentUser.uid) won++;
        tryClaimChallengeXp(ch);
      });
    }
    document.getElementById('statChallengesWon').textContent = String(won);
    document.getElementById('statChallengesPlayed').textContent = String(played);

    // Amis
    let friendsCount = 0;
    if (currentUser) {
      try {
        const snap = await db.collection('users').doc(currentUser.uid).collection('friends').get();
        friendsCount = snap.size;
      } catch (e) {}
    }
    document.getElementById('statFriends').textContent = String(friendsCount);

    const days = (state.history || []).length + (computeScore(state) > 0 ? 1 : 0);
    document.getElementById('statDays').textContent = String(days);
  }

  function renderHistory() {
    const wrap = document.getElementById('historyWrap');
    if (state.history.length === 0) {
      wrap.innerHTML = '<div class="history-empty">Rien pour l\'instant — vos jours précédents apparaîtront ici.</div>';
      return;
    }
    const list = document.createElement('div');
    list.className = 'history-list';
    state.history.slice().reverse().forEach(h => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = `<div class="day">${formatDayShort(h.day)}</div><div class="pts">${Math.round(h.score)}</div><div class="rank" style="color:${h.rank.ink}">${h.rank.name}</div>`;
      list.appendChild(item);
    });
    wrap.innerHTML = '';
    wrap.appendChild(list);
  }

  function flash(msg) {
    const el = document.getElementById('flashMsg');
    el.textContent = msg;
    setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2200);
  }

  /* ---- TIMER ---- */
  let timerElapsedMs = 0;
  let timerStartedAt = null;
  let timerInterval = null;
  let lastBeepMarker = 0;
  let timerAudioContext = null;

  const TIMER_BEEP_KEY = 'note_journaliere_timer_beep';
  const TIMER_BEEP_INTERVAL_KEY = 'note_journaliere_timer_beep_interval';
  const timerBeepToggle = document.getElementById('timerBeepToggle');
  const timerBeepInterval = document.getElementById('timerBeepInterval');
  try { timerBeepToggle.checked = localStorage.getItem(TIMER_BEEP_KEY) === '1'; } catch (e) {}
  try { timerBeepInterval.value = localStorage.getItem(TIMER_BEEP_INTERVAL_KEY) || '30'; } catch (e) {}
  timerBeepToggle.addEventListener('change', () => {
    try { localStorage.setItem(TIMER_BEEP_KEY, timerBeepToggle.checked ? '1' : '0'); } catch (e) {}
  });
  timerBeepInterval.addEventListener('change', () => {
    lastBeepMarker = Math.floor(currentTimerMs() / beepIntervalMs());
    try { localStorage.setItem(TIMER_BEEP_INTERVAL_KEY, timerBeepInterval.value); } catch (e) {}
  });

  function beepIntervalMs() {
    return (parseInt(timerBeepInterval.value, 10) || 30) * 1000;
  }

  function currentTimerMs() {
    return timerElapsedMs + (timerStartedAt ? Date.now() - timerStartedAt : 0);
  }

  function formatTimer(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const hours = Math.floor(minutes / 60);
    const mm = String(minutes % 60).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    return hours > 0 ? `${String(hours).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function renderTimer() {
    const elapsed = currentTimerMs();
    document.getElementById('timerDisplay').textContent = formatTimer(elapsed);
    const marker = Math.floor(elapsed / beepIntervalMs());
    if (timerStartedAt && timerBeepToggle.checked && marker > 0 && marker > lastBeepMarker) {
      lastBeepMarker = marker;
      playTimerBeep();
    }
  }

  function playTimerBeep() {
    try {
      timerAudioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = timerAudioContext.createOscillator();
      const gain = timerAudioContext.createGain();
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, timerAudioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.14, timerAudioContext.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, timerAudioContext.currentTime + 0.16);
      oscillator.connect(gain).connect(timerAudioContext.destination);
      oscillator.start();
      oscillator.stop(timerAudioContext.currentTime + 0.18);
    } catch (e) {}
  }

  function prepareTimerAudio() {
    if (!timerBeepToggle.checked) return;
    try {
      timerAudioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      if (timerAudioContext.state === 'suspended') timerAudioContext.resume();
    } catch (e) {}
  }

  function setTimerFlash(message) {
    const el = document.getElementById('timerFlash');
    el.textContent = message;
    setTimeout(() => { if (el.textContent === message) el.textContent = ''; }, 2600);
  }

  function pauseTimer() {
    if (!timerStartedAt) return;
    timerElapsedMs = currentTimerMs();
    timerStartedAt = null;
    clearInterval(timerInterval);
    timerInterval = null;
    document.getElementById('timerStartBtn').textContent = 'Reprendre';
    document.getElementById('timerStatus').textContent = 'Chronomètre en pause';
    renderTimer();
  }

  document.getElementById('timerStartBtn').addEventListener('click', () => {
    if (timerStartedAt) {
      pauseTimer();
      return;
    }
    prepareTimerAudio();
    timerStartedAt = Date.now();
    lastBeepMarker = Math.floor(timerElapsedMs / beepIntervalMs());
    timerInterval = setInterval(renderTimer, 250);
    document.getElementById('timerStartBtn').textContent = 'Pause';
    document.getElementById('timerStatus').textContent = 'Chronomètre en cours';
    renderTimer();
  });

  document.getElementById('timerResetBtn').addEventListener('click', () => {
    pauseTimer();
    timerElapsedMs = 0;
    lastBeepMarker = 0;
    document.getElementById('timerStartBtn').textContent = 'Démarrer';
    document.getElementById('timerStatus').textContent = 'Prêt pour votre activité';
    renderTimer();
  });

  document.getElementById('timerAddBtn').addEventListener('click', () => {
    pauseTimer();
    if (timerElapsedMs < 1000) {
      setTimerFlash('Chronométrez au moins une seconde avant d’ajouter au score.');
      return;
    }
    const exercise = state.exercises.find(ex => ex.id === document.getElementById('timerExercise').value);
    if (!exercise || !isTimeUnit(exercise.unit)) {
      setTimerFlash('Choisissez un exercice en minute, seconde ou heure.');
      return;
    }
    let addedValue;
    if (/heure/i.test(exercise.unit)) {
      addedValue = timerElapsedMs / 3600000;
    } else if (/minute/i.test(exercise.unit)) {
      addedValue = timerElapsedMs / 60000;
    } else {
      addedValue = timerElapsedMs / 1000;
    }
    addedValue = Math.round(addedValue * 100) / 100;
    const gainedPoints = Math.round(addedValue * exercise.points * 100) / 100;
    exercise.value = Math.round((exercise.value + addedValue) * 100) / 100;
    updateRecordsFromToday();
    render();
    setTimerFlash(`${formatTimer(timerElapsedMs)} ajouté à ${exercise.name} : +${gainedPoints} pts.`);
    timerElapsedMs = 0;
    lastBeepMarker = 0;
    document.getElementById('timerStartBtn').textContent = 'Démarrer';
    document.getElementById('timerStatus').textContent = 'Temps ajouté au score';
    renderTimer();
  });

  function spawnConfetti(count) {
    const colors = ['#9B6DE0', '#EFC24C', '#D9455A', '#45AD7A', '#5FA9D6'];
    for (let i = 0; i < count; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + 'vw';
      piece.style.background = colors[Math.floor(Math.random() * colors.length)];
      piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
      const duration = 1.8 + Math.random() * 1.4;
      const delay = Math.random() * 0.4;
      piece.style.animationDuration = duration + 's';
      piece.style.animationDelay = delay + 's';
      document.body.appendChild(piece);
      setTimeout(() => piece.remove(), (duration + delay) * 1000 + 200);
    }
  }

  function celebrateRecord() {
    spawnConfetti(60);

    const banner = document.createElement('div');
    banner.className = 'record-banner';
    banner.textContent = "🏆 Nouveau record personnel !";
    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add('show'));
    setTimeout(() => {
      banner.classList.remove('show');
      setTimeout(() => banner.remove(), 500);
    }, 2600);
  }

  const SECRET_BADGE = { id: 'collectionneur', icon: '💎', img: 'badges/collectionneur.png', label: 'Collectionneur — tous les badges obtenus' };

  function celebrateSecretBadge(badge) {
    const overlay = document.createElement('div');
    overlay.className = 'secret-overlay';
    overlay.innerHTML = `
      <div class="secret-medal-wrap">
        <div class="secret-medal">${medalIconHtml(badge)}</div>
        <div class="secret-title">Badge secret débloqué !</div>
        <div class="secret-sub">${badge.label}</div>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    spawnConfetti(50);
    setTimeout(() => spawnConfetti(40), 500);

    const dismiss = () => {
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 500);
    };
    overlay.addEventListener('click', dismiss);
    setTimeout(dismiss, 4200);
  }

  function checkSecretBadge(regularBadges) {
    const allDone = regularBadges.every(b => b.done);

    if (state.secretBadgeUnlocked === null) {
      state.secretBadgeUnlocked = allDone;
      saveState();
      return;
    }
    if (allDone && !state.secretBadgeUnlocked) {
      state.secretBadgeUnlocked = true;
      saveState();
      celebrateSecretBadge(SECRET_BADGE);
    }
  }

  function celebrateHackerRank() {
    const overlay = document.createElement('div');
    overlay.className = 'hacker-overlay';
    overlay.innerHTML = `
      <div class="hacker-scanlines"></div>
      <div class="hacker-text-wrap">
        <div class="hacker-title" id="hackerTitleText">🖥️ RANG HACKER</div>
        <div class="hacker-sub">Système compromis — 1200 pts atteints</div>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add('show', 'glitching');
      document.getElementById('hackerTitleText').classList.add('glitching');
    });
    setTimeout(() => {
      overlay.classList.remove('glitching');
      const t = document.getElementById('hackerTitleText');
      if (t) t.classList.remove('glitching');
    }, 950);

    const dismiss = () => {
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 400);
    };
    overlay.addEventListener('click', dismiss);
    setTimeout(dismiss, 4500);
  }

  function checkHackerRank(score) {
    const hackerMin = RANKS.find(r => r.name === "Hacker").min;
    if (score >= hackerMin && !state.hackerCelebratedToday) {
      state.hackerCelebratedToday = true;
      saveState();
      celebrateHackerRank();
      logEvent('rank_hacker');
    }
  }

  const DIFFICULTY_LEVELS = [
    { level: "facile",        name: "Facile",         bonusPct: 0,  desc: "Aucun bonus" },
    { level: "modere",        name: "Modéré",         bonusPct: 10, desc: "+10 % de points" },
    { level: "difficile",     name: "Difficile",      bonusPct: 25, desc: "+25 % de points" },
    { level: "tresdifficile", name: "Très difficile", bonusPct: 50, desc: "+50 % de points" }
  ];

  let pendingEntries = null;

  function getFormEntries() {
    const inputs = document.querySelectorAll('#exerciseForm input[data-ex-id]');
    const entries = [];
    inputs.forEach(inp => {
      const v = parseFloat(inp.value) || 0;
      if (v !== 0) entries.push({ id: inp.dataset.exId, v });
    });
    return entries;
  }

  function openDifficultyModal(entries) {
    let basePoints = 0;
    const parts = entries.map(e => {
      const ex = state.exercises.find(x => x.id === e.id);
      if (!ex) return '';
      basePoints += e.v * ex.points;
      const shownVal = ex.decimal ? e.v : Math.round(e.v);
      return `${escapeHtml(ex.name)} : ${shownVal} ${escapeHtml(ex.unit)}`;
    }).filter(Boolean).join(' · ');

    document.getElementById('difficultySummary').innerHTML =
      `${parts} <br><b>${Math.round(basePoints * 10) / 10} pts</b> de base avant bonus.`;

    const grid = document.getElementById('difficultyGrid');
    grid.innerHTML = '';
    DIFFICULTY_LEVELS.forEach(d => {
      const btn = document.createElement('button');
      btn.className = 'difficulty-btn';
      btn.dataset.level = d.level;
      const bonusPts = Math.round(basePoints * (d.bonusPct / 100) * 10) / 10;
      btn.innerHTML = `<span class="diff-name">${d.name}</span><span class="diff-bonus">${d.bonusPct === 0 ? "Aucun bonus" : "+" + bonusPts + " pts (" + d.desc + ")"}</span>`;
      btn.addEventListener('click', () => commitEntries(entries, d));
      grid.appendChild(btn);
    });

    document.getElementById('difficultyOverlay').classList.add('open');
  }

  function closeDifficultyModal() {
    document.getElementById('difficultyOverlay').classList.remove('open');
    pendingEntries = null;
  }

  function commitEntries(entries, difficulty) {
    const prevBest = state.records.bestScore ? state.records.bestScore.score : 0;
    let basePoints = 0;
    entries.forEach(e => {
      const ex = state.exercises.find(x => x.id === e.id);
      if (ex) {
        basePoints += e.v * ex.points;
        ex.value = Math.round((ex.value + e.v) * 10) / 10;
      }
    });

    const bonus = difficulty ? Math.round(basePoints * (difficulty.bonusPct / 100) * 10) / 10 : 0;
    if (bonus) {
      state.difficultyBonus = Math.round(((state.difficultyBonus || 0) + bonus) * 10) / 10;
    }

    document.querySelectorAll('#exerciseForm input[data-ex-id]').forEach(inp => inp.value = '');
    const gotNewBest = updateRecordsFromToday();
    render();
    closeDifficultyModal();

    if (gotNewBest && prevBest > 0) {
      celebrateRecord();
      logEvent('new_record');
    } else if (bonus > 0) {
      flash(`Ajouté au score du jour (+${bonus} pts bonus ${difficulty.name.toLowerCase()}).`);
    } else {
      flash("Ajouté au score du jour.");
    }
    logEvent('score_added', { points: Math.round(basePoints + bonus), difficulty: difficulty ? difficulty.level : 'none' });
  }

  document.getElementById('addBtn').addEventListener('click', () => {
    const entries = getFormEntries();
    if (entries.length === 0) {
      flash("Entrez au moins une valeur avant d'ajouter.");
      return;
    }
    pendingEntries = entries;
    openDifficultyModal(entries);
  });

  document.getElementById('difficultySkipBtn').addEventListener('click', () => {
    if (pendingEntries) commitEntries(pendingEntries, null);
  });

  document.getElementById('difficultyOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'difficultyOverlay') closeDifficultyModal();
  });

  setInterval(() => {
    const before = state.dayKey;
    finalizeDayIfNeeded();
    if (before !== state.dayKey) {
      buildTubeBands();
      buildForm();
      buildChartTabs();
      render();
      flash("Nouveau jour — le score a été remis à zéro.");
    }
  }, 30000);

  const TIPS = [
    { type: "sport", text: "Hydratez-vous avant et après l'effort, pas seulement pendant." },
    { type: "sport", text: "Échauffez-vous bien pour éviter les blessures, même sur une séance courte." },
    { type: "sport", text: "Étirez-vous doucement après l'effort pour favoriser la récupération." },
    { type: "sport", text: "Respectez au moins un jour de repos entre deux séances intenses." },
    { type: "sport", text: "Dormez suffisamment : c'est pendant le sommeil que le muscle progresse." },
    { type: "sport", text: "Une bonne technique compte plus que le nombre de répétitions." },
    { type: "sport", text: "Écoutez votre corps — une douleur vive n'est jamais normale." },
    { type: "sport", text: "Variez les exercices pour éviter les déséquilibres musculaires." },
    { type: "nutrition", text: "Mangez des protéines dans l'heure qui suit l'effort pour bien récupérer." },
    { type: "nutrition", text: "Buvez de l'eau régulièrement dans la journée, pas seulement pendant le sport." },
    { type: "nutrition", text: "Un fruit et des glucides complexes avant l'effort évitent le coup de fatigue." },
    { type: "nutrition", text: "Évitez de vous entraîner à jeun sur un effort long ou intense." },
    { type: "nutrition", text: "Les féculents complets (riz, pâtes, avoine) rechargent bien vos réserves d'énergie." },
    { type: "nutrition", text: "Pensez aux électrolytes (sel, potassium) lors d'un effort long ou par forte chaleur." }
  ];
  let tipIndex = 0;

  function rotateTip() {
    const el = document.getElementById('tipText');
    const lbl = document.getElementById('tipLabel');
    el.classList.add('fading');
    setTimeout(() => {
      tipIndex = (tipIndex + 1) % TIPS.length;
      el.textContent = TIPS[tipIndex].text;
      lbl.textContent = TIPS[tipIndex].type === 'nutrition' ? 'Conseil nutrition' : 'Conseil sportif';
      el.classList.remove('fading');
    }, 400);
  }

  function initTips() {
    document.getElementById('tipText').textContent = TIPS[0].text;
    document.getElementById('tipLabel').textContent = TIPS[0].type === 'nutrition' ? 'Conseil nutrition' : 'Conseil sportif';
    setInterval(rotateTip, 7000);
  }

  function exportFlash(msg) {
    const el = document.getElementById('exportFlash');
    el.textContent = msg;
    setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2500);
  }

  document.getElementById('copyBtn').addEventListener('click', () => {
    const score = computeScore(state);
    const { current } = getRank(score);
    const dateStr = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    let lines = state.exercises.map(ex => `${ex.name} : ${ex.decimal ? ex.value : Math.round(ex.value)} ${ex.unit} (${Math.round(ex.value*ex.points)} pts)`).join("\n");
    const name = state.userName ? ` (${state.userName})` : "";
    const summary = `Note journalière${name} — ${dateStr}\n${lines}\nScore total : ${Math.round(score)} pts — Rang : ${current.name}`;

    const textarea = document.getElementById('summaryTextarea');
    textarea.value = summary;
    document.getElementById('summaryOverlay').classList.add('open');
    textarea.focus();
    textarea.select();

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(summary).catch(() => {});
    }
  });

  document.getElementById('closeSummaryBtn').addEventListener('click', () => {
    document.getElementById('summaryOverlay').classList.remove('open');
  });
  document.getElementById('summaryOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'summaryOverlay') document.getElementById('summaryOverlay').classList.remove('open');
  });

  document.getElementById('copyFromModalBtn').addEventListener('click', () => {
    const textarea = document.getElementById('summaryTextarea');
    textarea.focus();
    textarea.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(textarea.value).catch(() => {});
    }
    exportFlash(ok ? "Copié !" : "Sélectionné — utilisez Ctrl+C pour copier.");
  });

  function csvEscape(field) {
    const str = String(field);
    if (/[",\n]/.test(str)) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  document.getElementById('exportBtn').addEventListener('click', () => {
    const score = computeScore(state);
    const { current } = getRank(score);
    const exNames = state.exercises.map(e => e.name);
    const rows = [["jour", ...exNames, "score", "rang"]];
    rows.push([state.dayKey + " (en cours)", ...state.exercises.map(e => e.value), Math.round(score), current.name]);
    state.history.forEach(h => {
      const values = state.exercises.map(e => {
        const rec = h.byExercise && h.byExercise[e.id];
        return rec ? rec.value : "";
      });
      rows.push([h.day, ...values, Math.round(h.score), h.rank.name]);
    });

    const csv = rows.map(r => r.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "note-journaliere-historique.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    exportFlash("Fichier téléchargé — vous pouvez me l'envoyer dans le chat.");
  });

  /* ---- SAUVEGARDE COMPLÈTE (JSON) ---- */
  document.getElementById('backupExportBtn').addEventListener('click', () => {
    const backup = {
      type: "note-journaliere-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      data: state
    };
    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "note-journaliere-sauvegarde.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    exportFlash("Sauvegarde téléchargée — gardez ce fichier pour la restaurer sur un autre appareil.");
  });

  document.getElementById('backupImportBtn').addEventListener('click', () => {
    document.getElementById('backupFileInput').click();
  });

  document.getElementById('backupFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (err) {
        exportFlash("Fichier invalide — ce n'est pas une sauvegarde reconnue.");
        e.target.value = '';
        return;
      }

      const incoming = parsed && parsed.data ? parsed.data : parsed;
      if (!incoming || !Array.isArray(incoming.exercises)) {
        exportFlash("Fichier invalide — ce n'est pas une sauvegarde reconnue.");
        e.target.value = '';
        return;
      }

      const ok = confirm("Restaurer cette sauvegarde va remplacer toutes vos données actuelles (exercices, historique, records, badges). Continuer ?");
      e.target.value = '';
      if (!ok) return;

      const base = defaultState();
      state = {
        userName: typeof incoming.userName === 'string' ? incoming.userName : base.userName,
        pseudo: typeof incoming.pseudo === 'string' ? incoming.pseudo : base.pseudo,
        dayKey: incoming.dayKey || base.dayKey,
        exercises: Array.isArray(incoming.exercises) && incoming.exercises.length ? incoming.exercises : base.exercises,
        history: Array.isArray(incoming.history) ? incoming.history : [],
        records: incoming.records && typeof incoming.records === 'object' ? incoming.records : { bestScore: null, perExercise: {} },
        dailyGoal: typeof incoming.dailyGoal === 'number' ? incoming.dailyGoal : base.dailyGoal,
        seenBadges: Array.isArray(incoming.seenBadges) ? incoming.seenBadges : null,
        secretBadgeUnlocked: typeof incoming.secretBadgeUnlocked === 'boolean' ? incoming.secretBadgeUnlocked : null
      };

      if (!state.exercises.some(ex => ex.id === 'gainage')) {
        state.exercises = [...state.exercises, { id: "gainage", name: "Gainage", points: 5, unit: "minute", decimal: true, value: 0 }];
      }

      finalizeDayIfNeeded();
      buildTubeBands();
      buildForm();
      buildTimerExerciseSelect();
      buildChartTabs();
      buildLegend();
      render();
      exportFlash("Sauvegarde restaurée avec succès !");
    };
    reader.readAsText(file);
  });

  /* ---- SETTINGS MODAL ---- */
  let editBuffer = [];

  function openEditModal() {
    document.getElementById('settingsName').value = state.userName || "";
    const pseudoInput = document.getElementById('settingsPseudo');
    if (pseudoInput) {
      pseudoInput.value = state.pseudo || "";
      pseudoInput.disabled = !currentUser;
      document.getElementById('settingsPseudoHint').textContent = currentUser
        ? '3 à 20 caractères : lettres, chiffres, _ — unique'
        : 'Connecte-toi pour définir un pseudo public';
    }
    document.getElementById('settingsGoal').value = state.dailyGoal;
    editBuffer = state.exercises.map(ex => ({ ...ex }));
    renderEditList();
    document.getElementById('modalOverlay').classList.add('open');
  }

  function closeEditModal() {
    document.getElementById('modalOverlay').classList.remove('open');
  }

  function renderEditList() {
    const list = document.getElementById('exEditList');
    list.innerHTML = '';
    editBuffer.forEach((ex, idx) => {
      const row = document.createElement('div');
      row.className = 'ex-row';
      row.innerHTML = `
        <input type="text" value="${escapeHtml(ex.name)}" data-field="name" data-idx="${idx}">
        <input type="number" min="0" step="0.5" value="${escapeHtml(ex.points)}" data-field="points" data-idx="${idx}">
        <input type="text" value="${escapeHtml(ex.unit)}" data-field="unit" data-idx="${idx}">
        <button class="remove-btn" data-remove="${idx}" title="Supprimer">×</button>
      `;
      list.appendChild(row);
    });

    list.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('input', (e) => {
        const idx = parseInt(e.target.dataset.idx, 10);
        const field = e.target.dataset.field;
        if (field === 'points') {
          editBuffer[idx][field] = parseFloat(e.target.value) || 0;
        } else {
          editBuffer[idx][field] = e.target.value;
        }
      });
    });

    list.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.remove, 10);
        editBuffer.splice(idx, 1);
        renderEditList();
      });
    });
  }

  document.getElementById('addExBtn').addEventListener('click', () => {
    editBuffer.push({ id: slugify('exercice'), name: "Nouvel exercice", points: 1, unit: "répétition", decimal: false, value: 0 });
    renderEditList();
  });

  document.getElementById('renameLink').addEventListener('click', openEditModal);
  document.getElementById('cancelEditBtn').addEventListener('click', closeEditModal);
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'modalOverlay') closeEditModal();
  });

  document.getElementById('saveEditBtn').addEventListener('click', async () => {
    const cleaned = editBuffer
      .filter(ex => ex.name.trim() !== '')
      .map(ex => ({
        ...ex,
        name: ex.name.trim(),
        unit: ex.unit.trim() || 'unité',
        points: ex.points || 0,
        decimal: /km|kilom|litre|heure|minute|seconde/i.test(ex.unit),
      }));

    if (cleaned.length === 0) {
      exportFlash("Gardez au moins un exercice.");
      return;
    }

    state.userName = document.getElementById('settingsName').value.trim();
    state.dailyGoal = parseFloat(document.getElementById('settingsGoal').value) || 0;
    state.exercises = cleaned;

    // Pseudo (uniquement si connecté)
    const pseudoField = document.getElementById('settingsPseudo');
    if (currentUser && pseudoField) {
      const wanted = normalizePseudo(pseudoField.value);
      if (wanted && wanted !== state.pseudo) {
        try {
          await claimPseudo(wanted);
        } catch (err) {
          exportFlash(err.message || 'Pseudo indisponible');
          return;
        }
      }
    }

    buildTubeBands();
    buildForm();
    buildTimerExerciseSelect();
    buildChartTabs();
    render();
    closeEditModal();
    flash("Paramètres mis à jour.");
  });

  buildTubeBands();
  buildLegend();
  buildForm();
  buildTimerExerciseSelect();
  buildChartTabs();
  initTips();
  render();

  if (!state.userName) {
    openEditModal();
  }

  const WELCOME_KEY = "note_journaliere_welcome_dismissed";
  const welcomeBanner = document.getElementById('welcomeBanner');
  try {
    if (localStorage.getItem(WELCOME_KEY) === "1") {
      welcomeBanner.style.display = "none";
    }
  } catch (e) {}
  document.getElementById('welcomeClose').addEventListener('click', () => {
    welcomeBanner.style.display = "none";
    try { localStorage.setItem(WELCOME_KEY, "1"); } catch (e) {}
  });

  /* ---- SIDE NAV ---- */
  const sideNav = document.getElementById('sideNav');
  const navToggle = document.getElementById('navToggle');
  const navScrim = document.getElementById('navScrim');

  function openNav() {
    sideNav.classList.add('open');
    navScrim.classList.add('open');
  }
  function closeNav() {
    sideNav.classList.remove('open');
    navScrim.classList.remove('open');
  }
  navToggle.addEventListener('click', () => {
    if (sideNav.classList.contains('open')) {
      closeNav();
    } else {
      closeEditModal();
      openNav();
    }
  });
  navScrim.addEventListener('click', closeNav);

  const navButtons = Array.from(document.querySelectorAll('.side-nav button[data-target]'));

  function showSection(targetId) {
    document.querySelectorAll('.app-section').forEach(sec => {
      sec.classList.toggle('active', sec.id === targetId);
    });
    navButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.target === targetId);
    });
    if (targetId === 'section-calendar') {
      renderCalendar();
      if (!calSelectedKey) selectCalDay(todayKey());
    }
    if (targetId === 'section-profile') {
      renderProfile();
    }
  }

  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      closeEditModal();
      showSection(btn.dataset.target);
      closeNav();
    });
  });

  document.getElementById('calPrevBtn')?.addEventListener('click', () => {
    calView.setMonth(calView.getMonth() - 1);
    renderCalendar();
  });
  document.getElementById('calNextBtn')?.addEventListener('click', () => {
    calView.setMonth(calView.getMonth() + 1);
    renderCalendar();
  });
  document.getElementById('calSaveNoteBtn')?.addEventListener('click', saveCalNote);
  document.getElementById('dateBadge')?.addEventListener('click', () => {
    showSection('section-calendar');
    closeNav();
  });

  document.getElementById('navSettingsLink').addEventListener('click', () => {
    closeNav();
    openEditModal();
  });

  /* ---- THEME TOGGLE ---- */
  const THEME_KEY = 'note_journaliere_theme';
  let currentTheme = 'dark';

  function applyTheme(theme) {
    currentTheme = theme;
    const isLight = theme === 'light';
    document.body.classList.toggle('light-theme', isLight);
    document.getElementById('themeDarkBtn').classList.toggle('active', !isLight);
    document.getElementById('themeLightBtn').classList.toggle('active', isLight);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  }

  try { currentTheme = localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) {}
  applyTheme(currentTheme);

  document.getElementById('themeDarkBtn').addEventListener('click', () => applyTheme('dark'));
  document.getElementById('themeLightBtn').addEventListener('click', () => applyTheme('light'));

  /* ---- ADMIN MODE ---- */
  const ADMIN_CODE = "Bassin*";

  function buildAdminBadgeSelect() {
    const select = document.getElementById('adminBadgeSelect');
    const options = getBadges().concat([{ id: SECRET_BADGE.id, label: '💎 ' + SECRET_BADGE.label }]);
    select.innerHTML = options.map(b => `<option value="${b.id}">${escapeHtml(b.label)}</option>`).join('');
  }

  function openAdminPanel() {
    buildAdminBadgeSelect();
    document.getElementById('adminPanelOverlay').classList.add('open');
  }

  document.getElementById('adminBtn').addEventListener('click', () => {
    document.getElementById('adminCodeInput').value = '';
    document.getElementById('adminCodeFlash').textContent = '';
    document.getElementById('adminCodeOverlay').classList.add('open');
    setTimeout(() => document.getElementById('adminCodeInput').focus(), 100);
  });

  document.getElementById('adminCodeCancel').addEventListener('click', () => {
    document.getElementById('adminCodeOverlay').classList.remove('open');
  });
  document.getElementById('adminCodeOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'adminCodeOverlay') document.getElementById('adminCodeOverlay').classList.remove('open');
  });

  document.getElementById('adminCodeSubmit').addEventListener('click', () => {
    const val = document.getElementById('adminCodeInput').value;
    if (val === ADMIN_CODE) {
      document.getElementById('adminCodeOverlay').classList.remove('open');
      openAdminPanel();
    } else {
      document.getElementById('adminCodeFlash').textContent = 'Code incorrect.';
    }
  });
  document.getElementById('adminCodeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('adminCodeSubmit').click();
  });

  document.getElementById('adminPanelClose').addEventListener('click', () => {
    document.getElementById('adminPanelOverlay').classList.remove('open');
  });
  document.getElementById('adminPanelOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'adminPanelOverlay') document.getElementById('adminPanelOverlay').classList.remove('open');
  });

  document.getElementById('adminGrantBadgeBtn').addEventListener('click', () => {
    const id = document.getElementById('adminBadgeSelect').value;
    if (id === SECRET_BADGE.id) {
      state.secretBadgeUnlocked = true;
    } else if (Array.isArray(state.seenBadges) && !state.seenBadges.includes(id)) {
      state.seenBadges.push(id);
    }
    saveState();
    buildBadges();
    flash('Badge débloqué (admin).');
  });

  document.getElementById('adminGrantAllBtn').addEventListener('click', () => {
    const allIds = getBadges().map(b => b.id);
    state.seenBadges = Array.from(new Set([...(state.seenBadges || []), ...allIds]));
    saveState();
    buildBadges();
    flash('Tous les badges normaux débloqués (admin).');
  });

  document.getElementById('adminResetBadgesBtn').addEventListener('click', () => {
    state.seenBadges = [];
    state.secretBadgeUnlocked = false;
    saveState();
    buildBadges();
    flash('Badges réinitialisés (admin).');
  });

  document.getElementById('adminResetPerformanceBtn').addEventListener('click', () => {
    const ok = confirm("Réinitialiser le score du jour, tout l'historique et vos records ? Vos exercices, votre prénom, votre objectif et vos badges ne seront pas touchés. Cette action est irréversible.");
    if (!ok) return;

    state.exercises = state.exercises.map(ex => ({ ...ex, value: 0 }));
    state.history = [];
    state.records = { bestScore: null, perExercise: {} };
    state.difficultyBonus = 0;
    state.hackerCelebratedToday = false;
    state.dayKey = todayKey();
    saveState();

    buildForm();
    buildTubeBands();
    buildChartTabs();
    buildTimerExerciseSelect();
    render();
    document.getElementById('adminPanelOverlay').classList.remove('open');
    flash('Performances réinitialisées (admin) — vous pouvez repartir de zéro.');
  });

  document.getElementById('adminTestRecordBtn').addEventListener('click', () => celebrateRecord());
  document.getElementById('adminTestSecretBtn').addEventListener('click', () => celebrateSecretBadge(SECRET_BADGE));
  document.getElementById('adminTestHackerBtn').addEventListener('click', () => celebrateHackerRank());
  document.getElementById('adminTestBadgeToastBtn').addEventListener('click', () => {
    const id = document.getElementById('adminBadgeSelect').value;
    const badge = getBadges().find(b => b.id === id) || SECRET_BADGE;
    showBadgeToast(badge);
  });

  /* ---- INTRO SPLASH ---- */
  const INTRO_KEY = 'note_journaliere_intro_seen';
  const introSplash = document.getElementById('introSplash');
  try {
    if (localStorage.getItem(INTRO_KEY) === '1') {
      introSplash.style.display = 'none';
    }
  } catch (e) {}

  document.getElementById('introSkipBtn').addEventListener('click', () => {
    introSplash.classList.add('hide');
    try { localStorage.setItem(INTRO_KEY, '1'); } catch (e) {}
    setTimeout(() => { introSplash.style.display = 'none'; }, 400);
  });

  document.getElementById('adminFullResetBtn').addEventListener('click', () => {
    const ok = confirm("Réinitialiser TOUTE l'application, comme si vous veniez de l'ouvrir pour la première fois ? Données, prénom, exercices personnalisés, badges, thème, tout sera effacé. Cette action est irréversible.");
    if (!ok) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(TIMER_BEEP_KEY);
      localStorage.removeItem(TIMER_BEEP_INTERVAL_KEY);
      localStorage.removeItem(WELCOME_KEY);
      localStorage.removeItem(THEME_KEY);
      localStorage.removeItem(INTRO_KEY);
    } catch (e) {}
    location.reload();
  });

  /* ---- SOCIAL PANEL + AMIS ---- */
  let friendsUnsub = null;
  let requestsUnsub = null;
  let outgoingUnsub = null;

  function socialFlash(msg, type) {
    const el = document.getElementById('socialFlash');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.remove('ok', 'err');
    if (type === 'ok') el.classList.add('ok');
    if (type === 'err') el.classList.add('err');
  }

  function openSocialPanel() {
    document.getElementById('socialPanel').classList.add('open');
    document.getElementById('socialScrim').classList.add('open');
    refreshSocialLoginGate();
    if (currentUser) loadSocialData();
  }
  function closeSocialPanel() {
    document.getElementById('socialPanel').classList.remove('open');
    document.getElementById('socialScrim').classList.remove('open');
  }

  function refreshSocialLoginGate() {
    const need = document.getElementById('socialNeedLogin');
    const content = document.getElementById('socialAmisContent');
    if (!need || !content) return;
    if (currentUser && state.pseudo) {
      need.style.display = 'none';
      content.style.display = 'block';
    } else if (currentUser && !state.pseudo) {
      need.style.display = 'block';
      need.innerHTML = 'Choisis d’abord un <strong>pseudo</strong> pour utiliser le social.<br><button type="button" id="socialPseudoBtn">Choisir mon pseudo</button>';
      content.style.display = 'none';
      const btn = document.getElementById('socialPseudoBtn');
      if (btn) btn.onclick = () => { closeSocialPanel(); openPseudoModal(true); };
    } else {
      need.style.display = 'block';
      need.innerHTML = 'Connecte-toi pour ajouter des amis, lancer des défis et discuter.<br><button type="button" id="socialLoginBtn2">Se connecter</button>';
      content.style.display = 'none';
      const btn = document.getElementById('socialLoginBtn2');
      if (btn) btn.onclick = () => { closeSocialPanel(); openLoginModal(); };
    }
  }

  document.getElementById('socialToggle').addEventListener('click', openSocialPanel);
  document.getElementById('socialClose').addEventListener('click', closeSocialPanel);
  document.getElementById('socialScrim').addEventListener('click', closeSocialPanel);

  document.querySelectorAll('.social-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.social-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.social-section').forEach(s => s.classList.remove('active'));
      tab.classList.add('active');
      const sec = document.getElementById('social-' + tab.dataset.social);
      if (sec) sec.classList.add('active');
    });
  });

  function stopSocialListeners() {
    if (friendsUnsub) { friendsUnsub(); friendsUnsub = null; }
    if (requestsUnsub) { requestsUnsub(); requestsUnsub = null; }
    if (outgoingUnsub) { outgoingUnsub(); outgoingUnsub = null; }
  }

  function renderFriendsFromDocs(docs) {
    const list = document.getElementById('friendsList');
    if (!list) return;
    if (!docs.length) {
      list.innerHTML = '<div class="social-empty">Pas encore d’amis</div>';
      return;
    }
    list.innerHTML = '';
    docs.forEach(({ id, data }) => {
      const f = data || {};
      const card = document.createElement('div');
      card.className = 'friend-card';
      card.innerHTML = `
        <div>
          <div class="fname">@${escapeHtml(f.pseudo || id)}</div>
          <div class="fmeta">Ami</div>
        </div>
        <div class="friend-actions">
          <button type="button" class="primary" data-view-profile="${id}" data-view-pseudo="${escapeHtml(f.pseudo || '')}">Profil</button>
          <button type="button" class="danger" data-remove-friend="${id}">Retirer</button>
        </div>`;
      list.appendChild(card);
    });
    list.querySelectorAll('[data-remove-friend]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); removeFriend(btn.dataset.removeFriend); });
    });
    list.querySelectorAll('[data-view-profile]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openFriendProfile(btn.dataset.viewProfile, btn.dataset.viewPseudo);
      });
    });
  }

  async function openFriendProfile(uid, fallbackPseudo) {
    const overlay = document.getElementById('friendProfileOverlay');
    if (!overlay) return;
    document.getElementById('fpPseudo').textContent = '@' + (fallbackPseudo || '…');
    document.getElementById('fpRank').textContent = 'Chargement…';
    document.getElementById('fpScore').textContent = '—';
    document.getElementById('fpLevel').textContent = '—';
    document.getElementById('fpXp').textContent = '—';
    document.getElementById('fpBadges').textContent = '—';
    overlay.classList.add('open');
    try {
      const snap = await db.collection('publicProfiles').doc(uid).get();
      if (!snap.exists) {
        document.getElementById('fpRank').textContent = 'Profil pas encore publié';
        document.getElementById('fpScore').textContent = 'Demande à ton ami d’ouvrir l’app une fois connecté';
        return;
      }
      const p = snap.data();
      document.getElementById('fpPseudo').textContent = '@' + (p.pseudo || fallbackPseudo || '?');
      document.getElementById('fpAvatar').textContent = (p.pseudo || '?').slice(0, 1).toUpperCase();
      document.getElementById('fpRank').textContent = p.rankName || '—';
      if (p.rankColor) {
        document.getElementById('fpRank').style.color = p.rankColor;
      }
      document.getElementById('fpScore').textContent =
        (typeof p.todayScore === 'number' ? p.todayScore + ' pts aujourd’hui' : 'Score inconnu');
      document.getElementById('fpLevel').textContent = 'Niveau ' + (p.level || 1);
      document.getElementById('fpXp').textContent = (p.xp || 0) + ' XP';
      document.getElementById('fpBadges').textContent =
        (p.badgesUnlocked || 0) + ' / ' + (p.badgesTotal || 0) + ' badges';
    } catch (e) {
      console.error(e);
      document.getElementById('fpRank').textContent = 'Impossible de charger le profil';
    }
  }
  function closeFriendProfile() {
    document.getElementById('friendProfileOverlay')?.classList.remove('open');
  }
  document.getElementById('fpCloseBtn')?.addEventListener('click', closeFriendProfile);
  document.getElementById('friendProfileOverlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'friendProfileOverlay') closeFriendProfile();
  });

  async function refreshFriendsOnce() {
    if (!currentUser) return;
    try {
      const snap = await db.collection('users').doc(currentUser.uid).collection('friends').get();
      const docs = [];
      snap.forEach(doc => docs.push({ id: doc.id, data: doc.data() }));
      renderFriendsFromDocs(docs);
    } catch (e) {
      console.error(e);
      const list = document.getElementById('friendsList');
      if (list) list.innerHTML = '<div class="social-empty">Erreur chargement amis (règles ?)</div>';
    }
  }

  function loadSocialData() {
    if (!currentUser) return;
    stopSocialListeners();
    const uid = currentUser.uid;

    // Affiche tout de suite (évite la liste vide alors que des amis existent)
    refreshFriendsOnce();

    friendsUnsub = db.collection('users').doc(uid).collection('friends')
      .onSnapshot(snap => {
        const docs = [];
        snap.forEach(doc => docs.push({ id: doc.id, data: doc.data() }));
        renderFriendsFromDocs(docs);
      }, err => {
        console.error(err);
        const list = document.getElementById('friendsList');
        if (list) list.innerHTML = '<div class="social-empty">Erreur temps réel amis</div>';
        refreshFriendsOnce();
      });

    requestsUnsub = db.collection('users').doc(uid).collection('incomingRequests')
      .onSnapshot(snap => {
        const list = document.getElementById('friendRequestsList');
        const badge = document.getElementById('socialBadge');
        if (badge) {
          badge.textContent = String(snap.size);
          badge.classList.toggle('show', snap.size > 0);
        }
        if (!list) return;
        if (snap.empty) {
          list.innerHTML = '<div class="social-empty">Aucune demande</div>';
          return;
        }
        list.innerHTML = '';
        snap.forEach(doc => {
          const r = doc.data();
          const card = document.createElement('div');
          card.className = 'friend-card';
          card.innerHTML = `
            <div>
              <div class="fname">@${escapeHtml(r.pseudo || '?')}</div>
              <div class="fmeta">Veut être ton ami</div>
            </div>
            <div class="friend-actions">
              <button type="button" class="primary" data-accept="${doc.id}">Accepter</button>
              <button type="button" class="danger" data-decline="${doc.id}">Refuser</button>
            </div>`;
          list.appendChild(card);
        });
        list.querySelectorAll('[data-accept]').forEach(btn => {
          btn.addEventListener('click', () => acceptFriend(btn.dataset.accept));
        });
        list.querySelectorAll('[data-decline]').forEach(btn => {
          btn.addEventListener('click', () => declineFriend(btn.dataset.decline));
        });
      }, err => console.error(err));

    outgoingUnsub = db.collection('users').doc(uid).collection('outgoingRequests')
      .onSnapshot(snap => {
        const list = document.getElementById('friendOutgoingList');
        if (!list) return;
        if (snap.empty) {
          list.innerHTML = '<div class="social-empty">Aucune</div>';
          return;
        }
        list.innerHTML = '';
        snap.forEach(doc => {
          const r = doc.data();
          const card = document.createElement('div');
          card.className = 'friend-card';
          card.innerHTML = `
            <div>
              <div class="fname">@${escapeHtml(r.pseudo || '?')}</div>
              <div class="fmeta">En attente</div>
            </div>
            <div class="friend-actions">
              <button type="button" class="danger" data-cancel="${doc.id}">Annuler</button>
            </div>`;
          list.appendChild(card);
        });
        list.querySelectorAll('[data-cancel]').forEach(btn => {
          btn.addEventListener('click', () => cancelOutgoing(btn.dataset.cancel));
        });
      }, err => console.error(err));
  }

  async function sendFriendRequest() {
    if (!currentUser || !state.pseudo) {
      socialFlash('Connecte-toi et choisis un pseudo d’abord.', 'err');
      return;
    }
    const targetPseudo = normalizePseudo(document.getElementById('friendSearchInput').value);
    const err = validatePseudo(targetPseudo);
    if (err) { socialFlash(err, 'err'); return; }
    if (targetPseudo === state.pseudo) {
      socialFlash('Tu ne peux pas t’ajouter toi-même.', 'err');
      return;
    }
    socialFlash('Recherche…');
    try {
      const unameSnap = await db.collection('usernames').doc(targetPseudo).get();
      if (!unameSnap.exists) {
        socialFlash('Aucun utilisateur avec ce pseudo.', 'err');
        return;
      }
      const targetUid = unameSnap.data().uid;
      if (targetUid === currentUser.uid) {
        socialFlash('Tu ne peux pas t’ajouter toi-même.', 'err');
        return;
      }
      const myFriendRef = db.collection('users').doc(currentUser.uid).collection('friends').doc(targetUid);
      const theirFriendRef = db.collection('users').doc(targetUid).collection('friends').doc(currentUser.uid);
      const already = await myFriendRef.get();
      if (already.exists) {
        // Répare le lien côté opposé si besoin + rafraîchit la liste
        try {
          const theirs = await theirFriendRef.get();
          if (!theirs.exists) {
            await theirFriendRef.set({
              uid: currentUser.uid,
              pseudo: state.pseudo,
              since: firebase.firestore.FieldValue.serverTimestamp()
            });
          }
        } catch (e) { console.warn('heal friend link', e); }
        await refreshFriendsOnce();
        socialFlash('Vous êtes déjà amis avec @' + targetPseudo + ' — liste rafraîchie.', 'ok');
        document.getElementById('friendSearchInput').value = '';
        return;
      }

      // Déjà une demande en attente ?
      const outExists = await db.collection('users').doc(currentUser.uid).collection('outgoingRequests').doc(targetUid).get();
      if (outExists.exists) {
        socialFlash('Demande déjà envoyée à @' + targetPseudo + ' — en attente.', 'ok');
        return;
      }

      const batch = db.batch();
      batch.set(db.collection('users').doc(currentUser.uid).collection('outgoingRequests').doc(targetUid), {
        uid: targetUid, pseudo: targetPseudo,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      batch.set(db.collection('users').doc(targetUid).collection('incomingRequests').doc(currentUser.uid), {
        uid: currentUser.uid, pseudo: state.pseudo,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await batch.commit();
      document.getElementById('friendSearchInput').value = '';
      socialFlash('Demande envoyée à @' + targetPseudo, 'ok');
      logEvent('friend_request_sent');
    } catch (e) {
      console.error(e);
      socialFlash(e.message || 'Erreur lors de l’envoi', 'err');
    }
  }

  async function acceptFriend(fromUid) {
    if (!currentUser) return;
    try {
      const inRef = db.collection('users').doc(currentUser.uid).collection('incomingRequests').doc(fromUid);
      const inSnap = await inRef.get();
      if (!inSnap.exists) return;
      const fromPseudo = inSnap.data().pseudo || '';
      const batch = db.batch();
      batch.set(db.collection('users').doc(currentUser.uid).collection('friends').doc(fromUid), {
        uid: fromUid, pseudo: fromPseudo,
        since: firebase.firestore.FieldValue.serverTimestamp()
      });
      batch.set(db.collection('users').doc(fromUid).collection('friends').doc(currentUser.uid), {
        uid: currentUser.uid, pseudo: state.pseudo,
        since: firebase.firestore.FieldValue.serverTimestamp()
      });
      batch.delete(inRef);
      batch.delete(db.collection('users').doc(fromUid).collection('outgoingRequests').doc(currentUser.uid));
      await batch.commit();
      socialFlash('Vous êtes maintenant amis avec @' + fromPseudo, 'ok');
      logEvent('friend_accepted');
    } catch (e) {
      console.error(e);
      socialFlash('Impossible d’accepter', 'err');
    }
  }

  async function declineFriend(fromUid) {
    if (!currentUser) return;
    try {
      const batch = db.batch();
      batch.delete(db.collection('users').doc(currentUser.uid).collection('incomingRequests').doc(fromUid));
      batch.delete(db.collection('users').doc(fromUid).collection('outgoingRequests').doc(currentUser.uid));
      await batch.commit();
      socialFlash('Demande refusée', 'ok');
    } catch (e) { socialFlash('Erreur', 'err'); }
  }

  async function cancelOutgoing(toUid) {
    if (!currentUser) return;
    try {
      const batch = db.batch();
      batch.delete(db.collection('users').doc(currentUser.uid).collection('outgoingRequests').doc(toUid));
      batch.delete(db.collection('users').doc(toUid).collection('incomingRequests').doc(currentUser.uid));
      await batch.commit();
      socialFlash('Demande annulée', 'ok');
    } catch (e) { socialFlash('Erreur', 'err'); }
  }

  async function removeFriend(friendUid) {
    if (!currentUser) return;
    if (!confirm('Retirer cet ami ?')) return;
    try {
      const batch = db.batch();
      batch.delete(db.collection('users').doc(currentUser.uid).collection('friends').doc(friendUid));
      batch.delete(db.collection('users').doc(friendUid).collection('friends').doc(currentUser.uid));
      await batch.commit();
      socialFlash('Ami retiré', 'ok');
    } catch (e) { socialFlash('Erreur', 'err'); }
  }

  document.getElementById('friendAddBtn').addEventListener('click', sendFriendRequest);
  document.getElementById('friendSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendFriendRequest();
  });

  /* ---- DÉFIS ---- */
  let challengesUnsubFrom = null;
  let challengesUnsubTo = null;
  let chronoTickTimer = null;
  let activeChronoChallengeId = null;
  let cachedChallenges = {};

  const CHALLENGE_TYPE_LABELS = {
    score_day: 'Score du jour',
    exercise: 'Exercice',
    goal: 'Objectif',
    chrono: 'Chrono duel'
  };

  function stopChallengeListeners() {
    if (challengesUnsubFrom) { challengesUnsubFrom(); challengesUnsubFrom = null; }
    if (challengesUnsubTo) { challengesUnsubTo(); challengesUnsubTo = null; }
    if (chronoTickTimer) { clearInterval(chronoTickTimer); chronoTickTimer = null; }
  }

  async function populateChallengeFriends() {
    const sel = document.getElementById('challengeFriendSelect');
    if (!sel || !currentUser) return;
    sel.innerHTML = '<option value="">Choisir un ami…</option>';
    try {
      const snap = await db.collection('users').doc(currentUser.uid).collection('friends').get();
      snap.forEach(doc => {
        const f = doc.data();
        const opt = document.createElement('option');
        opt.value = doc.id;
        opt.textContent = '@' + (f.pseudo || doc.id);
        opt.dataset.pseudo = f.pseudo || doc.id;
        sel.appendChild(opt);
      });
    } catch (e) { console.error(e); }
  }

  function populateChallengeExercises() {
    const sel = document.getElementById('challengeExerciseSelect');
    if (!sel) return;
    sel.innerHTML = '';
    (state.exercises || []).forEach(ex => {
      const opt = document.createElement('option');
      opt.value = ex.id;
      opt.textContent = ex.name + ' (' + ex.unit + ')';
      sel.appendChild(opt);
    });
  }

  function updateChallengeTypeFields() {
    const type = document.getElementById('challengeTypeSelect').value;
    document.getElementById('challengeExerciseField').style.display = type === 'exercise' ? 'block' : 'none';
    document.getElementById('challengeGoalField').style.display = type === 'goal' ? 'block' : 'none';
  }

  document.getElementById('challengeTypeSelect').addEventListener('change', updateChallengeTypeFields);

  async function sendChallenge() {
    if (!currentUser || !state.pseudo) {
      socialFlash('Connecte-toi avec un pseudo.', 'err');
      return;
    }
    const sel = document.getElementById('challengeFriendSelect');
    const toUid = sel.value;
    if (!toUid) { socialFlash('Choisis un ami.', 'err'); return; }
    const toPseudo = sel.options[sel.selectedIndex].dataset.pseudo || sel.options[sel.selectedIndex].textContent.replace('@','');
    const type = document.getElementById('challengeTypeSelect').value;

    const data = {
      type,
      fromUid: currentUser.uid,
      fromPseudo: state.pseudo,
      toUid,
      toPseudo,
      status: 'pending',
      dayKey: todayKey(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    if (type === 'exercise') {
      const exId = document.getElementById('challengeExerciseSelect').value;
      const ex = (state.exercises || []).find(e => e.id === exId);
      if (!ex) { socialFlash('Choisis un exercice.', 'err'); return; }
      data.exerciseId = ex.id;
      data.exerciseName = ex.name;
      data.exerciseUnit = ex.unit;
    }
    if (type === 'goal') {
      const g = parseFloat(document.getElementById('challengeGoalInput').value) || 0;
      if (g < 10) { socialFlash('Objectif trop bas.', 'err'); return; }
      data.goalPoints = g;
    }
    if (type === 'chrono') {
      data.chrono = { startedAt: null, fromStoppedAt: null, toStoppedAt: null, fromMs: null, toMs: null };
    }

    try {
      await db.collection('challenges').add(data);
      socialFlash('Défi envoyé à @' + toPseudo, 'ok');
      logEvent('challenge_sent', { type });
    } catch (e) {
      console.error(e);
      socialFlash('Erreur envoi défi (règles Firestore ?)', 'err');
    }
  }

  document.getElementById('challengeSendBtn').addEventListener('click', sendChallenge);

  function myScoreToday() { return Math.round(computeScore(state)); }
  function myExerciseValue(exId) {
    const ex = (state.exercises || []).find(e => e.id === exId);
    return ex ? ex.value : 0;
  }

  function renderChallengesList() {
    const list = document.getElementById('challengesList');
    if (!list || !currentUser) return;
    const items = Object.values(cachedChallenges).sort((a, b) => {
      const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
      const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
      return tb - ta;
    });
    if (!items.length) {
      list.innerHTML = '<div class="social-empty">Aucun défi</div>';
      return;
    }
    list.innerHTML = '';
    items.forEach(ch => {
      const card = document.createElement('div');
      card.className = 'challenge-card status-' + ch.status;
      const isFromMe = ch.fromUid === currentUser.uid;
      const other = isFromMe ? ch.toPseudo : ch.fromPseudo;
      let detail = '';
      if (ch.type === 'score_day') detail = 'Qui a le plus de points aujourd’hui';
      if (ch.type === 'exercise') detail = 'Le plus de ' + (ch.exerciseName || 'exercice');
      if (ch.type === 'goal') detail = 'Atteindre ' + (ch.goalPoints || '?') + ' pts';
      if (ch.type === 'chrono') detail = 'Chrono duel — premier qui stoppe';

      let statusLine = '';
      if (ch.status === 'pending') statusLine = isFromMe ? 'En attente de @' + other : '@' + other + ' t’a défié';
      if (ch.status === 'active') statusLine = 'En cours vs @' + other;
      if (ch.status === 'declined') statusLine = 'Refusé';
      if (ch.status === 'cancelled') statusLine = 'Annulé';
      if (ch.status === 'completed') {
        if (ch.winnerUid === currentUser.uid) statusLine = '🏆 Tu as gagné vs @' + other;
        else if (ch.winnerUid === 'draw') statusLine = 'Égalité avec @' + other;
        else statusLine = 'Perdu contre @' + other;
        if (ch.resultText) statusLine += ' — ' + ch.resultText;
      }

      let actions = '';
      if (ch.status === 'pending' && !isFromMe) {
        actions = `<button type="button" class="primary" data-ch-accept="${ch.id}">Accepter</button>
                   <button type="button" class="danger" data-ch-decline="${ch.id}">Refuser</button>`;
      }
      if (ch.status === 'pending' && isFromMe) {
        actions = `<button type="button" class="danger" data-ch-cancel="${ch.id}">Annuler</button>`;
      }
      if (ch.status === 'active' && (ch.type === 'score_day' || ch.type === 'exercise' || ch.type === 'goal')) {
        actions = `<button type="button" class="primary" data-ch-resolve="${ch.id}">Clôturer / comparer</button>`;
      }
      if (ch.status === 'active' && ch.type === 'chrono') {
        actions = `<button type="button" class="primary" data-ch-chrono="${ch.id}">Ouvrir le chrono</button>`;
      }

      let chronoHtml = '';
      if (ch.status === 'active' && ch.type === 'chrono' && activeChronoChallengeId === ch.id) {
        chronoHtml = `<div class="chrono-box" id="chronoBox">
          <div class="chrono-status" id="chronoStatus">Prêt</div>
          <div class="chrono-time" id="chronoTime">00:00.0</div>
          <div class="cactions" style="justify-content:center;">
            <button type="button" class="primary" id="chronoStartBtn">Démarrer</button>
            <button type="button" class="danger" id="chronoStopBtn">Stop</button>
          </div>
        </div>`;
      }

      card.innerHTML = `
        <div class="ctype">${CHALLENGE_TYPE_LABELS[ch.type] || ch.type}</div>
        <div class="ctitle">vs @${escapeHtml(other || '?')}</div>
        <div class="cmeta">${escapeHtml(detail)}<br>${escapeHtml(statusLine)}</div>
        <div class="cactions">${actions}</div>
        ${chronoHtml}`;
      list.appendChild(card);
    });

    list.querySelectorAll('[data-ch-accept]').forEach(b => b.addEventListener('click', () => respondChallenge(b.dataset.chAccept, 'active')));
    list.querySelectorAll('[data-ch-decline]').forEach(b => b.addEventListener('click', () => respondChallenge(b.dataset.chDecline, 'declined')));
    list.querySelectorAll('[data-ch-cancel]').forEach(b => b.addEventListener('click', () => respondChallenge(b.dataset.chCancel, 'cancelled')));
    list.querySelectorAll('[data-ch-resolve]').forEach(b => b.addEventListener('click', () => resolveChallenge(b.dataset.chResolve)));
    list.querySelectorAll('[data-ch-chrono]').forEach(b => b.addEventListener('click', () => {
      activeChronoChallengeId = b.dataset.chChrono;
      renderChallengesList();
      setupChronoHandlers(b.dataset.chChrono);
    }));
  }

  function loadChallenges() {
    if (!currentUser) return;
    stopChallengeListeners();
    cachedChallenges = {};
    const merge = (snap) => {
      snap.forEach(doc => { cachedChallenges[doc.id] = { id: doc.id, ...doc.data() }; });
      snap.docChanges().forEach(change => {
        if (change.type === 'removed') delete cachedChallenges[change.doc.id];
      });
      renderChallengesList();
    };
    challengesUnsubFrom = db.collection('challenges').where('fromUid', '==', currentUser.uid)
      .onSnapshot(merge, err => console.error(err));
    challengesUnsubTo = db.collection('challenges').where('toUid', '==', currentUser.uid)
      .onSnapshot(merge, err => console.error(err));
  }

  async function respondChallenge(id, status) {
    try {
      await db.collection('challenges').doc(id).update({
        status,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      socialFlash(status === 'active' ? 'Défi accepté !' : (status === 'declined' ? 'Défi refusé' : 'Défi annulé'), 'ok');
    } catch (e) {
      console.error(e);
      socialFlash('Erreur', 'err');
    }
  }

  async function resolveChallenge(id) {
    const ch = cachedChallenges[id];
    if (!ch || !currentUser) return;
    const isFrom = ch.fromUid === currentUser.uid;
    let myVal = 0, label = '';
    if (ch.type === 'score_day' || ch.type === 'goal') { myVal = myScoreToday(); label = 'pts'; }
    else if (ch.type === 'exercise') { myVal = myExerciseValue(ch.exerciseId); label = ch.exerciseUnit || ''; }

    const field = isFrom ? 'fromScore' : 'toScore';
    try {
      await db.collection('challenges').doc(id).update({
        [field]: myVal,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      const snap = await db.collection('challenges').doc(id).get();
      const fresh = snap.data();
      const fromScore = typeof fresh.fromScore === 'number' ? fresh.fromScore : null;
      const toScore = typeof fresh.toScore === 'number' ? fresh.toScore : null;
      if (fromScore === null || toScore === null) {
        socialFlash('Score enregistré. En attente de l’autre…', 'ok');
        return;
      }
      let winnerUid = 'draw';
      let resultText = fromScore + ' vs ' + toScore + ' ' + label;
      if (ch.type === 'goal') {
        const fromOk = fromScore >= (ch.goalPoints || 0);
        const toOk = toScore >= (ch.goalPoints || 0);
        if (fromOk && !toOk) winnerUid = ch.fromUid;
        else if (toOk && !fromOk) winnerUid = ch.toUid;
        else if (fromOk && toOk) {
          if (fromScore > toScore) winnerUid = ch.fromUid;
          else if (toScore > fromScore) winnerUid = ch.toUid;
        }
        resultText = `objectif ${ch.goalPoints} — ${fromScore} vs ${toScore}`;
      } else {
        if (fromScore > toScore) winnerUid = ch.fromUid;
        else if (toScore > fromScore) winnerUid = ch.toUid;
      }
      await db.collection('challenges').doc(id).update({
        status: 'completed', winnerUid, resultText,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      tryClaimChallengeXp({ id, status: 'completed', winnerUid, fromUid: ch.fromUid, toUid: ch.toUid });
      socialFlash('Défi terminé !', 'ok');
    } catch (e) {
      console.error(e);
      socialFlash('Erreur clôture', 'err');
    }
  }

  function setupChronoHandlers(challengeId) {
    const startBtn = document.getElementById('chronoStartBtn');
    const stopBtn = document.getElementById('chronoStopBtn');
    if (!startBtn || !stopBtn) return;

    startBtn.onclick = async () => {
      try {
        await db.collection('challenges').doc(challengeId).update({
          'chrono.startedAt': firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) { socialFlash('Erreur démarrage chrono', 'err'); }
    };

    stopBtn.onclick = async () => {
      const ch = cachedChallenges[challengeId];
      if (!ch || !ch.chrono || !ch.chrono.startedAt) {
        socialFlash('Le chrono n’a pas encore démarré', 'err');
        return;
      }
      const isFrom = ch.fromUid === currentUser.uid;
      const fieldStopped = isFrom ? 'chrono.fromStoppedAt' : 'chrono.toStoppedAt';
      try {
        await db.collection('challenges').doc(challengeId).update({
          [fieldStopped]: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        const snap = await db.collection('challenges').doc(challengeId).get();
        const fresh = snap.data();
        const c = fresh.chrono || {};
        if (c.startedAt && c.fromStoppedAt && c.toStoppedAt) {
          const start = c.startedAt.toMillis();
          const fromMs = c.fromStoppedAt.toMillis() - start;
          const toMs = c.toStoppedAt.toMillis() - start;
          let winnerUid = 'draw';
          if (fromMs < toMs) winnerUid = fresh.fromUid;
          else if (toMs < fromMs) winnerUid = fresh.toUid;
          await db.collection('challenges').doc(challengeId).update({
            status: 'completed', winnerUid,
            resultText: `chrono ${(fromMs/1000).toFixed(1)}s vs ${(toMs/1000).toFixed(1)}s`,
            'chrono.fromMs': fromMs, 'chrono.toMs': toMs,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
          tryClaimChallengeXp({
            id: challengeId, status: 'completed', winnerUid,
            fromUid: fresh.fromUid, toUid: fresh.toUid
          });
          socialFlash('Chrono terminé !', 'ok');
        } else {
          socialFlash('Stop enregistré — en attente de l’autre', 'ok');
        }
      } catch (e) {
        console.error(e);
        socialFlash('Erreur stop', 'err');
      }
    };

    if (chronoTickTimer) clearInterval(chronoTickTimer);
    chronoTickTimer = setInterval(() => {
      const ch = cachedChallenges[challengeId];
      const timeEl = document.getElementById('chronoTime');
      const statusEl = document.getElementById('chronoStatus');
      if (!ch || !timeEl) return;
      const c = ch.chrono || {};
      if (!c.startedAt) {
        timeEl.textContent = '00:00.0';
        if (statusEl) statusEl.textContent = 'En attente du démarrage…';
        return;
      }
      const start = c.startedAt.toMillis ? c.startedAt.toMillis() : Date.now();
      const isFrom = ch.fromUid === currentUser.uid;
      const myStopped = isFrom ? c.fromStoppedAt : c.toStoppedAt;
      const end = myStopped && myStopped.toMillis ? myStopped.toMillis() : Date.now();
      const ms = Math.max(0, end - start);
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const ds = Math.floor((ms % 1000) / 100);
      timeEl.textContent = String(m).padStart(2,'0') + ':' + String(s % 60).padStart(2,'0') + '.' + ds;
      if (statusEl) statusEl.textContent = myStopped ? 'Tu as stoppé — en attente de l’autre…' : 'Chrono en cours !';
    }, 100);
  }

  document.querySelectorAll('.social-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.social === 'defis') {
        populateChallengeFriends();
        populateChallengeExercises();
        updateChallengeTypeFields();
        if (currentUser) loadChallenges();
      }
    });
  });

  /* ---- MESSAGERIE ---- */
  let messagesUnsub = null;
  let activeChatId = null;
  let activeChatFriend = null; // { uid, pseudo }

  function chatIdFor(uidA, uidB) {
    return [uidA, uidB].sort().join('_');
  }

  function showChatList() {
    document.getElementById('chatListView').style.display = 'block';
    document.getElementById('chatThreadView').style.display = 'none';
    if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
    activeChatId = null;
    activeChatFriend = null;
    renderChatFriendsList();
  }

  function showChatThread(friend) {
    activeChatFriend = friend;
    activeChatId = chatIdFor(currentUser.uid, friend.uid);
    document.getElementById('chatListView').style.display = 'none';
    const thread = document.getElementById('chatThreadView');
    thread.style.display = 'flex';
    document.getElementById('chatThreadTitle').textContent = '@' + friend.pseudo;
    document.getElementById('chatMessages').innerHTML = '<div class="social-empty">Chargement…</div>';
    document.getElementById('chatInput').value = '';
    listenMessages(activeChatId);
  }

  async function renderChatFriendsList() {
    const list = document.getElementById('messagesList');
    if (!currentUser) {
      list.innerHTML = '<div class="social-empty">Connecte-toi pour discuter</div>';
      return;
    }
    try {
      const snap = await db.collection('users').doc(currentUser.uid).collection('friends').get();
      if (snap.empty) {
        list.innerHTML = '<div class="social-empty">Ajoute des amis pour discuter</div>';
        return;
      }
      list.innerHTML = '';
      snap.forEach(doc => {
        const f = doc.data();
        const card = document.createElement('div');
        card.className = 'friend-card chatable';
        card.innerHTML = `
          <div>
            <div class="fname">@${escapeHtml(f.pseudo || doc.id)}</div>
            <div class="fmeta">Appuyer pour discuter</div>
          </div>
          <div class="friend-actions">
            <button type="button" class="primary">Message</button>
          </div>`;
        const open = () => showChatThread({ uid: doc.id, pseudo: f.pseudo || doc.id });
        card.addEventListener('click', open);
        list.appendChild(card);
      });
    } catch (e) {
      console.error(e);
      list.innerHTML = '<div class="social-empty">Erreur de chargement</div>';
    }
  }

  function listenMessages(chatId) {
    if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
    const box = document.getElementById('chatMessages');
    messagesUnsub = db.collection('conversations').doc(chatId).collection('messages')
      .orderBy('createdAt', 'asc')
      .limitToLast(100)
      .onSnapshot(snap => {
        if (snap.empty) {
          box.innerHTML = '<div class="social-empty">Aucun message — dis bonjour 👋</div>';
          return;
        }
        box.innerHTML = '';
        snap.forEach(doc => {
          const m = doc.data();
          const mine = m.from === currentUser.uid;
          const div = document.createElement('div');
          div.className = 'chat-bubble ' + (mine ? 'me' : 'them');
          let time = '';
          if (m.createdAt && m.createdAt.toDate) {
            time = m.createdAt.toDate().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
          }
          div.innerHTML = `${escapeHtml(m.text || '')}<span class="ctime">${time}</span>`;
          box.appendChild(div);
        });
        box.scrollTop = box.scrollHeight;
      }, err => {
        console.error(err);
        box.innerHTML = '<div class="social-empty">Erreur messages (règles Firestore ?)</div>';
      });
  }

  async function sendChatMessage() {
    if (!currentUser || !activeChatId || !activeChatFriend) return;
    const input = document.getElementById('chatInput');
    const text = (input.value || '').trim();
    if (!text) return;
    input.value = '';
    try {
      const convRef = db.collection('conversations').doc(activeChatId);
      const msgRef = convRef.collection('messages').doc();
      const batch = db.batch();
      batch.set(convRef, {
        participants: [currentUser.uid, activeChatFriend.uid].sort(),
        pseudos: {
          [currentUser.uid]: state.pseudo || '',
          [activeChatFriend.uid]: activeChatFriend.pseudo || ''
        },
        lastMessage: text.slice(0, 120),
        lastFrom: currentUser.uid,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      batch.set(msgRef, {
        from: currentUser.uid,
        text: text.slice(0, 500),
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await batch.commit();
      logEvent('message_sent');
    } catch (e) {
      console.error(e);
      socialFlash('Impossible d’envoyer le message', 'err');
    }
  }

  document.getElementById('chatBackBtn').addEventListener('click', showChatList);
  document.getElementById('chatSendBtn').addEventListener('click', sendChatMessage);
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatMessage();
  });

  // Quand on ouvre l'onglet Messages
  document.querySelectorAll('.social-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.social === 'messages') {
        showChatList();
      }
    });
  });

  auth.onAuthStateChanged((user) => {
    refreshSocialLoginGate();
    if (!user) {
      stopSocialListeners();
      if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
      const badge = document.getElementById('socialBadge');
      if (badge) badge.classList.remove('show');
      showChatList();
    }
  });

  showSection('section-today');

