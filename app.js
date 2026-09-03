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
    } else {
      logEvent('logout');
      closePseudoModal();
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
      difficultyBonus: 0
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
    saveState();
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
  }

  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      closeEditModal();
      showSection(btn.dataset.target);
      closeNav();
    });
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

  function loadSocialData() {
    if (!currentUser) return;
    stopSocialListeners();
    const uid = currentUser.uid;

    friendsUnsub = db.collection('users').doc(uid).collection('friends')
      .onSnapshot(snap => {
        const list = document.getElementById('friendsList');
        if (!list) return;
        if (snap.empty) {
          list.innerHTML = '<div class="social-empty">Pas encore d’amis</div>';
          return;
        }
        list.innerHTML = '';
        snap.forEach(doc => {
          const f = doc.data();
          const card = document.createElement('div');
          card.className = 'friend-card';
          card.innerHTML = `
            <div>
              <div class="fname">@${escapeHtml(f.pseudo || doc.id)}</div>
              <div class="fmeta">Ami</div>
            </div>
            <div class="friend-actions">
              <button type="button" class="danger" data-remove-friend="${doc.id}">Retirer</button>
            </div>`;
          list.appendChild(card);
        });
        list.querySelectorAll('[data-remove-friend]').forEach(btn => {
          btn.addEventListener('click', () => removeFriend(btn.dataset.removeFriend));
        });
      }, err => console.error(err));

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
      const already = await db.collection('users').doc(currentUser.uid).collection('friends').doc(targetUid).get();
      if (already.exists) {
        socialFlash('Vous êtes déjà amis.', 'err');
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

  auth.onAuthStateChanged((user) => {
    refreshSocialLoginGate();
    if (!user) {
      stopSocialListeners();
      const badge = document.getElementById('socialBadge');
      if (badge) badge.classList.remove('show');
    }
  });

  showSection('section-today');

