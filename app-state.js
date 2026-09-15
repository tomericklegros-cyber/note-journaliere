/* app-state.js — état local + synchronisation cloud
 *
 * Ordre : firebase-config.js → app-state.js → app.js → app-social.js
 * Dépend au runtime de : auth, db (firebase-config) et plus tard computeScore/getRank (app.js)
 */
var STORAGE_KEY = "note_journaliere_v1";
window.STORAGE_KEY = STORAGE_KEY;

var lastCloudSave = 0;
var lastPublicFingerprint = "";
var cloudDirty = false;
var cloudSaving = false;
var currentUser = null;

  async function publishPublicProfile(force) {
    if (!currentUser || !db || !state) return;
    try {
      const rawScore = typeof computeScore === 'function' ? Math.round(computeScore(state)) : 0;
      const today = typeof todayKey === 'function' ? todayKey() : null;
      const isToday = !!(today && state.dayKey === today);
      // Score du jour uniquement si la séance est bien celle d'aujourd'hui
      const scoreToday = isToday ? rawScore : 0;
      // Rang affiché : basé sur le score du jour si actif, sinon rang neutre / dernier connu
      const rankScore = isToday ? rawScore : 0;
      const rank = typeof getRank === 'function' ? getRank(rankScore) : { current: { name: 'Inactif', color: '#888' } };
      const current = rank.current || { name: 'Inactif', color: '#888' };
      const level = typeof levelFromXp === 'function' ? levelFromXp(state.xp || 0) : 1;
      const badgeCount = typeof countBadgesProgress === 'function' ? countBadgesProgress() : { unlocked: 0, total: 0 };
      const lastScore = isToday ? rawScore : (typeof state._lastPublishedScore === 'number' ? state._lastPublishedScore : rawScore);
      if (isToday) state._lastPublishedScore = rawScore;
      const fp = [
        state.pseudo || '',
        state.xp || 0,
        level,
        scoreToday,
        current.name || '',
        state.selectedAvatar || '',
        badgeCount.unlocked,
        badgeCount.total,
        state.dayKey || '',
        (state.challengeStats && state.challengeStats.wins) || 0
      ].join('|');
      if (!force && fp === lastPublicFingerprint) return;
      lastPublicFingerprint = fp;
      await db.collection('publicProfiles').doc(currentUser.uid).set({
        uid: currentUser.uid,
        pseudo: state.pseudo || '',
        userName: state.userName || '',
        xp: state.xp || 0,
        level,
        todayScore: scoreToday,
        lastScore: isToday ? scoreToday : lastScore,
        activeToday: isToday && scoreToday > 0,
        rankName: isToday ? current.name : (scoreToday > 0 ? current.name : 'Pas actif aujourd’hui'),
        rankColor: isToday ? current.color : '#888888',
        selectedAvatar: state.selectedAvatar || 'default',
        badgesUnlocked: badgeCount.unlocked || 0,
        badgesTotal: badgeCount.total || 0,
        challengeWins: (state.challengeStats && state.challengeStats.wins) || 0,
        challengePlayed: (state.challengeStats && state.challengeStats.played) || 0,
        dayKey: state.dayKey || '',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (e) {
      console.warn('public profile', e);
    }
  }

  function sanitizeStateForCloud(s) {
    // Firestore refuse undefined — on nettoie
    try {
      return JSON.parse(JSON.stringify(s));
    } catch (e) {
      return { ...s };
    }
  }

  function buildCloudPayload() {
    // Liste blanche : on n'envoie que les champs utiles (pas tout l'objet state brut)
    state.clientUpdatedAt = Date.now();
    const raw = {
      userName: state.userName,
      pseudo: state.pseudo,
      dayKey: state.dayKey,
      exercises: state.exercises,
      history: state.history,
      records: state.records,
      dailyGoal: state.dailyGoal,
      dayNotes: state.dayNotes,
      plannedSessions: state.plannedSessions,
      plannedChallenges: state.plannedChallenges,
      challengeDayResults: state.challengeDayResults,
      xp: state.xp,
      xpClaimedChallenges: state.xpClaimedChallenges,
      onboardingDone: state.onboardingDone,
      onboarding: state.onboarding,
      chatNicknames: state.chatNicknames,
      challengeStats: state.challengeStats,
      unlockedAvatars: state.unlockedAvatars,
      unlockedFonts: state.unlockedFonts,
      selectedAvatar: state.selectedAvatar,
      selectedFont: state.selectedFont,
      badgeRewardsClaimed: state.badgeRewardsClaimed,
      seenBadges: state.seenBadges,
      secretBadgeUnlocked: state.secretBadgeUnlocked,
      hackerCelebratedToday: state.hackerCelebratedToday,
      difficultyBonus: state.difficultyBonus,
      clientUpdatedAt: state.clientUpdatedAt,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    return sanitizeStateForCloud(raw);
  }

  async function writeCloudNow() {
    if (!currentUser || !db) return false;
    const payload = buildCloudPayload();
    // remettre serverTimestamp après sanitize (JSON l'enlève)
    payload.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    payload.clientUpdatedAt = state.clientUpdatedAt;
    await db.collection('users').doc(currentUser.uid).set(payload, { merge: true });
    await publishPublicProfile(false);
    lastCloudSave = Date.now();
    setAuthStatus('Synchronisé ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), 'synced');
    return true;
  }

  function scheduleCloudSave() {
    if (!currentUser || !db) return;
    cloudDirty = true;
    clearTimeout(window._cloudSaveTimer);
    window._cloudSaveTimer = setTimeout(() => { flushCloudSave(); }, 1500);
  }

  async function flushCloudSave() {
    if (!currentUser || !db) return;
    if (!cloudDirty || cloudSaving) return;
    cloudSaving = true;
    cloudDirty = false;
    try {
      await writeCloudNow();
    } catch (err) {
      console.error('Cloud save error', err);
      setAuthStatus('Erreur de sync', 'error');
      // re-marque dirty pour réessayer plus tard
      cloudDirty = true;
    } finally {
      cloudSaving = false;
      if (cloudDirty) {
        clearTimeout(window._cloudSaveTimer);
        window._cloudSaveTimer = setTimeout(() => { flushCloudSave(); }, 1500);
      }
    }
  }

  /** Appel explicite (login, admin…) — envoie tout de suite */
  async function saveToCloud() {
    if (!currentUser || !db) return;
    cloudDirty = true;
    // si déjà en cours, la file reprendra après
    if (cloudSaving) return;
    await flushCloudSave();
  }

  function stateRichness(s) {
    if (!s) return 0;
    let score = 0;
    score += (s.history && s.history.length) ? s.history.length * 10 : 0;
    score += (s.xp || 0);
    score += (s.exercises || []).reduce((a, ex) => a + (ex.value || 0), 0);
    score += (s.seenBadges && s.seenBadges.length) ? s.seenBadges.length : 0;
    score += (s.unlockedAvatars && s.unlockedAvatars.length) ? s.unlockedAvatars.length : 0;
    score += (s.dayNotes && Object.keys(s.dayNotes).length) ? Object.keys(s.dayNotes).length : 0;
    return score;
  }

  function buildStateFromCloud(cloud, local) {
    const base = defaultState();
    const src = cloud || {};
    const loc = local || base;
    // Pour chaque champ : cloud si présent et utile, sinon local, sinon défaut
    const pickArr = (c, l, d) => (Array.isArray(c) && c.length ? c : (Array.isArray(l) && l.length ? l : d));
    const pickObj = (c, l, d) => (c && typeof c === 'object' && Object.keys(c).length ? c : (l && typeof l === 'object' && Object.keys(l).length ? l : d));
    const pickStr = (c, l, d) => (typeof c === 'string' && c ? c : (typeof l === 'string' && l ? l : d));
    const pickNum = (c, l, d) => (typeof c === 'number' ? c : (typeof l === 'number' ? l : d));
    const pickBool = (c, l, d) => (typeof c === 'boolean' ? c : (typeof l === 'boolean' ? l : d));

    return {
      userName: pickStr(src.userName, loc.userName, base.userName),
      pseudo: pickStr(src.pseudo, loc.pseudo, base.pseudo),
      dayKey: src.dayKey || loc.dayKey || base.dayKey,
      exercises: pickArr(src.exercises, loc.exercises, base.exercises),
      history: pickArr(src.history, loc.history, []),
      records: (src.records && typeof src.records === 'object') ? src.records
        : ((loc.records && typeof loc.records === 'object') ? loc.records : { bestScore: null, perExercise: {} }),
      dailyGoal: pickNum(src.dailyGoal, loc.dailyGoal, base.dailyGoal),
      dayNotes: pickObj(src.dayNotes, loc.dayNotes, {}),
      plannedSessions: pickObj(src.plannedSessions, loc.plannedSessions, {}),
      plannedChallenges: pickObj(src.plannedChallenges, loc.plannedChallenges, {}),
      challengeDayResults: pickObj(src.challengeDayResults, loc.challengeDayResults, {}),
      xp: pickNum(src.xp, loc.xp, 0),
      xpClaimedChallenges: pickArr(src.xpClaimedChallenges, loc.xpClaimedChallenges, []),
      onboardingDone: !!(src.onboardingDone || loc.onboardingDone),
      onboarding: (src.onboarding && typeof src.onboarding === 'object') ? src.onboarding : (loc.onboarding || null),
      chatNicknames: pickObj(src.chatNicknames, loc.chatNicknames, {}),
      challengeStats: (src.challengeStats && typeof src.challengeStats === 'object') ? src.challengeStats
        : ((loc.challengeStats && typeof loc.challengeStats === 'object') ? loc.challengeStats : { wins: 0, multiWins: 0, played: 0 }),
      unlockedAvatars: pickArr(src.unlockedAvatars, loc.unlockedAvatars, ['default']),
      unlockedFonts: pickArr(src.unlockedFonts, loc.unlockedFonts, ['default']),
      selectedAvatar: pickStr(src.selectedAvatar, loc.selectedAvatar, 'default'),
      selectedFont: pickStr(src.selectedFont, loc.selectedFont, 'default'),
      badgeRewardsClaimed: pickArr(src.badgeRewardsClaimed, loc.badgeRewardsClaimed, []),
      seenBadges: Array.isArray(src.seenBadges) ? src.seenBadges : (Array.isArray(loc.seenBadges) ? loc.seenBadges : []),
      secretBadgeUnlocked: pickBool(src.secretBadgeUnlocked, loc.secretBadgeUnlocked, false),
      hackerCelebratedToday: pickBool(src.hackerCelebratedToday, loc.hackerCelebratedToday, false),
      difficultyBonus: pickNum(src.difficultyBonus, loc.difficultyBonus, 0),
      clientUpdatedAt: pickNum(src.clientUpdatedAt, loc.clientUpdatedAt, 0)
    };
  }

  async function loadFromCloud(user) {
    try {
      if (!db) return false;
      setAuthStatus('Chargement du cloud…', null);
      const localBackup = sanitizeStateForCloud(state);
      const snap = await db.collection('users').doc(user.uid).get();
      if (snap.exists) {
        const cloud = snap.data() || {};
        const cloudTime = typeof cloud.clientUpdatedAt === 'number' ? cloud.clientUpdatedAt : 0;
        const localTime = typeof localBackup.clientUpdatedAt === 'number' ? localBackup.clientUpdatedAt : 0;
        const localScore = stateRichness(localBackup);
        const cloudScore = stateRichness(cloud);

        // Si le local est clairement plus récent OU nettement plus riche → on garde local et on pousse cloud
        if ((localTime > cloudTime + 2000 && localScore >= cloudScore) || (localScore > cloudScore * 1.25 && localScore > 5 && localTime >= cloudTime)) {
          state = buildStateFromCloud(cloud, localBackup); window.state = state; // merge
          // puis on privilégie les valeurs locales riches
          if (localScore > cloudScore) {
            state = buildStateFromCloud(localBackup, cloud); window.state = state;
          }
          ensureExercises();
          finalizeDayIfNeeded();
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
          await saveToCloud();
          setAuthStatus('Local plus récent — cloud mis à jour', 'synced');
          logEvent('cloud_kept_local');
          return true;
        }

        state = buildStateFromCloud(cloud, localBackup); window.state = state;
        ensureExercises();
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
      setAuthStatus('Erreur de chargement cloud — données locales conservées', 'error');
      return false;
    }
  }


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
      plannedSessions: {},
      plannedChallenges: {},
      challengeDayResults: {},
      xp: 0,
      xpClaimedChallenges: [],
      onboardingDone: false,
      onboarding: null,
      chatNicknames: {},
      challengeStats: { wins: 0, multiWins: 0, played: 0 },
      unlockedAvatars: ['default'],
      unlockedFonts: ['default'],
      selectedAvatar: 'default',
      selectedFont: 'default',
      badgeRewardsClaimed: []
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



  function ensureExercises() {
    if (!state || !Array.isArray(state.exercises) || state.exercises.length === 0) {
      if (!state) return;
      state.exercises = defaultExercises();
    }
    // garantir les 5 de base
    const ids = new Set(state.exercises.map(e => e.id));
    defaultExercises().forEach(def => {
      if (!ids.has(def.id)) state.exercises.push({ ...def });
    });
  }

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
        plannedSessions: parsed.plannedSessions && typeof parsed.plannedSessions === 'object' ? parsed.plannedSessions : {},
        plannedChallenges: parsed.plannedChallenges && typeof parsed.plannedChallenges === 'object' ? parsed.plannedChallenges : {},
        challengeDayResults: parsed.challengeDayResults && typeof parsed.challengeDayResults === 'object' ? parsed.challengeDayResults : {},
        xp: typeof parsed.xp === 'number' ? parsed.xp : 0,
        xpClaimedChallenges: Array.isArray(parsed.xpClaimedChallenges) ? parsed.xpClaimedChallenges : [],
        onboardingDone: !!parsed.onboardingDone,
        onboarding: parsed.onboarding && typeof parsed.onboarding === 'object' ? parsed.onboarding : null,
        chatNicknames: parsed.chatNicknames && typeof parsed.chatNicknames === 'object' ? parsed.chatNicknames : {},
        challengeStats: parsed.challengeStats && typeof parsed.challengeStats === 'object' ? parsed.challengeStats : { wins: 0, multiWins: 0, played: 0 },
        unlockedAvatars: Array.isArray(parsed.unlockedAvatars) ? parsed.unlockedAvatars : ['default'],
        unlockedFonts: Array.isArray(parsed.unlockedFonts) ? parsed.unlockedFonts : ['default'],
        selectedAvatar: typeof parsed.selectedAvatar === 'string' ? parsed.selectedAvatar : 'default',
        selectedFont: typeof parsed.selectedFont === 'string' ? parsed.selectedFont : 'default',
        badgeRewardsClaimed: Array.isArray(parsed.badgeRewardsClaimed) ? parsed.badgeRewardsClaimed : [],
        seenBadges: Array.isArray(parsed.seenBadges) ? parsed.seenBadges : null,
        secretBadgeUnlocked: typeof parsed.secretBadgeUnlocked === 'boolean' ? parsed.secretBadgeUnlocked : null,
        hackerCelebratedToday: typeof parsed.hackerCelebratedToday === 'boolean' ? parsed.hackerCelebratedToday : false,
        difficultyBonus: typeof parsed.difficultyBonus === 'number' ? parsed.difficultyBonus : 0
      };
    } catch (e) {
      return defaultState();
    }
  }

  function saveState(opts) {
    // opts.cloud === false → local only (ex: refresh UI sans sync)
    try {
      state.clientUpdatedAt = Date.now();
      window.state = state;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {}
    if (opts && opts.cloud === false) return;
    // File d'attente cloud : ne droppe jamais une modif
    if (currentUser) scheduleCloudSave();
  }

var state;
try {
  state = loadState();
} catch (e) {
  console.error('loadState failed', e);
  state = defaultState();
}
try { ensureExercises(); } catch (e) { console.warn(e); }
window.state = state;
