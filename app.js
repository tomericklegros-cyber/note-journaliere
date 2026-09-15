  var STORAGE_KEY = window.STORAGE_KEY || "note_journaliere_v1";
  window.STORAGE_KEY = STORAGE_KEY;

  /* ========== APP CORE ==========
     Structure :
     - firebase-config.js → auth, db, analytics
     - app.js             → state, UI, social, sync
     Prochaine étape possible : app-social.js / app-state.js
  ========== */

  // auth, db, analytics viennent de firebase-config.js
  var currentUser = null;

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
      const nameEl = document.getElementById('authDisplayName');
      const emailEl = document.getElementById('authEmail');
      if (nameEl) nameEl.textContent = state && state.pseudo ? '@' + state.pseudo : display;
      if (emailEl) emailEl.textContent = user.email || 'Compte connecté';
      const avEl = document.getElementById('authAccountAvatar');
      if (avEl) {
        const av = (state && state.selectedAvatar && typeof AVATAR_CATALOG !== 'undefined' && AVATAR_CATALOG[state.selectedAvatar])
          ? AVATAR_CATALOG[state.selectedAvatar].emoji
          : (display || '?').replace(/^@/, '').slice(0, 1).toUpperCase();
        avEl.textContent = av;
      }
      const lvlEl = document.getElementById('authAccountLevel');
      if (lvlEl && typeof levelFromXp === 'function') {
        lvlEl.textContent = 'Niv. ' + levelFromXp((state && state.xp) || 0);
      }
      setAuthStatus('Connecté — synchronisation active', 'synced');
    } else {
      loggedOut.style.display = 'block';
      loggedIn.style.display = 'none';
      setAuthStatus('Données locales uniquement', null);
    }
    if (typeof updateAdminButtonVisibility === 'function') updateAdminButtonVisibility();
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

  if (auth) auth.onAuthStateChanged(async (user) => {
    currentUser = user;
    updateAuthUI(user);
    if (user) {
      logEvent('login', { method: user.providerData?.[0]?.providerId || 'unknown' });
      const loaded = await loadFromCloud(user);
      if (typeof ensureExercises === 'function') ensureExercises();
      try {
        buildTubeBands();
        buildForm();
        buildTimerExerciseSelect();
        buildChartTabs();
        buildLegend();
        if (typeof initTips === 'function') initTips();
        render();
        updateAdminButtonVisibility();
      } catch (e) { console.warn('post-cloud ui', e); }
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

  document.getElementById('forgotPasswordBtn').addEventListener('click', async () => {
    const email = document.getElementById('loginEmail').value.trim();
    const flashEl = document.getElementById('loginFlash');
    if (!email) {
      flashEl.textContent = 'Entrez votre email ci-dessus, puis cliquez à nouveau ici.';
      return;
    }
    try {
      flashEl.textContent = 'Envoi en cours…';
      await auth.sendPasswordResetEmail(email);
      flashEl.textContent = 'Email envoyé ! Vérifiez votre boîte de réception (et les spams).';
    } catch (err) {
      flashEl.textContent = err.code === 'auth/user-not-found'
        ? 'Aucun compte avec cet email.'
        : (err.message || 'Erreur lors de l\'envoi.');
    }
  });

  
  document.getElementById('authAccountCard')?.addEventListener('click', () => {
    if (typeof showSection === 'function') showSection('section-profile');
    if (typeof closeNav === 'function') closeNav();
    if (typeof renderProfile === 'function') renderProfile();
  });

document.getElementById('logoutBtn').addEventListener('click', async () => {
    const ok = confirm("Voulez-vous vraiment vous déconnecter ?");
    if (!ok) return;
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

  function computeScore(s) {
    if (!s || !Array.isArray(s.exercises)) return 0;
    return s.exercises.reduce((sum, ex) => sum + ((ex.value || 0) * (ex.points || 0)), 0) + (s.difficultyBonus || 0);
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

  function exerciseIcon(ex) {
    const id = (ex.id || '').toLowerCase();
    const name = (ex.name || '').toLowerCase();
    if (id.includes('pompe') || name.includes('pompe')) return '💪';
    if (id.includes('traction') || name.includes('traction')) return '🏋️';
    if (id.includes('abdo') || name.includes('abdo')) return '🔥';
    if (id.includes('course') || name.includes('course') || name.includes('run')) return '🏃';
    if (id.includes('gainage') || name.includes('gainage') || name.includes('planche')) return '⏱️';
    return '✨';
  }

  function buildForm() {
    const form = document.getElementById('exerciseForm');
    if (!form) return;
    form.innerHTML = '';
    if (typeof ensureExercises === 'function') ensureExercises();
    if (!state || !Array.isArray(state.exercises) || !state.exercises.length) return;
    state.exercises.forEach(ex => {
      const field = document.createElement('div');
      field.className = 'exo-card field';
      field.innerHTML = `
        <div class="exo-card-head">
          <span class="exo-ico">${exerciseIcon(ex)}</span>
          <div class="exo-titles">
            <div class="exo-name">${escapeHtml(ex.name)}</div>
            <div class="exo-pts">${ex.points} pts / ${escapeHtml(ex.unit)}</div>
          </div>
        </div>
        <input type="number" min="0" ${ex.decimal ? 'step="0.1"' : 'step="1"'} inputmode="${ex.decimal ? 'decimal' : 'numeric'}" placeholder="0" data-ex-id="${ex.id}">
        <button type="button" class="exo-add-btn" data-ex-add="${ex.id}">+ Ajouter</button>
      `;
      form.appendChild(field);
    });

    form.querySelectorAll('[data-ex-add]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-ex-add');
        const inp = form.querySelector(`input[data-ex-id="${id}"]`);
        const v = parseFloat(inp && inp.value) || 0;
        if (!v) {
          flash('Entre une valeur pour cet exercice.');
          if (inp) inp.focus();
          return;
        }
        const entries = [{ id, v }];
        pendingEntries = entries;
        openDifficultyModal(entries);
      });
    });
  }

  function isTimeUnit(unit) {
    return /minute|seconde|heure/i.test(unit);
  }

  function buildTimerExerciseSelect() {
    const select = document.getElementById('timerExercise');
    if (!select) return;
    if (typeof ensureExercises === 'function') ensureExercises();
    const selectedId = select.value;
    select.innerHTML = '';
    const timeExercises = (state.exercises || []).filter(ex => isTimeUnit(ex.unit));
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
    const stats = state.challengeStats || { wins: 0, multiWins: 0, played: 0 };
    const wins = stats.wins || 0;
    const played = stats.played || 0;
    const multi = stats.multiWins || 0;
    const lvl = levelFromXp(state.xp || 0);

    return [
      { id: 'premier-jour',   icon: '🥉', img: 'badges/premier-jour.png',   label: 'Premier jour',                liveDone: daysCount >= 1,     current: daysCount, target: 1,     unit: 'jour', reward: { xp: 25, avatar: 'flame' } },
      { id: 'une-semaine',    icon: '📅', img: 'badges/une-semaine.png',    label: 'Une semaine d\'affilée',       liveDone: streak >= 7,        current: streak, target: 7,     unit: 'jours', reward: { xp: 40, avatar: 'bolt', font: 'mono' } },
      { id: 'un-mois',        icon: '🗓️', img: 'badges/un-mois.png',        label: 'Un mois d\'affilée',           liveDone: streak >= 30,       current: streak, target: 30,    unit: 'jours', reward: { xp: 100, avatar: 'rocket' } },
      { id: 'premier-record', icon: '🏆', img: 'badges/premier-record.png', label: 'Premier record battu',        liveDone: !!state.records.bestScore, current: null, target: null, unit: '', reward: { xp: 35, avatar: 'dragon' } },
      { id: 'perf-extreme',   icon: '👑', img: 'badges/perf-extreme.png',   label: 'Performance extrême atteint', liveDone: reachedPerfExtreme, current: bestScoreEver, target: perfExtremeMin, unit: 'pts', reward: { xp: 80, avatar: 'crown' } },
      { id: 'hacker',         icon: '🖥️', img: 'badges/hacker.png',         label: 'Rang Hacker atteint',         liveDone: reachedHacker,      current: bestScoreEver, target: hackerMin, unit: 'pts', reward: { xp: 120, avatar: 'skull', font: 'neon' } },
      { id: 'mille-pts',      icon: '🔥', img: 'badges/mille-pts.png',      label: '1 000 pts cumulés',           liveDone: allTime >= 1000,    current: allTime, target: 1000,  unit: 'pts', reward: { xp: 30, avatar: 'flame' } },
      { id: 'cinq-mille-pts', icon: '⭐', img: 'badges/cinq-mille-pts.png', label: '5 000 pts cumulés',           liveDone: allTime >= 5000,    current: allTime, target: 5000,  unit: 'pts', reward: { xp: 60, avatar: 'diamond' } },
      { id: 'dix-mille-pts',  icon: '🏔️', img: 'badges/dix-mille-pts.png',  label: '10 000 pts cumulés',          liveDone: allTime >= 10000,   current: allTime, target: 10000, unit: 'pts', reward: { xp: 150, avatar: 'phoenix', font: 'display' } },
      { id: 'premier-sang',   icon: '⚔️', img: null, label: 'Premier sang I',  liveDone: wins >= 1,  current: wins, target: 1,  unit: 'victoire', tier: 1, family: 'sang', reward: { xp: 30, avatar: 'dragon' } },
      { id: 'premier-sang-2', icon: '⚔️', img: null, label: 'Premier sang II', liveDone: wins >= 5,  current: wins, target: 5,  unit: 'victoires', tier: 2, family: 'sang', reward: { xp: 50, font: 'mono' } },
      { id: 'premier-sang-3', icon: '⚔️', img: null, label: 'Premier sang III',liveDone: wins >= 15, current: wins, target: 15, unit: 'victoires', tier: 3, family: 'sang', reward: { xp: 100, avatar: 'phoenix' } },
      { id: 'duelliste',      icon: '🗡️', img: null, label: 'Duelliste I',     liveDone: played >= 5,  current: played, target: 5,  unit: 'défis', tier: 1, family: 'duel', reward: { xp: 25, avatar: 'bolt' } },
      { id: 'duelliste-2',    icon: '🗡️', img: null, label: 'Duelliste II',    liveDone: played >= 15, current: played, target: 15, unit: 'défis', tier: 2, family: 'duel', reward: { xp: 50, avatar: 'skull' } },
      { id: 'duelliste-3',    icon: '🗡️', img: null, label: 'Duelliste III',   liveDone: played >= 40, current: played, target: 40, unit: 'défis', tier: 3, family: 'duel', reward: { xp: 90, font: 'display' } },
      { id: 'meute',          icon: '👥', img: null, label: 'Esprit de meute I',  liveDone: multi >= 1, current: multi, target: 1, unit: 'multi', tier: 1, family: 'meute', reward: { xp: 40, avatar: 'wolf' } },
      { id: 'meute-2',        icon: '👥', img: null, label: 'Esprit de meute II', liveDone: multi >= 3, current: multi, target: 3, unit: 'multi', tier: 2, family: 'meute', reward: { xp: 70, font: 'neon' } },
      { id: 'meute-3',        icon: '👥', img: null, label: 'Esprit de meute III',liveDone: multi >= 10,current: multi, target: 10,unit: 'multi', tier: 3, family: 'meute', reward: { xp: 150, avatar: 'phoenix' } },
      { id: 'niveau-10',      icon: '🔟', img: null, label: 'Niveau 10', liveDone: lvl >= 10, current: lvl, target: 10, unit: 'niv', reward: { xp: 20, avatar: 'rocket' } },
      { id: 'niveau-25',      icon: '🌟', img: null, label: 'Niveau 25', liveDone: lvl >= 25, current: lvl, target: 25, unit: 'niv', reward: { xp: 40, avatar: 'diamond', font: 'mono' } },
      { id: 'niveau-50',      icon: '💫', img: null, label: 'Niveau 50', liveDone: lvl >= 50, current: lvl, target: 50, unit: 'niv', reward: { xp: 80, avatar: 'phoenix', font: 'display' } },
      { id: 'mythique',       icon: '🌌', img: null, label: 'Rang Mythique — niveau 100', liveDone: lvl >= 100, current: lvl, target: 100, unit: 'niv', reward: { xp: 300, avatar: 'mythic', font: 'neon' } },
    ];
  }

  const AVATAR_CATALOG = {
    default: { emoji: '🙂', label: 'Classique' },
    flame: { emoji: '🔥', label: 'Flamme' },
    bolt: { emoji: '⚡', label: 'Éclair' },
    dragon: { emoji: '🐉', label: 'Dragon' },
    skull: { emoji: '💀', label: 'Crâne' },
    rocket: { emoji: '🚀', label: 'Fusée' },
    crown: { emoji: '👑', label: 'Couronne' },
    diamond: { emoji: '💎', label: 'Diamant' },
    wolf: { emoji: '🐺', label: 'Loup' },
    phoenix: { emoji: '🦅', label: 'Phénix' },
    mythic: { emoji: '🌌', label: 'Mythique' }
  };

  const FONT_CATALOG = {
    default: { label: 'Standard', css: 'var(--font-body)' },
    mono: { label: 'Mono tech', css: 'var(--font-mono)' },
    neon: { label: 'Néon', css: '"Orbitron", var(--font-body)' },
    display: { label: 'Affiche', css: '"Bebas Neue", "Arial Narrow", sans-serif' }
  };

  function grantBadgeReward(badge) {
    if (!badge || !badge.reward) return;
    if (!state.badgeRewardsClaimed) state.badgeRewardsClaimed = [];
    if (state.badgeRewardsClaimed.includes(badge.id)) return;
    state.badgeRewardsClaimed.push(badge.id);
    const r = badge.reward;
    const gained = [];
    if (r.xp && r.xp > 0) {
      state.xp = (state.xp || 0) + r.xp;
      gained.push('+' + r.xp + ' XP');
    }
    if (r.avatar) {
      if (!state.unlockedAvatars) state.unlockedAvatars = ['default'];
      if (!state.unlockedAvatars.includes(r.avatar)) {
        state.unlockedAvatars.push(r.avatar);
        const a = AVATAR_CATALOG[r.avatar];
        gained.push('Avatar ' + (a ? a.emoji + ' ' + a.label : r.avatar));
      }
    }
    if (r.font) {
      if (!state.unlockedFonts) state.unlockedFonts = ['default'];
      if (!state.unlockedFonts.includes(r.font)) {
        state.unlockedFonts.push(r.font);
        gained.push('Police');
      }
    }
    saveState();
    if (gained.length) {
      if (typeof flash === 'function') flash('Récompense : ' + gained.join(' · '));
      if (typeof showAppToast === 'function') showAppToast('Récompense badge', gained.join(' · '));
    }
    try { if (typeof renderProfile === 'function') renderProfile(); } catch (e) {}
  }


  function claimAllUnlockedBadgeRewards() {
    const list = getBadges();
    const seen = Array.isArray(state.seenBadges) ? state.seenBadges : [];
    list.forEach(b => {
      if (b.liveDone || seen.includes(b.id)) {
        // si badge obtenu mais récompense jamais prise
        grantBadgeReward(b);
      }
    });
  }

  function applyCosmeticTheme() {
    const font = FONT_CATALOG[state.selectedFont] || FONT_CATALOG.default;
    document.documentElement.style.setProperty('--user-font', font.css);
    document.body.style.fontFamily = 'var(--user-font), var(--font-body)';
  }

  function medalIconHtml(b) {
    if (b.img) {
      return `<img src="${b.img}" alt="" onload="this.style.display='block';" onerror="this.style.display='none';this.nextElementSibling.style.display='block';">
      <span class="medal-emoji" style="display:none;">${b.icon}</span>`;
    }
    return `<span class="medal-emoji" style="display:block;font-size:28px;">${b.icon}</span>`;
  }

  function badgeProgressText(b) {
    const tierStars = b.tier ? `<div class="medal-tier">${'★'.repeat(b.tier)}${'☆'.repeat(Math.max(0, 3 - b.tier))}</div>` : '';
    if (b.done) return tierStars;
    if (b.target === null) return tierStars;
    const current = Math.min(Math.round(b.current), b.target);
    return `${tierStars}<div class="medal-progress">${current} / ${b.target} ${b.unit}</div>`;
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
        newlyUnlocked.forEach((b, i) => {
          grantBadgeReward(b);
          setTimeout(() => showBadgeToast(b), i * 3200);
        });
        state.seenBadges = [...state.seenBadges, ...newlyUnlocked.map(b => b.id)];
        saveState();
        if (typeof saveToCloud === 'function') saveToCloud();
        if (typeof applyCosmeticTheme === 'function') applyCosmeticTheme();
      }
    }

    // Rattrapage une seule fois par session
    if (!window._badgeRewardsCatchupDone) {
      window._badgeRewardsCatchupDone = true;
      claimAllUnlockedBadgeRewards();
    }

    const badges = rawBadges.map(b => ({ ...b, done: (state.seenBadges || []).includes(b.id) || !!b.liveDone }));

    checkSecretBadge(badges);

    const allBadges = badges.slice();
    if (state.secretBadgeUnlocked) {
      allBadges.push({ ...SECRET_BADGE, done: true, current: null, target: null, unit: '' });
    }

    const medalsHtml = allBadges.map(b => `
      <div class="medal">
        <div class="medal-circle ${b.done ? 'unlocked' : 'locked'} ${b.id === SECRET_BADGE.id ? 'secret-unlocked' : ''}">${medalIconHtml(b)}</div>
        <div class="medal-label ${b.done ? '' : 'locked'}">${b.label}</div>
        ${badgeProgressText(b)}
      </div>
    `).join('');
    wrap.innerHTML = medalsHtml;

    // Aperçu compact sur l'accueil (max 6)
    const homeWrap = document.getElementById('homeBadgesWrap');
    if (homeWrap) {
      const preview = allBadges.slice(0, 12).map(b => `
        <div class="medal home-medal">
          <div class="medal-circle ${b.done ? 'unlocked' : 'locked'} ${b.id === SECRET_BADGE.id ? 'secret-unlocked' : ''}">${medalIconHtml(b)}</div>
          <div class="medal-label ${b.done ? '' : 'locked'}">${b.label}</div>
        </div>
      `).join('');
      homeWrap.innerHTML = preview || '<div class="chart-empty">Aucun badge pour l’instant.</div>';
    }
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
    const data = computeAllTimePointsByExercise();
    const targets = ['radarWrap', 'homeRadarWrap', 'homeRadarWrapMobile']
      .map(id => document.getElementById(id))
      .filter(Boolean);

    if (!targets.length) return;

    if (data.length < 3) {
      targets.forEach(wrap => {
        wrap.innerHTML = '<div class="chart-empty">Ajoutez au moins 3 exercices pour voir la vue en étoile.</div>';
      });
      return;
    }

    const n = data.length;
    const w = 340, h = 360;
    const cx = w / 2, cy = 165;
    const R = 95;
    const maxVal = Math.max(...data.map(d => d.points), 10) * 1.15;
    const isLight = document.body.classList.contains('light-theme');
    const gridStroke = isLight ? '#D5E0D8' : '#243028';
    const labelFill = isLight ? '#5C6B62' : '#8B968F';
    const accent = isLight ? '#22C55E' : '#7CFF3A';
    const accentFill = isLight ? 'rgba(34,197,94,0.22)' : 'rgba(124,255,58,0.22)';

    function pointFor(i, ratio) {
      const angle = -Math.PI / 2 + i * (2 * Math.PI / n);
      const r = R * ratio;
      return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
    }

    let gridPolys = '';
    [0.25, 0.5, 0.75, 1].forEach(frac => {
      const pts = data.map((_, i) => pointFor(i, frac).join(',')).join(' ');
      gridPolys += `<polygon points="${pts}" fill="none" stroke="${gridStroke}" stroke-width="1" opacity="0.7"/>`;
    });

    const axisLines = data.map((_, i) => {
      const [x, y] = pointFor(i, 1);
      return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${gridStroke}" stroke-width="1" opacity="0.7"/>`;
    }).join('');

    const dataPts = data.map((d, i) => pointFor(i, Math.min(1, d.points / maxVal)).map(v => v.toFixed(1)).join(',')).join(' ');
    const dataPoly = `<polygon points="${dataPts}" fill="${accentFill}" stroke="${accent}" stroke-width="2.5"/>`;
    const dataCircles = data.map((d, i) => {
      const [x, y] = pointFor(i, Math.min(1, d.points / maxVal));
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${accent}" />`;
    }).join('');

    const labels = data.map((d, i) => {
      const [x, y] = pointFor(i, 1.3);
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="10" fill="${labelFill}" text-anchor="middle" font-family="IBM Plex Mono, monospace">${escapeHtml(d.name)}</text>
              <text x="${x.toFixed(1)}" y="${(y+12).toFixed(1)}" font-size="10" fill="${accent}" font-weight="700" text-anchor="middle" font-family="IBM Plex Mono, monospace">${d.points} pts</text>`;
    }).join('');

    const html = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" style="max-width: 340px;">
      ${gridPolys}
      ${axisLines}
      ${dataPoly}
      ${dataCircles}
      ${labels}
    </svg>`;
    targets.forEach(wrap => { wrap.innerHTML = html; });
  }

  function render() {
    try {
    if (!state || !Array.isArray(state.exercises)) {
      console.warn('state invalide, reset partiel');
      state = Object.assign(defaultState(), state || {});
      if (!Array.isArray(state.exercises)) state.exercises = defaultExercises();
    }
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
    if (typeof renderHomeMiniCal === "function") renderHomeMiniCal();

    document.getElementById('dateBadge').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short' });

    renderHistory();
    if (document.getElementById('section-calendar')?.classList.contains('active') ||
        document.getElementById('section-calendar')?.style.display === 'block') {
      renderCalendar();
    }
    // Pas de sync cloud ici : render = affichage uniquement
    // (le local + cloud sont gérés par les actions utilisateur via saveState)
    } catch (err) {
      console.error('render error', err);
      try { showSection('section-today'); } catch (e) {}
    }
  }

  /* ---- CALENDRIER ---- */
  let calView = new Date(); // mois affiché
  let calSelectedKey = null;

  function scoreForDay(dayKey) {
    if (dayKey === state.dayKey) return Math.round(computeScore(state));
    const h = (state.history || []).find(x => x.day === dayKey);
    return h ? Math.round(h.score || 0) : null;
  }

  function countBadgesProgress() {
    const list = typeof getBadges === 'function' ? getBadges() : [];
    const seen = Array.isArray(state.seenBadges) ? state.seenBadges : [];
    let unlocked = list.filter(b => seen.includes(b.id) || !!b.liveDone).length;
    let total = list.length;
    // Badge secret : compte dans le total seulement s'il est débloqué (sinon X/12, avec secret → X/13)
    if (state.secretBadgeUnlocked) {
      unlocked += 1;
      total += 1;
    }
    return { unlocked, total };
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
      const planned = state.plannedSessions && state.plannedSessions[key];
      const planCh = state.plannedChallenges && state.plannedChallenges[key];
      const chRes = state.challengeDayResults && state.challengeDayResults[key];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cal-day';
      if (key === todayK) btn.classList.add('today');
      if (sc !== null && sc > 0) btn.classList.add('has-score');
      if (note) btn.classList.add('has-note');
      if (planned) btn.classList.add('has-plan');
      if (planCh && planCh.length) btn.classList.add('has-plan-ch');
      if (chRes && chRes.length) btn.classList.add('has-ch-result');
      if (key === calSelectedKey) btn.classList.add('selected');
      let dots = '';
      if (planned) dots += '<span class="cd-dot plan" title="Séance prévue"></span>';
      if (planCh && planCh.length) dots += '<span class="cd-dot challenge" title="Défi prévu"></span>';
      if (chRes && chRes.length) dots += '<span class="cd-dot result" title="Résultat défi"></span>';
      btn.innerHTML = `<span class="cd-num">${d}</span>` +
        (sc !== null && sc > 0 ? `<span class="cd-score">${sc}</span>` : '') +
        (dots ? `<span class="cd-dots">${dots}</span>` : '');
      btn.addEventListener('click', () => selectCalDay(key));
      grid.appendChild(btn);
    }
    renderHomeMiniCal();
  }


  function renderHomeMiniCal() {
    const targets = [
      { grid: 'homeCalGrid', label: 'homeCalLabel' },
      { grid: 'homeCalGridMobile', label: 'homeCalLabelMobile' }
    ];
    const year = calView.getFullYear();
    const month = calView.getMonth();
    const first = new Date(year, month, 1);
    const startPad = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayK = todayKey();
    const monthLabel = calView.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

    targets.forEach(t => {
      const grid = document.getElementById(t.grid);
      const label = document.getElementById(t.label);
      if (!grid) return;
      if (label) label.textContent = monthLabel;
      grid.innerHTML = '';
      for (let i = 0; i < startPad; i++) {
        const empty = document.createElement('div');
        empty.className = 'mini-cal-day empty';
        grid.appendChild(empty);
      }
      for (let d = 1; d <= daysInMonth; d++) {
        const key = year + '-' + (month + 1) + '-' + d;
        const sc = scoreForDay(key);
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'mini-cal-day';
        if (key === todayK) cell.classList.add('today');
        if (sc !== null && sc > 0) cell.classList.add('has-score');
        if (state.plannedSessions && state.plannedSessions[key]) cell.classList.add('has-plan');
        cell.textContent = String(d);
        cell.addEventListener('click', () => {
          calSelectedKey = key;
          showSection('section-calendar');
          selectCalDay(key);
          closeNav();
        });
        grid.appendChild(cell);
      }
    });
  }

  function exercisesForDay(dayKey) {
    // Aujourd'hui = exercices en cours
    if (dayKey === state.dayKey) {
      return (state.exercises || [])
        .filter(ex => (ex.value || 0) > 0)
        .map(ex => ({
          name: ex.name,
          value: ex.value,
          unit: ex.unit || '',
          points: Math.round((ex.value || 0) * (ex.points || 0) * 10) / 10
        }));
    }
    const h = (state.history || []).find(x => x.day === dayKey);
    if (!h || !h.byExercise) return [];
    return Object.keys(h.byExercise).map(id => {
      const rec = h.byExercise[id];
      if (!rec || !(rec.value > 0)) return null;
      return {
        name: rec.name || id,
        value: rec.value,
        unit: rec.unit || '',
        points: null
      };
    }).filter(Boolean);
  }

  function selectCalDay(key) {
    calSelectedKey = key;
    renderCalendar();
    const title = document.getElementById('calDetailTitle');
    const scoreEl = document.getElementById('calDetailScore');
    const exosEl = document.getElementById('calDetailExos');
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
      const h = (state.history || []).find(x => x.day === key);
      const rankName = h && h.rank && h.rank.name ? h.rank.name : '';
      scoreEl.textContent = rankName ? `Score : ${sc} pts · ${rankName}` : `Score : ${sc} pts`;
    } else {
      scoreEl.textContent = 'Aucun score enregistré ce jour-là';
    }

    // Détail des exercices faits ce jour-là
    if (exosEl) {
      const list = exercisesForDay(key);
      if (!list.length) {
        exosEl.innerHTML = '<div class="cal-exos-empty">Aucun exercice enregistré ce jour.</div>';
      } else {
        exosEl.innerHTML = '<div class="cal-exos-title">Séance du jour</div><ul class="cal-exos-list">' +
          list.map(ex => {
            const val = (typeof ex.value === 'number' && ex.value % 1 !== 0)
              ? ex.value.toFixed(1)
              : String(ex.value);
            const pts = ex.points != null ? ` <span class="cal-exo-pts">(${ex.points} pts)</span>` : '';
            return `<li><strong>${escapeHtml(ex.name)}</strong> — ${escapeHtml(val)} ${escapeHtml(ex.unit || '')}${pts}</li>`;
          }).join('') +
          '</ul>';
      }
    }

    noteInput.value = (state.dayNotes && state.dayNotes[key]) || '';

    // Mini-séance prévue
    const plannedBox = document.getElementById('calPlannedBox');
    const planTitle = document.getElementById('calPlanTitle');
    const planDetails = document.getElementById('calPlanDetails');
    const plan = state.plannedSessions && state.plannedSessions[key];
    if (planTitle) planTitle.value = plan ? (plan.title || '') : '';
    if (planDetails) planDetails.value = plan ? (plan.details || '') : '';
    if (plannedBox) {
      if (plan && (plan.title || plan.details)) {
        plannedBox.innerHTML = `<div class="cal-plan-card"><div class="cal-plan-label">📋 Mini-séance prévue</div><strong>${escapeHtml(plan.title || 'Séance')}</strong><div>${escapeHtml(plan.details || '')}</div></div>`;
      } else {
        plannedBox.innerHTML = '';
      }
    }

    // Défis prévus + résultats
    const chBox = document.getElementById('calChallengeResults');
    const planChInput = document.getElementById('calPlanChallenge');
    if (planChInput) planChInput.value = '';
    if (chBox) {
      const plannedCh = (state.plannedChallenges && state.plannedChallenges[key]) || [];
      const results = (state.challengeDayResults && state.challengeDayResults[key]) || [];
      let html = '';
      if (plannedCh.length) {
        html += '<div class="cal-plan-card"><div class="cal-plan-label">🏆 Défis programmés</div><ul class="cal-exos-list">' +
          plannedCh.map((t, i) => `<li>${escapeHtml(t)} <button type="button" class="cal-mini-x" data-rm-plan-ch="${i}">×</button></li>`).join('') +
          '</ul></div>';
      }
      if (results.length) {
        html += '<div class="cal-plan-card result"><div class="cal-plan-label">📊 Résultats de défis</div><ul class="cal-exos-list">' +
          results.map(r => `<li><strong>${escapeHtml(r.title || 'Défi')}</strong> — ${escapeHtml(r.result || '')}</li>`).join('') +
          '</ul></div>';
      }
      chBox.innerHTML = html;
      chBox.querySelectorAll('[data-rm-plan-ch]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.getAttribute('data-rm-plan-ch'), 10);
          if (!state.plannedChallenges[key]) return;
          state.plannedChallenges[key].splice(idx, 1);
          if (!state.plannedChallenges[key].length) delete state.plannedChallenges[key];
          saveState();
          selectCalDay(key);
          renderCalendar();
        });
      });
    }
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

  function saveCalPlan() {
    if (!calSelectedKey) {
      document.getElementById('calFlash').textContent = 'Choisis un jour d’abord.';
      return;
    }
    if (!state.plannedSessions) state.plannedSessions = {};
    const title = (document.getElementById('calPlanTitle').value || '').trim();
    const details = (document.getElementById('calPlanDetails').value || '').trim();
    if (!title && !details) {
      delete state.plannedSessions[calSelectedKey];
    } else {
      state.plannedSessions[calSelectedKey] = { title, details };
    }
    saveState();
    if (typeof saveToCloud === 'function') saveToCloud();
    selectCalDay(calSelectedKey);
    renderCalendar();
    document.getElementById('calFlash').textContent = 'Mini-séance enregistrée.';
  }

  function saveCalChallengePlan() {
    if (!calSelectedKey) {
      document.getElementById('calFlash').textContent = 'Choisis un jour d’abord.';
      return;
    }
    const text = (document.getElementById('calPlanChallenge').value || '').trim();
    if (!text) {
      document.getElementById('calFlash').textContent = 'Écris un rappel de défi.';
      return;
    }
    if (!state.plannedChallenges) state.plannedChallenges = {};
    if (!state.plannedChallenges[calSelectedKey]) state.plannedChallenges[calSelectedKey] = [];
    state.plannedChallenges[calSelectedKey].push(text.slice(0, 80));
    saveState();
    if (typeof saveToCloud === 'function') saveToCloud();
    document.getElementById('calPlanChallenge').value = '';
    selectCalDay(calSelectedKey);
    renderCalendar();
    document.getElementById('calFlash').textContent = 'Défi ajouté au jour.';
  }

  function recordChallengeDayResult(title, resultText) {
    const key = todayKey();
    if (!state.challengeDayResults) state.challengeDayResults = {};
    if (!state.challengeDayResults[key]) state.challengeDayResults[key] = [];
    state.challengeDayResults[key].push({
      title: String(title || 'Défi').slice(0, 80),
      result: String(resultText || '').slice(0, 160),
      at: Date.now()
    });
    // garde max 12 résultats / jour
    if (state.challengeDayResults[key].length > 12) {
      state.challengeDayResults[key] = state.challengeDayResults[key].slice(-12);
    }
    saveState();
  }

  /* ---- XP / PROFIL ---- */
  function xpForLevel(level) {
    // XP total needed to REACH this level (level 1 = 0)
    return Math.floor(50 * Math.pow(level - 1, 1.65));
  }
  function levelFromXp(xp) {
    let level = 1;
    while (xpForLevel(level + 1) <= xp && level < 120) level++;
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

  function renderCosmeticsPickers() {
    const avBox = document.getElementById('profileAvatarPicker');
    const fontBox = document.getElementById('profileFontPicker');
    if (avBox) {
      const unlocked = state.unlockedAvatars || ['default'];
      avBox.innerHTML = Object.keys(AVATAR_CATALOG).map(id => {
        const a = AVATAR_CATALOG[id];
        const isOn = unlocked.includes(id);
        const sel = state.selectedAvatar === id ? 'selected' : '';
        const lock = isOn ? '' : ' locked';
        return `<button type="button" class="cosmetic-chip ${sel}${lock}" data-avatar="${id}" title="${a.label}${isOn ? '' : ' (verrouillé)'}" ${isOn ? '' : 'disabled'}>${a.emoji}</button>`;
      }).join('');
      avBox.querySelectorAll('[data-avatar]:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => {
          state.selectedAvatar = btn.getAttribute('data-avatar');
          saveState();
          if (typeof saveToCloud === 'function') saveToCloud();
          renderProfile();
        });
      });
    }
    if (fontBox) {
      const unlocked = state.unlockedFonts || ['default'];
      fontBox.innerHTML = unlocked.map(id => {
        const f = FONT_CATALOG[id] || { label: id };
        const sel = state.selectedFont === id ? 'selected' : '';
        return `<button type="button" class="cosmetic-chip font ${sel}" data-font="${id}">${f.label}</button>`;
      }).join('');
      fontBox.querySelectorAll('[data-font]').forEach(btn => {
        btn.addEventListener('click', () => {
          state.selectedFont = btn.getAttribute('data-font');
          saveState();
          applyCosmeticTheme();
          if (typeof saveToCloud === 'function') saveToCloud();
          renderCosmeticsPickers();
        });
      });
    }
  }

  async function renderProfile() {
    const pseudoEl = document.getElementById('profilePseudo');
    const emailEl = document.getElementById('profileEmail');
    const avatarEl = document.getElementById('profileAvatar');
    if (!pseudoEl) return;

    const pseudo = state.pseudo || (currentUser && (currentUser.displayName || currentUser.email?.split('@')[0])) || 'Invité';
    pseudoEl.textContent = state.pseudo ? '@' + state.pseudo : pseudo;
    emailEl.textContent = currentUser?.email || (currentUser ? 'Connecté' : 'Données locales');
    const av = (state.selectedAvatar && AVATAR_CATALOG[state.selectedAvatar])
      ? AVATAR_CATALOG[state.selectedAvatar].emoji
      : (state.pseudo || pseudo || '?').slice(0, 1).toUpperCase();
    avatarEl.textContent = av;
    const levelBadge = document.getElementById('profileLevelBadge');
    if (levelBadge) levelBadge.textContent = String(levelFromXp(state.xp || 0));
    applyCosmeticTheme();
    renderCosmeticsPickers();

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

    // Stats défis (cache + stats persistées)
    let won = (state.challengeStats && state.challengeStats.wins) || 0;
    let played = (state.challengeStats && state.challengeStats.played) || 0;
    let multiWins = (state.challengeStats && state.challengeStats.multiWins) || 0;
    if (typeof cachedChallenges === 'object' && cachedChallenges) {
      Object.values(cachedChallenges).forEach(ch => {
        if (!currentUser) return;
        if (ch.status !== 'completed') return;
        const inCh = ch.fromUid === currentUser.uid || ch.toUid === currentUser.uid ||
          (Array.isArray(ch.participants) && ch.participants.includes(currentUser.uid));
        if (!inCh) return;
        tryClaimChallengeXp(ch);
      });
    }
    document.getElementById('statChallengesWon').textContent = String(won);
    document.getElementById('statChallengesPlayed').textContent = String(played);
    const multiEl = document.getElementById('statMultiWins');
    if (multiEl) multiEl.textContent = String(multiWins);

    const scoreNow = Math.round(computeScore(state));
    const rank = getRank(scoreNow).current;
    const rankLine = document.getElementById('profileRankLine');
    if (rankLine) {
      rankLine.innerHTML = `Rang du jour : <strong style="color:${rank.color}">${escapeHtml(rank.name)}</strong> · ${scoreNow} pts`;
    }
    const rankPill = document.getElementById('profileRankPill');
    if (rankPill) {
      rankPill.textContent = rank.name;
      rankPill.style.background = rank.color;
      rankPill.style.color = rank.ink || '#0b0a10';
    }
    const avWrap = document.querySelector('.profile-avatar-wrap');
    if (avWrap) avWrap.style.setProperty('--rank-color', rank.color);

    const bc = countBadgesProgress();
    const badgeStat = document.getElementById('statBadges');
    if (badgeStat) badgeStat.textContent = bc.unlocked + '/' + bc.total;

    const prev = document.getElementById('profileBadgesPreview');
    if (prev) {
      const raw = getBadges().map(b => ({
        ...b,
        done: (state.seenBadges || []).includes(b.id) || !!b.liveDone
      }));
      if (state.secretBadgeUnlocked) {
        raw.push({ id: 'secret', icon: '💎', img: 'badges/collectionneur.png', label: 'Collectionneur', done: true });
      }
      prev.innerHTML = raw.slice(0, 8).map(b =>
        `<div class="profile-badge-chip ${b.done ? 'on' : 'off'}" title="${escapeHtml(b.label)}">${b.icon}</div>`
      ).join('');
    }

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

  try {
    if (typeof ensureExercises === 'function') ensureExercises();
    try { buildTubeBands(); } catch (e) { console.warn('boot tube', e); }
    try { buildLegend(); } catch (e) { console.warn('boot legend', e); }
    try { buildForm(); } catch (e) { console.warn('boot form', e); }
    try { buildTimerExerciseSelect(); } catch (e) { console.warn('boot timer', e); }
    try { buildChartTabs(); } catch (e) { console.warn('boot chart', e); }
    try { initTips(); } catch (e) { console.warn('boot tips', e); }
    try { showSection('section-today'); } catch (e) {}
    try { updateAdminButtonVisibility(); } catch (e) {}
    try { render(); } catch (e) { console.warn('boot render', e); }
  } catch (err) {
    console.error('boot error', err);
    try { showSection('section-today'); } catch (e) {}
  }

  if (!state.userName) {
    try { openEditModal(); } catch (e) {}
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
  document.getElementById('calSavePlanBtn')?.addEventListener('click', saveCalPlan);
  document.getElementById('calSaveChallengePlanBtn')?.addEventListener('click', saveCalChallengePlan);
  document.getElementById('homeCalOpenBtn')?.addEventListener('click', () => {
    showSection('section-calendar');
    closeNav();
  });
  document.getElementById('homeCalOpenBtnMobile')?.addEventListener('click', () => {
    showSection('section-calendar');
    closeNav();
  });
  document.getElementById('dateBadge')?.addEventListener('click', () => {
    showSection('section-calendar');
    closeNav();
  });
  document.getElementById('homeBadgesMoreBtn')?.addEventListener('click', () => {
    showSection('section-badges');
    closeNav();
  });

  document.getElementById('navSettingsLink').addEventListener('click', () => {
    closeNav();
    openEditModal();
  });

  /* ---- THEME TOGGLE ---- */
  const THEME_KEY = 'note_journaliere_theme';
  let currentTheme = 'light';

  function applyTheme(theme) {
    currentTheme = theme;
    const isLight = theme === 'light';
    document.body.classList.toggle('light-theme', isLight);
    document.getElementById('themeDarkBtn').classList.toggle('active', !isLight);
    document.getElementById('themeLightBtn').classList.toggle('active', isLight);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  }

  try { currentTheme = localStorage.getItem(THEME_KEY) || 'light'; } catch (e) {}
  applyTheme(currentTheme);

  document.getElementById('themeDarkBtn').addEventListener('click', () => applyTheme('dark'));
  document.getElementById('themeLightBtn').addEventListener('click', () => applyTheme('light'));

  /* ---- ADMIN MODE (email only, no secret code) ---- */
  const ADMIN_EMAIL = 'tomericklegros@gmail.com';

  function isAdminUser() {
    const email = (currentUser && currentUser.email) ? currentUser.email.toLowerCase().trim() : '';
    return email === ADMIN_EMAIL;
  }

  function updateAdminButtonVisibility() {
    const show = isAdminUser();
    const btn = document.getElementById('adminBtn');
    if (btn) {
      btn.style.display = show ? 'block' : 'none';
      btn.style.opacity = show ? '1' : '0.5';
    }
    const nav = document.getElementById('adminNavBtn');
    if (nav) nav.style.display = show ? 'flex' : 'none';
  }

  function buildAdminBadgeSelect() {
    const select = document.getElementById('adminBadgeSelect');
    if (!select) return;
    const options = getBadges().concat([{ id: SECRET_BADGE.id, label: '💎 ' + SECRET_BADGE.label }]);
    select.innerHTML = options.map(b => `<option value="${b.id}">${escapeHtml(b.label)}</option>`).join('');
  }

  function openAdminPanel() {
    if (!isAdminUser()) {
      alert('Accès admin réservé.');
      return;
    }
    buildAdminBadgeSelect();
    document.getElementById('adminPanelOverlay').classList.add('open');
  }

  document.getElementById('adminNavBtn')?.addEventListener('click', () => {
    document.getElementById('adminBtn')?.click();
  });
  document.getElementById('adminBtn').addEventListener('click', () => {
    if (!currentUser) {
      alert('Connecte-toi avec le compte admin.');
      openLoginModal();
      return;
    }
    if (!isAdminUser()) {
      alert('Accès refusé.');
      return;
    }
    openAdminPanel();
  });

  document.getElementById('adminPanelClose').addEventListener('click', () => {
    document.getElementById('adminPanelOverlay').classList.remove('open');
  });
  document.getElementById('adminPanelOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'adminPanelOverlay') document.getElementById('adminPanelOverlay').classList.remove('open');
  });


  /* ---- Message admin global (broadcast) ---- */
  const BROADCAST_DISMISS_KEY = 'note_broadcast_dismissed_id';
  let broadcastUnsub = null;
  let currentBroadcastId = null;

  function getDismissedBroadcastId() {
    try { return localStorage.getItem(BROADCAST_DISMISS_KEY) || ''; } catch (e) { return ''; }
  }
  function setDismissedBroadcastId(id) {
    try { localStorage.setItem(BROADCAST_DISMISS_KEY, id || ''); } catch (e) {}
  }

  function showGlobalBroadcast(data) {
    const banner = document.getElementById('globalBroadcastBanner');
    if (banner) banner.style.display = 'none'; return;
    const body = document.getElementById('globalBroadcastBody');
    if (!banner || !body) return;
    if (!data || !data.message || !data.id) {
      banner.style.display = 'none';
      return;
    }
    if (getDismissedBroadcastId() === data.id) {
      banner.style.display = 'none';
      return;
    }
    currentBroadcastId = data.id;
    body.textContent = data.message;
    banner.style.display = 'block';
  }

  function listenGlobalBroadcast() {
    if (!db) return;
    if (broadcastUnsub) { try { broadcastUnsub(); } catch (e) {} broadcastUnsub = null; }
    broadcastUnsub = db.collection('appConfig').doc('broadcast').onSnapshot(snap => {
      if (!snap.exists) {
        showGlobalBroadcast(null);
        return;
      }
      const d = snap.data() || {};
      if (!d.active || !(d.message || '').trim()) {
        showGlobalBroadcast(null);
        return;
      }
      const payload = {
        id: d.id || snap.id + '_' + (d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : Date.now()),
        message: String(d.message || '').trim()
      };
      // toast si nouveau message pendant la session
      if (listenGlobalBroadcast._lastId && listenGlobalBroadcast._lastId !== payload.id) {
        if (typeof showAppToast === 'function') showAppToast('Message admin', payload.message.slice(0, 100));
      }
      listenGlobalBroadcast._lastId = payload.id;
      showGlobalBroadcast(payload);
    }, err => console.warn('broadcast listen', err));
  }

  document.getElementById('globalBroadcastClose')?.addEventListener('click', () => {
    if (currentBroadcastId) setDismissedBroadcastId(currentBroadcastId);
    const banner = document.getElementById('globalBroadcastBanner');
    if (banner) banner.style.display = 'none';
  });

  // ADMIN_CHAT_ID défini dans app-social.js (var global)

  async function ensureAdminChat() {
    if (!db) return;
    await db.collection('conversations').doc(ADMIN_CHAT_ID).set({
      type: 'admin',
      name: 'Annonces Admin',
      participants: [],
      isAdminChannel: true,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  document.getElementById('adminBroadcastSendBtn')?.addEventListener('click', async () => {
    if (!isAdminUser() || !db || !currentUser) {
      flash('Réservé à l’admin connecté.');
      return;
    }
    const ta = document.getElementById('adminBroadcastMsg');
    const status = document.getElementById('adminBroadcastStatus');
    const msg = (ta && ta.value || '').trim();
    if (msg.length < 2) {
      if (status) status.textContent = 'Écris un message un peu plus long.';
      return;
    }
    if (status) status.textContent = 'Envoi…';
    try {
      await ensureAdminChat();
      const textMsg = msg.slice(0, 500);
      await db.collection('conversations').doc(ADMIN_CHAT_ID).collection('messages').add({
        from: currentUser.uid,
        fromPseudo: 'Admin',
        text: textMsg,
        isAdmin: true,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await db.collection('conversations').doc(ADMIN_CHAT_ID).set({
        type: 'admin',
        name: 'Annonces Admin',
        isAdminChannel: true,
        lastMessage: textMsg,
        lastFrom: 'admin',
        lastFromUid: currentUser.uid,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      if (status) status.textContent = 'Message posté dans Messagerie → Annonces Admin.';
      flash('Message admin dans la messagerie.');
      if (ta) ta.value = '';
    } catch (e) {
      console.error(e);
      if (status) status.textContent = 'Erreur (règles Firestore ?).';
      flash('Impossible d’envoyer le message admin.');
    }
  });

  document.getElementById('adminBroadcastClearBtn')?.addEventListener('click', async () => {
    if (!isAdminUser() || !db) return;
    const status = document.getElementById('adminBroadcastStatus');
    try {
      await db.collection('conversations').doc(ADMIN_CHAT_ID).set({
        lastMessage: '(aucun message récent)',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      if (status) status.textContent = 'Aperçu retiré (l’historique des messages reste).';
      flash('Aperçu admin mis à jour.');
    } catch (e) {
      console.error(e);
      if (status) status.textContent = 'Erreur.';
    }
  });


  // Masque le bouton admin par défaut
  updateAdminButtonVisibility();

  document.getElementById('adminGrantBadgeBtn').addEventListener('click', () => {
    const id = document.getElementById('adminBadgeSelect').value;
    if (id === SECRET_BADGE.id) {
      state.secretBadgeUnlocked = true;
    } else {
      if (!Array.isArray(state.seenBadges)) state.seenBadges = [];
      if (!state.seenBadges.includes(id)) state.seenBadges.push(id);
      if (state.badgeRewardsClaimed && state.badgeRewardsClaimed.includes(id)) {
        state.badgeRewardsClaimed = state.badgeRewardsClaimed.filter(x => x !== id);
      }
      const badge = getBadges().find(b => b.id === id);
      if (badge) grantBadgeReward(badge);
    }
    saveState();
    buildBadges();
    try { if (typeof renderProfile === 'function') renderProfile(); } catch (e) {}
    flash('Badge + récompense appliqués (admin).');
  });

  document.getElementById('adminGrantAllBtn').addEventListener('click', () => {
    const all = getBadges();
    const allIds = all.map(b => b.id);
    state.seenBadges = Array.from(new Set([...(state.seenBadges || []), ...allIds]));
    all.forEach(b => {
      if (state.badgeRewardsClaimed && state.badgeRewardsClaimed.includes(b.id)) {
        state.badgeRewardsClaimed = state.badgeRewardsClaimed.filter(x => x !== b.id);
      }
      grantBadgeReward(b);
    });
    saveState();
    buildBadges();
    try { if (typeof renderProfile === 'function') renderProfile(); } catch (e) {}
    flash('Tous badges + récompenses (admin).');
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

  document.getElementById('adminSetXpBtn')?.addEventListener('click', () => {
    if (!isAdminUser()) return;
    const v = parseInt(document.getElementById('adminXpInput').value, 10);
    if (isNaN(v) || v < 0) { flash('XP invalide'); return; }
    state.xp = v;
    saveState();
    if (typeof renderProfile === 'function') renderProfile();
    flash('XP défini à ' + v + ' (admin)');
  });
  document.getElementById('adminAddXpBtn')?.addEventListener('click', () => {
    if (!isAdminUser()) return;
    const v = parseInt(document.getElementById('adminXpInput').value, 10) || 0;
    state.xp = (state.xp || 0) + v;
    saveState();
    if (typeof renderProfile === 'function') renderProfile();
    flash('+' + v + ' XP (admin) → total ' + state.xp);
  });
  document.getElementById('adminResetXpBtn')?.addEventListener('click', () => {
    if (!isAdminUser()) return;
    state.xp = 0;
    state.xpClaimedChallenges = [];
    saveState();
    if (typeof renderProfile === 'function') renderProfile();
    flash('XP remis à 0 (admin)');
  });
  document.getElementById('adminBoostScoreBtn')?.addEventListener('click', () => {
    if (!isAdminUser()) return;
    const pts = parseFloat(document.getElementById('adminScoreBoost').value) || 0;
    if (pts <= 0) { flash('Valeur invalide'); return; }
    const ex = (state.exercises || []).find(e => (e.points || 0) > 0) || state.exercises[0];
    if (!ex) return;
    const addVal = pts / (ex.points || 1);
    ex.value = Math.round(((ex.value || 0) + addVal) * 10) / 10;
    saveState();
    buildForm();
    render();
    flash('+' + pts + ' pts approx. via ' + ex.name + ' (admin)');
  });
  document.getElementById('adminZeroTodayBtn')?.addEventListener('click', () => {
    if (!isAdminUser()) return;
    state.exercises = (state.exercises || []).map(ex => ({ ...ex, value: 0 }));
    saveState();
    buildForm();
    render();
    flash('Score du jour à 0 (admin)');
  });
  let adminTargetUid = null;
  let adminTargetPseudo = '';

  document.getElementById('adminLoadPlayerBtn')?.addEventListener('click', async () => {
    if (!isAdminUser()) return;
    const pseudo = (document.getElementById('adminTargetPseudo').value || '').trim().toLowerCase();
    const info = document.getElementById('adminPlayerInfo');
    if (!pseudo) { info.textContent = 'Entre un pseudo.'; return; }
    try {
      const uname = await db.collection('usernames').doc(pseudo).get();
      if (!uname.exists) {
        adminTargetUid = null;
        info.textContent = 'Pseudo introuvable.';
        return;
      }
      adminTargetUid = uname.data().uid;
      adminTargetPseudo = pseudo;
      const userSnap = await db.collection('users').doc(adminTargetUid).get();
      const u = userSnap.exists ? userSnap.data() : {};
      const stats = u.challengeStats || {};
      info.textContent = '@' + pseudo + ' · uid …' + String(adminTargetUid).slice(-6) +
        ' · XP ' + (u.xp || 0) +
        ' · défis ' + (stats.wins || 0) + '/' + (stats.played || 0);
      document.getElementById('adminRemoteXp').value = u.xp || 0;
      document.getElementById('adminRemoteWins').value = stats.wins || 0;
      document.getElementById('adminRemotePlayed').value = stats.played || 0;
    } catch (e) {
      console.error(e);
      info.textContent = 'Erreur chargement : ' + (e.message || 'rules ?');
    }
  });

  document.getElementById('adminRemoteSetXpBtn')?.addEventListener('click', async () => {
    if (!isAdminUser() || !adminTargetUid) { flash('Charge un joueur d’abord'); return; }
    const v = parseInt(document.getElementById('adminRemoteXp').value, 10);
    if (isNaN(v) || v < 0) { flash('XP invalide'); return; }
    try {
      await db.collection('users').doc(adminTargetUid).set({ xp: v }, { merge: true });
      await db.collection('publicProfiles').doc(adminTargetUid).set({
        xp: v,
        level: levelFromXp(v),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      flash('XP de @' + adminTargetPseudo + ' → ' + v);
    } catch (e) {
      console.error(e);
      flash('Erreur XP distant');
    }
  });

  document.getElementById('adminRemoteStatsBtn')?.addEventListener('click', async () => {
    if (!isAdminUser() || !adminTargetUid) { flash('Charge un joueur d’abord'); return; }
    const wins = parseInt(document.getElementById('adminRemoteWins').value, 10) || 0;
    const played = parseInt(document.getElementById('adminRemotePlayed').value, 10) || 0;
    try {
      await db.collection('users').doc(adminTargetUid).set({
        challengeStats: { wins, played, multiWins: 0 }
      }, { merge: true });
      await db.collection('publicProfiles').doc(adminTargetUid).set({
        challengeWins: wins,
        challengePlayed: played,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      flash('Stats défis de @' + adminTargetPseudo + ' mises à jour');
    } catch (e) {
      console.error(e);
      flash('Erreur stats distantes');
    }
  });

  document.getElementById('adminRemoteGrantAllBadgesBtn')?.addEventListener('click', async () => {
    if (!isAdminUser() || !adminTargetUid) { flash('Charge un joueur d’abord'); return; }
    const allIds = getBadges().map(b => b.id);
    try {
      await db.collection('users').doc(adminTargetUid).set({
        seenBadges: allIds,
        secretBadgeUnlocked: true
      }, { merge: true });
      await db.collection('publicProfiles').doc(adminTargetUid).set({
        badgesUnlocked: allIds.length + 1,
        badgesTotal: allIds.length + 1,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      flash('Tous badges accordés à @' + adminTargetPseudo);
    } catch (e) {
      console.error(e);
      flash('Erreur badges distants');
    }
  });

  document.getElementById('adminForceSyncBtn')?.addEventListener('click', async () => {
    if (!isAdminUser()) return;
    if (!currentUser) { flash('Pas connecté'); return; }
    await saveToCloud();
    flash('Sync cloud forcée (admin)');
  });
  document.getElementById('adminPublishProfileBtn')?.addEventListener('click', async () => {
    if (!isAdminUser()) return;
    if (!currentUser) { flash('Pas connecté'); return; }
    await publishPublicProfile();
    flash('Profil public publié (admin)');
  });

  /* ---- INTRO SPLASH + ONBOARDING ---- */
  const INTRO_KEY = 'note_journaliere_intro_seen';
  const ONB_KEY = 'note_journaliere_onboarding_done';
  const introSplash = document.getElementById('introSplash');

  const onbAnswers = { level: null, goal: null, exos: [] };
  let onbStep = 1;

  function openOnboarding() {
    let done = false;
    try { done = localStorage.getItem(ONB_KEY) === '1' || !!(state && state.onboardingDone); } catch (e) {}
    if (done) return;
    onbStep = 1;
    onbAnswers.level = null;
    onbAnswers.goal = null;
    onbAnswers.exos = [];
    document.querySelectorAll('.onb-opt').forEach(b => b.classList.remove('selected'));
    document.getElementById('onbFlash').textContent = '';
    showOnbStep(1);
    document.getElementById('onboardingOverlay').classList.add('open');
  }

  function showOnbStep(n) {
    onbStep = n;
    document.querySelectorAll('.onb-step').forEach(el => {
      el.style.display = el.getAttribute('data-onb') === String(n) ? 'block' : 'none';
    });
    document.getElementById('onbStepLabel').textContent = n + ' / 3';
    document.getElementById('onbNextBtn').textContent = n === 3 ? 'Terminer' : 'Continuer';
    document.getElementById('onbFlash').textContent = '';
  }

  function finishOnboarding(skipped) {
    document.getElementById('onboardingOverlay').classList.remove('open');
    try { localStorage.setItem(ONB_KEY, '1'); } catch (e) {}
    state.onboardingDone = true;

    if (!skipped && onbAnswers.level) {
      // Objectif adapté au niveau
      const goals = { beginner: 80, intermediate: 150, advanced: 280 };
      state.dailyGoal = goals[onbAnswers.level] || 150;
      state.onboarding = {
        level: onbAnswers.level,
        goal: onbAnswers.goal,
        favoriteExercises: onbAnswers.exos.slice()
      };
      // Petit message personnalisé dans le conseil
      const tips = {
        beginner: 'Objectif doux pour commencer : la régularité bat l’intensité.',
        intermediate: 'Bel équilibre — vise ton objectif chaque jour, sans te griller.',
        advanced: 'Mode perf : pousse tes séries, mais garde un œil sur la récup.'
      };
      if (tips[onbAnswers.level]) {
        try {
          const tipEl = document.getElementById('tipText');
          if (tipEl) tipEl.textContent = tips[onbAnswers.level];
        } catch (e) {}
      }
      saveState();
      render();
      flash('Profil personnalisé — objectif ' + state.dailyGoal + ' pts / jour');
    } else {
      state.onboarding = state.onboarding || null;
      saveState();
    }
  }

  function dismissIntro() {
    const splash = document.getElementById('introSplash');
    if (!splash) {
      openOnboarding();
      return;
    }
    splash.classList.add('hide');
    try { localStorage.setItem(INTRO_KEY, '1'); } catch (e) {}
    setTimeout(() => {
      splash.style.display = 'none';
      openOnboarding();
    }, 280);
  }

  try {
    if (localStorage.getItem(INTRO_KEY) === '1') {
      if (introSplash) introSplash.style.display = 'none';
      // Intro déjà vue → proposer onboarding si pas fait
      setTimeout(openOnboarding, 300);
    }
  } catch (e) {}

  const introSkipBtn = document.getElementById('introSkipBtn');
  if (introSkipBtn) {
    introSkipBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dismissIntro();
    });
  }
  document.getElementById('introSkipBtn2')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dismissIntro();
  });
  // Secours : Entrée / Espace sur l'écran d'intro
  document.addEventListener('keydown', (e) => {
    const splash = document.getElementById('introSplash');
    if (!splash || splash.style.display === 'none' || splash.classList.contains('hide')) return;
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      dismissIntro();
    }
  });

  // Choix single
  document.querySelectorAll('#onbLevel .onb-opt, #onbGoal .onb-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.parentElement;
      group.querySelectorAll('.onb-opt').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      if (group.id === 'onbLevel') onbAnswers.level = btn.dataset.val;
      if (group.id === 'onbGoal') onbAnswers.goal = btn.dataset.val;
    });
  });
  // Choix multi exercices
  document.querySelectorAll('#onbExos .onb-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('selected');
      onbAnswers.exos = Array.from(document.querySelectorAll('#onbExos .onb-opt.selected')).map(b => b.dataset.val);
    });
  });

  document.getElementById('onbNextBtn').addEventListener('click', () => {
    const flashEl = document.getElementById('onbFlash');
    if (onbStep === 1 && !onbAnswers.level) {
      flashEl.textContent = 'Choisis ton niveau pour continuer.';
      return;
    }
    if (onbStep === 2 && !onbAnswers.goal) {
      flashEl.textContent = 'Choisis un objectif pour continuer.';
      return;
    }
    if (onbStep === 3) {
      finishOnboarding(false);
      return;
    }
    showOnbStep(onbStep + 1);
  });
  document.getElementById('onbSkipBtn').addEventListener('click', () => finishOnboarding(true));

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
      localStorage.removeItem(ONB_KEY);
    } catch (e) {}
    location.reload();
  });

  showSection('section-today');

