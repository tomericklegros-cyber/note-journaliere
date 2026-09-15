/* app-social.js — amis, défis, messagerie, annonces admin
   Dépend de : firebase-config.js, app.js (state, saveState, currentUser, db, helpers)
*/
var ADMIN_CHAT_ID = 'admin_broadcast';

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

  /* ---- Notifications (site ouvert) ---- */
  const notifState = { friends: 0, challenges: 0, messages: 0 };
  let convNotifUnsub = null;
  let lastToastAt = 0;
  const knownChallengeIds = new Set();
  let challengesReady = false;

  function showAppToast(title, body) {
    const el = document.getElementById('appToast');
    if (!el) return;
    const now = Date.now();
    if (now - lastToastAt < 1200) return; // anti-spam
    lastToastAt = now;
    el.innerHTML = `<strong>${escapeHtml(title)}</strong>${body ? `<span>${escapeHtml(body)}</span>` : ''}`;
    el.classList.add('show');
    clearTimeout(showAppToast._t);
    showAppToast._t = setTimeout(() => el.classList.remove('show'), 4200);
  }

  function refreshNotifBadge() {
    const total = (notifState.friends || 0) + (notifState.challenges || 0) + (notifState.messages || 0);
    const badge = document.getElementById('socialBadge');
    if (badge) {
      if (total > 0) {
        badge.textContent = total > 9 ? '9+' : String(total);
        badge.classList.add('show');
      } else {
        badge.textContent = '0';
        badge.classList.remove('show');
      }
    }
    const dA = document.getElementById('tabDotAmis');
    const dD = document.getElementById('tabDotDefis');
    const dM = document.getElementById('tabDotMessages');
    if (dA) dA.classList.toggle('on', (notifState.friends || 0) > 0);
    if (dD) dD.classList.toggle('on', (notifState.challenges || 0) > 0);
    if (dM) dM.classList.toggle('on', (notifState.messages || 0) > 0);
  }

  function getChatReadMap() {
    try { return JSON.parse(localStorage.getItem('note_chat_read_v1') || '{}') || {}; } catch (e) { return {}; }
  }
  function setChatRead(chatId, ts) {
    const map = getChatReadMap();
    map[chatId] = ts || Date.now();
    try { localStorage.setItem('note_chat_read_v1', JSON.stringify(map)); } catch (e) {}
  }

  function updateChallengeNotifsFromCache() {
    if (!currentUser) {
      notifState.challenges = 0;
      refreshNotifBadge();
      return;
    }
    let n = 0;
    const uid = currentUser.uid;
    Object.values(cachedChallenges || {}).forEach(ch => {
      if (!ch) return;
      // Pastille UNIQUEMENT pour un défi reçu en attente d'acceptation
      // (les défis actifs se voient dans l'onglet, sans spam rouge)
      if (ch.status === 'pending' && ch.toUid === uid) n++;
    });
    notifState.challenges = n;
    refreshNotifBadge();
  }

  function startConversationNotifs() {
    if (!currentUser || !db) return;
    if (convNotifUnsub) { convNotifUnsub(); convNotifUnsub = null; }
    let convBootstrapped = false;
    const sessionStart = Date.now();
    convNotifUnsub = db.collection('conversations')
      .where('participants', 'array-contains', currentUser.uid)
      .onSnapshot(snap => {
        const readMap = getChatReadMap();

        // Premier chargement : TOUT est considéré comme déjà vu
        // → plus de pastille rouge au simple ouverture du site
        if (!convBootstrapped) {
          snap.forEach(doc => {
            const d = doc.data() || {};
            const updated = d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : Date.now();
            readMap[doc.id] = Math.max(readMap[doc.id] || 0, updated, sessionStart);
          });
          try { localStorage.setItem('note_chat_read_v1', JSON.stringify(readMap)); } catch (e) {}
          convBootstrapped = true;
          notifState.messages = 0;
          refreshNotifBadge();
          return;
        }

        let unread = 0;
        snap.docChanges().forEach(change => {
          const d = change.doc.data() || {};
          const id = change.doc.id;
          if (change.type === 'modified' && d.lastFrom && d.lastFrom !== currentUser.uid) {
            const updated = d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : 0;
            const lastRead = readMap[id] || 0;
            const msg = (d.lastMessage || '').trim();
            // uniquement messages vraiment nouveaux pendant cette session
            if (msg && updated > lastRead && updated >= sessionStart) {
              if (updated > Date.now() - 5 * 60 * 1000) {
                showAppToast('Nouveau message', msg.slice(0, 80));
              }
            }
          }
        });
        snap.forEach(doc => {
          const d = doc.data() || {};
          const msg = (d.lastMessage || '').trim();
          if (!msg) return;
          if (d.lastFrom && d.lastFrom !== currentUser.uid) {
            const updated = d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : 0;
            const lastRead = readMap[doc.id] || 0;
            if (updated > lastRead && updated >= sessionStart) unread++;
          }
        });
        notifState.messages = unread;
        refreshNotifBadge();
      }, err => console.warn('conv notif', err));
  }


  function openSocialPanel() {
    document.getElementById('socialPanel').classList.add('open');
    document.getElementById('socialScrim').classList.add('open');
    refreshSocialLoginGate();
    if (currentUser) loadSocialData();
    // Ouvrir Social = on considère les notifs messages comme vues (sauf demandes d'amis / défis pending)
    notifState.messages = 0;
    refreshNotifBadge();
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
    if (convNotifUnsub) { convNotifUnsub(); convNotifUnsub = null; }
    notifState.friends = 0; notifState.challenges = 0; notifState.messages = 0;
    refreshNotifBadge();
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
      const av = (p.selectedAvatar && typeof AVATAR_CATALOG !== 'undefined' && AVATAR_CATALOG[p.selectedAvatar])
        ? AVATAR_CATALOG[p.selectedAvatar].emoji
        : (p.pseudo || '?').slice(0, 1).toUpperCase();
      document.getElementById('fpAvatar').textContent = av;

      const today = typeof todayKey === 'function' ? todayKey() : null;
      const isToday = !!(today && p.dayKey === today);
      const scoreToday = (typeof p.todayScore === 'number') ? Math.round(p.todayScore) : 0;
      const activeToday = isToday && (p.activeToday === true || scoreToday > 0);

      const rankEl = document.getElementById('fpRank');
      if (activeToday) {
        rankEl.textContent = p.rankName || '—';
        rankEl.style.color = p.rankColor || '';
      } else {
        rankEl.textContent = 'Pas actif aujourd’hui';
        rankEl.style.color = '#888';
      }

      const scoreLabel = document.querySelector('#fpScore')?.parentElement?.querySelector('.ps-label');
      if (activeToday) {
        document.getElementById('fpScore').textContent = scoreToday + ' pts';
        if (scoreLabel) scoreLabel.textContent = 'Aujourd’hui';
      } else {
        const last = typeof p.lastScore === 'number' ? Math.round(p.lastScore) : null;
        document.getElementById('fpScore').textContent = last != null ? (last + ' pts') : '—';
        if (scoreLabel) scoreLabel.textContent = p.dayKey ? ('Dernier jour') : 'Score';
      }

      document.getElementById('fpLevel').textContent = 'Niveau ' + (p.level || 1);
      document.getElementById('fpXp').textContent = (p.xp || 0) + ' XP';
      const bu = p.badgesUnlocked || 0;
      const bt = p.badgesTotal || 0;
      document.getElementById('fpBadges').textContent = bu + ' / ' + bt;
      const badgeLabel = document.querySelector('#fpBadges')?.parentElement?.querySelector('.ps-label');
      if (badgeLabel) badgeLabel.textContent = 'Badges';
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
    startConversationNotifs();

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
        const prev = notifState.friends || 0;
        const firstFriendsSnap = notifState._friendsBoot === undefined;
        notifState.friends = snap.size;
        notifState._friendsBoot = true;
        if (!firstFriendsSnap && snap.size > prev) {
          showAppToast('Demande d\'ami', 'Tu as une nouvelle demande');
        }
        refreshNotifBadge();
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
  let challengesUnsubMulti = null;
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
    if (challengesUnsubMulti) { challengesUnsubMulti(); challengesUnsubMulti = null; }
    if (chronoTickTimer) { clearInterval(chronoTickTimer); chronoTickTimer = null; }
  }

  async function populateChallengeFriends() {
    const box = document.getElementById('challengeFriendsPick');
    if (!box || !currentUser) return;
    box.innerHTML = '<div class="social-empty">Chargement…</div>';
    try {
      const snap = await db.collection('users').doc(currentUser.uid).collection('friends').get();
      if (snap.empty) {
        box.innerHTML = '<div class="social-empty">Ajoute des amis d’abord</div>';
        return;
      }
      box.innerHTML = '';
      snap.forEach(doc => {
        const f = doc.data();
        const pseudo = f.pseudo || doc.id;
        const label = displayNameForUid ? displayNameForUid(doc.id, pseudo) : pseudo;
        const row = document.createElement('label');
        row.className = 'group-pick-row';
        row.innerHTML = `<input type="checkbox" class="ch-friend-cb" value="${doc.id}" data-pseudo="${escapeHtml(pseudo)}"><span>@${escapeHtml(label)}</span>`;
        box.appendChild(row);
      });
    } catch (e) {
      console.error(e);
      box.innerHTML = '<div class="social-empty">Erreur</div>';
    }
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
    const checks = Array.from(document.querySelectorAll('#challengeFriendsPick .ch-friend-cb:checked'));
    if (!checks.length) { socialFlash('Choisis au moins un ami.', 'err'); return; }
    if (checks.length > 3) { socialFlash('Maximum 3 adversaires (4 joueurs).', 'err'); return; }

    const others = checks.map(c => ({
      uid: c.value,
      pseudo: c.getAttribute('data-pseudo') || c.value
    }));
    const type = document.getElementById('challengeTypeSelect').value;

    if (type === 'chrono' && others.length !== 1) {
      socialFlash('Le chrono est uniquement en duel (1 adversaire).', 'err');
      return;
    }

    const participants = [currentUser.uid, ...others.map(o => o.uid)];
    const pseudos = { [currentUser.uid]: state.pseudo };
    others.forEach(o => { pseudos[o.uid] = o.pseudo; });
    const scores = {};
    participants.forEach(u => { scores[u] = null; });

    const data = {
      type,
      mode: participants.length > 2 ? 'multi' : 'duo',
      fromUid: currentUser.uid,
      fromPseudo: state.pseudo,
      toUid: others[0].uid,
      toPseudo: others[0].pseudo,
      participants,
      pseudos,
      scores,
      status: participants.length > 2 ? 'active' : 'pending',
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
      data.chrono = {
        startedAt: null,
        fromReady: false,
        toReady: false,
        fromStoppedAt: null,
        toStoppedAt: null,
        fromMs: null,
        toMs: null
      };
    }
    // Duo score/exercise/goal starts pending (accept) — multi starts active
    if (type !== 'chrono' && participants.length === 2) {
      data.status = 'pending';
    }
    if (type !== 'chrono' && participants.length > 2) {
      data.status = 'active';
    }

    try {
      await db.collection('challenges').add(data);
      if (participants.length > 2) {
        socialFlash('Défi multi envoyé (' + participants.length + ' joueurs)', 'ok');
      } else {
        socialFlash('Défi envoyé à @' + others[0].pseudo, 'ok');
      }
      logEvent('challenge_sent', { type, n: participants.length });
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

  function isMultiChallenge(ch) {
    return !!(ch && (ch.mode === 'multi' || (Array.isArray(ch.participants) && ch.participants.length > 2)));
  }

  function multiRankingRows(ch) {
    const parts = ch.participants || [];
    const scores = ch.scores || {};
    const rows = parts.map(uid => ({
      uid,
      pseudo: (ch.pseudos && ch.pseudos[uid]) || uid,
      score: typeof scores[uid] === 'number' ? scores[uid] : null
    }));
    rows.sort((a, b) => {
      if (a.score === null && b.score === null) return 0;
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return b.score - a.score;
    });
    return rows;
  }

  function multiStandingHtml(ch) {
    const rows = multiRankingRows(ch);
    const medals = ['🥇', '🥈', '🥉', '4️⃣'];
    return `<div class="multi-standings">${rows.map((r, i) => {
      const sc = r.score === null ? '…' : r.score;
      const me = r.uid === currentUser.uid ? ' me' : '';
      return `<div class="multi-row${me}"><span class="m-rank">${medals[i] || (i + 1)}</span><span class="m-name">@${escapeHtml(r.pseudo)}</span><span class="m-score">${sc}</span></div>`;
    }).join('')}</div>`;
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
      card.className = 'challenge-card status-' + ch.status + (isMultiChallenge(ch) ? ' multi' : '');
      const multi = isMultiChallenge(ch);
      const isFromMe = ch.fromUid === currentUser.uid;
      const other = isFromMe ? ch.toPseudo : ch.fromPseudo;
      const playersLabel = multi
        ? ((ch.participants || []).length + ' joueurs')
        : ('vs @' + (other || '?'));

      let detail = '';
      if (ch.type === 'score_day') detail = multi ? 'Classement score du jour' : 'Qui a le plus de points aujourd’hui';
      if (ch.type === 'exercise') detail = 'Le plus de ' + (ch.exerciseName || 'exercice');
      if (ch.type === 'goal') detail = 'Atteindre ' + (ch.goalPoints || '?') + ' pts';
      if (ch.type === 'chrono') detail = 'Chrono duel — celui qui tient le plus longtemps';

      let statusLine = '';
      let standings = '';
      if (ch.status === 'pending') statusLine = isFromMe ? 'En attente de @' + other : '@' + other + ' t’a défié';
      if (ch.status === 'active') {
        if (multi) {
          const rows = multiRankingRows(ch);
          const submitted = rows.filter(r => r.score !== null).length;
          statusLine = `En cours — ${submitted}/${rows.length} scores envoyés`;
          standings = multiStandingHtml(ch);
        } else {
          statusLine = 'En cours vs @' + other;
          if (ch.type === 'score_day' || ch.type === 'exercise' || ch.type === 'goal') {
            const mySc = isFromMe ? ch.fromScore : ch.toScore;
            const theirSc = isFromMe ? ch.toScore : ch.fromScore;
            const myTxt = typeof mySc === 'number' ? mySc : 'pas encore';
            const theirTxt = typeof theirSc === 'number' ? theirSc : 'pas encore';
            statusLine += ` · Toi: ${myTxt} · Adversaire: ${theirTxt}`;
          }
        }
      }
      if (ch.status === 'declined') statusLine = 'Refusé';
      if (ch.status === 'cancelled') statusLine = 'Annulé';
      if (ch.status === 'completed') {
        if (multi) {
          const rows = multiRankingRows(ch);
          const top = rows[0];
          if (ch.winnerUid === currentUser.uid) statusLine = '🏆 Tu as gagné le défi multi';
          else if (ch.winnerUid === 'draw') statusLine = 'Égalité';
          else statusLine = 'Classement final — 1er : @' + ((top && top.pseudo) || '?');
          if (ch.resultText) statusLine += ' — ' + ch.resultText;
          standings = multiStandingHtml(ch);
        } else {
          if (ch.winnerUid === currentUser.uid) statusLine = '🏆 Tu as gagné vs @' + other;
          else if (ch.winnerUid === 'draw') statusLine = 'Égalité avec @' + other;
          else statusLine = '❌ Perdu contre @' + other;
          if (ch.resultText) statusLine += ' — ' + ch.resultText;
        }
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
        let mySc;
        if (multi) mySc = ch.scores && typeof ch.scores[currentUser.uid] === 'number' ? ch.scores[currentUser.uid] : null;
        else mySc = isFromMe ? ch.fromScore : ch.toScore;
        const btnLabel = typeof mySc === 'number'
          ? 'Mettre à jour mon score (' + mySc + ')'
          : 'Envoyer mon score';
        actions = `<button type="button" class="primary" data-ch-resolve="${ch.id}">${btnLabel}</button>`;
      }
      if (ch.status === 'active' && ch.type === 'chrono') {
        actions = `<button type="button" class="primary" data-ch-chrono="${ch.id}">${activeChronoChallengeId === ch.id ? 'Chrono ouvert' : 'Ouvrir le chrono'}</button>`;
      }

      let chronoHtml = '';
      if ((ch.status === 'active' || ch.status === 'completed') && ch.type === 'chrono' && activeChronoChallengeId === ch.id) {
        const c = ch.chrono || {};
        const isFrom = ch.fromUid === currentUser.uid;
        const myReady = isFrom ? !!c.fromReady : !!c.toReady;
        const theirReady = isFrom ? !!c.toReady : !!c.fromReady;
        const myStopped = isFrom ? c.fromStoppedAt : c.toStoppedAt;
        const theirStopped = isFrom ? c.toStoppedAt : c.fromStoppedAt;
        const started = !!(c.startedAt);
        let statusTxt = 'Appuie sur « Je suis prêt »';
        if (started && !myStopped) statusTxt = 'Chrono en cours — stop quand tu veux';
        else if (started && myStopped && !theirStopped) statusTxt = 'Tu as stoppé — en attente de l’autre…';
        else if (ch.status === 'completed') {
          if (ch.winnerUid === currentUser.uid) statusTxt = '🏆 Tu as gagné !';
          else if (ch.winnerUid === 'draw') statusTxt = 'Égalité';
          else statusTxt = 'Tu as perdu';
          if (ch.resultText) statusTxt += ' — ' + ch.resultText;
        } else if (myReady && !theirReady) statusTxt = 'En attente que l’autre soit prêt…';
        else if (!myReady && theirReady) statusTxt = 'L’autre est prêt — à toi !';
        else if (myReady && theirReady && !started) statusTxt = 'Les deux prêts — démarrage…';

        chronoHtml = `<div class="chrono-box" id="chronoBox">
          <div class="chrono-status" id="chronoStatus">${escapeHtml(statusTxt)}</div>
          <div class="chrono-time" id="chronoTime">00:00.0</div>
          <div class="chrono-meta" id="chronoMeta" style="font-size:11px;color:var(--ink-soft);margin:6px 0;">
            Toi : ${myReady ? (myStopped ? 'stoppé' : (started ? 'en course' : 'prêt')) : 'pas prêt'}
            · Adversaire : ${theirReady ? (theirStopped ? 'stoppé' : (started ? 'en course' : 'prêt')) : 'pas prêt'}
          </div>
          <div class="cactions" style="justify-content:center;flex-wrap:wrap;">
            ${ch.status === 'active' && !started ? `<button type="button" class="primary" id="chronoReadyBtn">${myReady ? 'Prêt ✓' : 'Je suis prêt'}</button>` : ''}
            ${ch.status === 'active' && started && !myStopped ? `<button type="button" class="danger" id="chronoStopBtn">STOP</button>` : ''}
            ${ch.status === 'active' && started && myStopped ? `<button type="button" class="primary" disabled>En attente…</button>` : ''}
          </div>
        </div>`;
      }

      card.innerHTML = `
        <div class="ctype">${CHALLENGE_TYPE_LABELS[ch.type] || ch.type}${multi ? ' · Multi' : ''}</div>
        <div class="ctitle">${escapeHtml(playersLabel)}</div>
        <div class="cmeta">${escapeHtml(detail)}<br>${escapeHtml(statusLine)}</div>
        ${standings}
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
    }));

    // Rebranche les boutons chrono après chaque re-render
    if (activeChronoChallengeId) setupChronoHandlers(activeChronoChallengeId);
  }

  function loadChallenges() {
    if (!currentUser) return;
    stopChallengeListeners();
    cachedChallenges = {};
    const merge = (snap) => {
      snap.forEach(doc => { cachedChallenges[doc.id] = { id: doc.id, ...doc.data() }; });
      snap.docChanges().forEach(change => {
        if (change.type === 'removed') {
          delete cachedChallenges[change.doc.id];
          knownChallengeIds.delete(change.doc.id);
          return;
        }
        const ch = { id: change.doc.id, ...change.doc.data() };
        const uid = currentUser && currentUser.uid;
        if (challengesReady && change.type === 'added' && uid) {
          if (ch.status === 'pending' && ch.toUid === uid && !knownChallengeIds.has(ch.id)) {
            showAppToast('Nouveau défi', (ch.fromPseudo ? '@' + ch.fromPseudo : 'Un ami') + ' t\'a défié');
          }
        }
        knownChallengeIds.add(change.doc.id);
      });
      challengesReady = true;
      renderChallengesList();
      updateChallengeNotifsFromCache();
    };
    challengesUnsubFrom = db.collection('challenges').where('fromUid', '==', currentUser.uid)
      .onSnapshot(merge, err => console.error(err));
    challengesUnsubTo = db.collection('challenges').where('toUid', '==', currentUser.uid)
      .onSnapshot(merge, err => console.error(err));
    if (challengesUnsubMulti) { challengesUnsubMulti(); challengesUnsubMulti = null; }
    challengesUnsubMulti = db.collection('challenges')
      .where('participants', 'array-contains', currentUser.uid)
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
    if (ch.status !== 'active') {
      socialFlash('Ce défi n’est plus actif.', 'err');
      return;
    }
    const isFrom = ch.fromUid === currentUser.uid;
    const multi = isMultiChallenge(ch);
    let myVal = 0, label = 'pts';
    if (ch.type === 'score_day' || ch.type === 'goal') {
      myVal = myScoreToday();
      label = 'pts';
    } else if (ch.type === 'exercise') {
      myVal = myExerciseValue(ch.exerciseId);
      label = ch.exerciseUnit || '';
    }

    try {
      if (multi) {
        await db.collection('challenges').doc(id).update({
          ['scores.' + currentUser.uid]: myVal,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      } else {
        const field = isFrom ? 'fromScore' : 'toScore';
        await db.collection('challenges').doc(id).update({
          [field]: myVal,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      }

      // Relecture fraîche pour éviter les courses
      const snap = await db.collection('challenges').doc(id).get();
      const fresh = snap.data() || {};
      if (fresh.status === 'completed') {
        socialFlash('Défi déjà terminé.', 'ok');
        return;
      }

      if (multi) {
        const parts = fresh.participants || ch.participants || [];
        const scores = fresh.scores || {};
        const allIn = parts.every(uid => typeof scores[uid] === 'number');
        if (!allIn) {
          const done = parts.filter(uid => typeof scores[uid] === 'number').length;
          socialFlash('Score enregistré (' + myVal + ' ' + label + ') — ' + done + '/' + parts.length + ' joueurs', 'ok');
          return;
        }

        // Classement
        const ranked = parts.map(uid => ({
          uid,
          score: scores[uid],
          pseudo: (fresh.pseudos && fresh.pseudos[uid]) || uid
        })).sort((a, b) => b.score - a.score);

        let winnerUid = ranked[0].uid;
        if (ranked.length > 1 && ranked[0].score === ranked[1].score) winnerUid = 'draw';

        if (ch.type === 'goal') {
          const goal = ch.goalPoints || 0;
          const qualifiers = ranked.filter(r => r.score >= goal);
          if (!qualifiers.length) winnerUid = 'draw';
          else {
            winnerUid = qualifiers[0].uid;
            if (qualifiers.length > 1 && qualifiers[0].score === qualifiers[1].score) winnerUid = 'draw';
          }
        }

        const resultText = ranked.map((r, i) => (i + 1) + '. @' + r.pseudo + ' ' + r.score).join(' · ');
        await db.collection('challenges').doc(id).update({
          status: 'completed',
          winnerUid,
          resultText,
          ranking: ranked.map(r => ({ uid: r.uid, score: r.score, pseudo: r.pseudo })),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        tryClaimChallengeXp({
          id,
          status: 'completed',
          winnerUid,
          fromUid: ch.fromUid,
          toUid: ch.toUid
        });
        bumpChallengeStats(winnerUid, true, { title: 'Défi multi', result: resultText });
        if (winnerUid === currentUser.uid) socialFlash('🏆 Tu as gagné ! ' + resultText, 'ok');
        else if (winnerUid === 'draw') socialFlash('Égalité — ' + resultText, 'ok');
        else socialFlash('Classement — ' + resultText, 'ok');
        return;
      }

      const fromScore = typeof fresh.fromScore === 'number' ? fresh.fromScore : null;
      const toScore = typeof fresh.toScore === 'number' ? fresh.toScore : null;

      if (fromScore === null || toScore === null) {
        socialFlash(
          'Ton score (' + myVal + ' ' + label + ') est enregistré. L’autre doit aussi appuyer sur « Envoyer mon score ».',
          'ok'
        );
        return;
      }

      let winnerUid = 'draw';
      let resultText = fromScore + ' vs ' + toScore + (label ? ' ' + label : '');
      if (ch.type === 'goal') {
        const goal = ch.goalPoints || 0;
        const fromOk = fromScore >= goal;
        const toOk = toScore >= goal;
        if (fromOk && !toOk) winnerUid = ch.fromUid;
        else if (toOk && !fromOk) winnerUid = ch.toUid;
        else if (fromOk && toOk) {
          if (fromScore > toScore) winnerUid = ch.fromUid;
          else if (toScore > fromScore) winnerUid = ch.toUid;
        } else {
          winnerUid = 'draw';
        }
        resultText = 'objectif ' + goal + ' — ' + fromScore + ' vs ' + toScore;
      } else {
        if (fromScore > toScore) winnerUid = ch.fromUid;
        else if (toScore > fromScore) winnerUid = ch.toUid;
      }

      await db.collection('challenges').doc(id).update({
        status: 'completed',
        winnerUid,
        resultText,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      tryClaimChallengeXp({
        id,
        status: 'completed',
        winnerUid,
        fromUid: ch.fromUid,
        toUid: ch.toUid
      });
      bumpChallengeStats(winnerUid, false, { title: 'Défi', result: resultText });
      if (winnerUid === currentUser.uid) socialFlash('🏆 Tu as gagné ! ' + resultText, 'ok');
      else if (winnerUid === 'draw') socialFlash('Égalité — ' + resultText, 'ok');
      else socialFlash('Perdu — ' + resultText, 'err');
    } catch (e) {
      console.error(e);
      socialFlash('Erreur : ' + (e.message || 'clôture impossible'), 'err');
    }
  }

  function bumpChallengeStats(winnerUid, isMulti, meta) {
    if (!state.challengeStats) state.challengeStats = { wins: 0, multiWins: 0, played: 0 };
    state.challengeStats.played = (state.challengeStats.played || 0) + 1;
    if (winnerUid === currentUser.uid) {
      state.challengeStats.wins = (state.challengeStats.wins || 0) + 1;
      if (isMulti) state.challengeStats.multiWins = (state.challengeStats.multiWins || 0) + 1;
    }
    const title = (meta && meta.title) || (isMulti ? 'Défi multi' : 'Défi');
    const result = (meta && meta.result) || (
      winnerUid === currentUser.uid ? 'Victoire' :
      winnerUid === 'draw' ? 'Égalité' : 'Défaite'
    );
    recordChallengeDayResult(title, result);
    saveState();
    if (typeof buildBadges === 'function') buildBadges();
    if (typeof renderProfile === 'function') renderProfile();
    if (typeof saveToCloud === 'function') saveToCloud();
  }

  async function tryStartChronoIfBothReady(challengeId) {
    const snap = await db.collection('challenges').doc(challengeId).get();
    if (!snap.exists) return;
    const ch = snap.data();
    const c = ch.chrono || {};
    if (c.startedAt) return;
    if (c.fromReady && c.toReady) {
      await db.collection('challenges').doc(challengeId).update({
        'chrono.startedAt': firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
  }

  function setupChronoHandlers(challengeId) {
    const readyBtn = document.getElementById('chronoReadyBtn');
    const stopBtn = document.getElementById('chronoStopBtn');

    if (readyBtn) {
      readyBtn.onclick = async () => {
        const ch = cachedChallenges[challengeId];
        if (!ch || !currentUser) return;
        const isFrom = ch.fromUid === currentUser.uid;
        const field = isFrom ? 'chrono.fromReady' : 'chrono.toReady';
        try {
          await db.collection('challenges').doc(challengeId).update({
            [field]: true,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
          await tryStartChronoIfBothReady(challengeId);
          socialFlash('Tu es prêt !', 'ok');
        } catch (e) {
          console.error(e);
          socialFlash('Erreur prêt', 'err');
        }
      };
    }

    if (stopBtn) {
      stopBtn.onclick = async () => {
        const ch = cachedChallenges[challengeId];
        if (!ch || !ch.chrono || !ch.chrono.startedAt) {
          socialFlash('Le chrono n’a pas encore démarré', 'err');
          return;
        }
        const isFrom = ch.fromUid === currentUser.uid;
        const myAlready = isFrom ? ch.chrono.fromStoppedAt : ch.chrono.toStoppedAt;
        if (myAlready) {
          socialFlash('Tu as déjà stoppé', 'ok');
          return;
        }
        const fieldStopped = isFrom ? 'chrono.fromStoppedAt' : 'chrono.toStoppedAt';
        try {
          // Chaque joueur peut toujours stopper de son côté
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
            // Celui qui tient le plus longtemps gagne (dernier à stopper)
            let winnerUid = 'draw';
            if (fromMs > toMs) winnerUid = fresh.fromUid;
            else if (toMs > fromMs) winnerUid = fresh.toUid;
            await db.collection('challenges').doc(challengeId).update({
              status: 'completed', winnerUid,
              resultText: `${(fromMs/1000).toFixed(1)}s vs ${(toMs/1000).toFixed(1)}s`,
              'chrono.fromMs': fromMs, 'chrono.toMs': toMs,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            tryClaimChallengeXp({
              id: challengeId, status: 'completed', winnerUid,
              fromUid: fresh.fromUid, toUid: fresh.toUid
            });
            const iWon = winnerUid === currentUser.uid;
            socialFlash(iWon ? '🏆 Tu as gagné le chrono !' : (winnerUid === 'draw' ? 'Égalité' : 'Perdu…'), iWon ? 'ok' : 'err');
          } else {
            socialFlash('Stop OK — l’autre peut encore stopper de son côté', 'ok');
          }
        } catch (e) {
          console.error(e);
          socialFlash('Erreur stop (réessaie)', 'err');
        }
      };
    }

    if (chronoTickTimer) clearInterval(chronoTickTimer);
    chronoTickTimer = setInterval(() => {
      const ch = cachedChallenges[challengeId];
      const timeEl = document.getElementById('chronoTime');
      if (!ch || !timeEl) return;
      const c = ch.chrono || {};
      if (!c.startedAt || !c.startedAt.toMillis) {
        timeEl.textContent = '00:00.0';
        return;
      }
      const start = c.startedAt.toMillis();
      const isFrom = ch.fromUid === currentUser.uid;
      const myStopped = isFrom ? c.fromStoppedAt : c.toStoppedAt;
      const end = myStopped && myStopped.toMillis ? myStopped.toMillis() : Date.now();
      const ms = Math.max(0, end - start);
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const ds = Math.floor((ms % 1000) / 100);
      timeEl.textContent = String(m).padStart(2,'0') + ':' + String(s % 60).padStart(2,'0') + '.' + ds;
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

  /* ---- MESSAGERIE (DM + groupes) ---- */
  let messagesUnsub = null;
  let activeChatId = null;
  let activeChatMeta = null; // { type:'dm'|'group', name, participants, pseudos }

  const CHAT_PALETTE = ['#22C55E','#3B82F6','#F59E0B','#EC4899','#8B5CF6','#14B8A6','#EF4444','#06B6D4'];

  function chatIdFor(uidA, uidB) {
    return [uidA, uidB].sort().join('_');
  }

  function colorForUid(uid) {
    let h = 0;
    const s = String(uid || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return CHAT_PALETTE[h % CHAT_PALETTE.length];
  }

  function formatChatDay(date) {
    const d = date instanceof Date ? date : new Date(date);
    const today = new Date();
    const yday = new Date();
    yday.setDate(today.getDate() - 1);
    const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (same(d, today)) return "Aujourd'hui";
    if (same(d, yday)) return 'Hier';
    return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function formatChatListTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return '';
    const today = new Date();
    const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (same(d, today)) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const yday = new Date();
    yday.setDate(today.getDate() - 1);
    if (same(d, yday)) return 'Hier';
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

  function initialsFromName(name) {
    const s = String(name || '?').replace(/^@/, '').trim();
    if (!s) return '?';
    const parts = s.split(/[\s_]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }

  function displayNameForUid(uid, fallbackPseudo) {
    const nick = state.chatNicknames && state.chatNicknames[uid];
    if (nick) return nick;
    return fallbackPseudo || uid;
  }

  function chatTitleFromMeta(meta) {
    if (!meta) return 'Chat';
    if (meta.type === 'group') return meta.name || 'Groupe';
    const other = (meta.participants || []).find(u => u !== currentUser.uid);
    const base = meta.pseudo || (meta.pseudos && meta.pseudos[other]) || 'ami';
    return '@' + displayNameForUid(other, base);
  }

  function showChatList() {
    document.getElementById('chatListView').style.display = 'block';
    document.getElementById('chatThreadView').style.display = 'none';
    document.getElementById('groupCreateView').style.display = 'none';
    const chv = document.getElementById('chatChallengeView');
    if (chv) chv.style.display = 'none';
    const menu = document.getElementById('chatPlusMenu');
    if (menu) menu.style.display = 'none';
    if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
    activeChatId = null;
    activeChatMeta = null;
    renderConversationsList();
  }

  function openChatThread(chatId, meta) {
    activeChatId = chatId;
    activeChatMeta = meta || { type: 'dm' };
    document.getElementById('chatListView').style.display = 'none';
    document.getElementById('groupCreateView').style.display = 'none';
    const chv = document.getElementById('chatChallengeView');
    if (chv) chv.style.display = 'none';
    const thread = document.getElementById('chatThreadView');
    thread.style.display = 'flex';
    const isAdminChat = chatId === ADMIN_CHAT_ID || (meta && meta.type === 'admin');
    document.getElementById('chatThreadTitle').textContent = isAdminChat ? 'Annonces Admin' : chatTitleFromMeta(meta);
    const renameBtn = document.getElementById('chatRenameBtn');
    if (renameBtn) renameBtn.style.display = isAdminChat ? 'none' : 'inline-flex';
    const plusBtn = document.getElementById('chatPlusBtn');
    if (plusBtn) plusBtn.style.display = isAdminChat ? 'none' : '';
    const input = document.getElementById('chatInput');
    const sendBtn = document.getElementById('chatSendBtn');
    if (isAdminChat && !isAdminUser()) {
      if (input) { input.disabled = true; input.placeholder = 'Seul l’admin peut écrire ici'; }
      if (sendBtn) sendBtn.disabled = true;
    } else {
      if (input) { input.disabled = false; input.placeholder = 'Écrire un message…'; }
      if (sendBtn) sendBtn.disabled = false;
    }
    document.getElementById('chatMessages').innerHTML = '<div class="social-empty">Chargement…</div>';
    document.getElementById('chatInput').value = '';
    const menu = document.getElementById('chatPlusMenu');
    if (menu) menu.style.display = 'none';
    setChatRead(chatId, Date.now());
    // baisse le compteur messages
    if (notifState.messages > 0) {
      // recalcul via listener; force local dip
      notifState.messages = Math.max(0, (notifState.messages || 1) - 1);
      refreshNotifBadge();
    }
    listenMessages(chatId);
  }

  function showChatThread(friend) {
    openChatThread(chatIdFor(currentUser.uid, friend.uid), {
      type: 'dm',
      pseudo: friend.pseudo,
      otherUid: friend.uid,
      participants: [currentUser.uid, friend.uid],
      pseudos: {
        [currentUser.uid]: state.pseudo || '',
        [friend.uid]: friend.pseudo || ''
      }
    });
  }

  async function renderConversationsList() {
    const list = document.getElementById('messagesList');
    if (!currentUser) {
      list.innerHTML = '<div class="social-empty">Connecte-toi pour discuter</div>';
      return;
    }
    list.innerHTML = '';

    // Conversation Admin (tout le monde)
    let adminPreview = 'Annonces officielles';
    let adminWhen = '';
    try {
      const adminSnap = await db.collection('conversations').doc(ADMIN_CHAT_ID).get();
      if (adminSnap.exists) {
        const ad = adminSnap.data() || {};
        if (ad.lastMessage) adminPreview = ad.lastMessage;
        if (ad.updatedAt && ad.updatedAt.toDate) adminWhen = formatChatDay(ad.updatedAt.toDate());
      }
    } catch (e) {}
    const adminCard = document.createElement('div');
    adminCard.className = 'friend-card chatable conv-card admin-conv';
    adminCard.innerHTML = `
      <div class="conv-avatar group">📢</div>
      <div class="conv-body">
        <div class="fname">Annonces Admin</div>
        <div class="fmeta">${escapeHtml((adminPreview || '').slice(0, 48))}</div>
      </div>
      <div class="conv-date">${escapeHtml(adminWhen)}</div>`;
    adminCard.addEventListener('click', () => {
      openChatThread(ADMIN_CHAT_ID, {
        type: 'admin',
        name: 'Annonces Admin',
        participants: [],
        pseudos: {}
      });
    });
    list.appendChild(adminCard);

    try {
      const snap = await db.collection('conversations')
        .where('participants', 'array-contains', currentUser.uid)
        .limit(40)
        .get();
      if (snap.empty) {
        return;
      }
      const rows = [];
      snap.forEach(doc => {
        if (doc.id === ADMIN_CHAT_ID) return;
        rows.push({ id: doc.id, ...doc.data() });
      });
      rows.sort((a, b) => {
        const ta = a.updatedAt && a.updatedAt.toMillis ? a.updatedAt.toMillis() : 0;
        const tb = b.updatedAt && b.updatedAt.toMillis ? b.updatedAt.toMillis() : 0;
        return tb - ta;
      });
      rows.forEach(c => {
        const isGroup = c.type === 'group';
        let title = c.name || 'Groupe';
        let otherUid = null;
        let avatarColor = '#22C55E';
        if (!isGroup) {
          otherUid = (c.participants || []).find(u => u !== currentUser.uid);
          const base = (c.pseudos && c.pseudos[otherUid]) || otherUid || 'ami';
          title = '@' + displayNameForUid(otherUid, base);
          avatarColor = colorForUid(otherUid);
        } else {
          avatarColor = colorForUid(c.id || title);
        }
        let when = '';
        if (c.updatedAt && c.updatedAt.toDate) when = formatChatListTime(c.updatedAt.toDate());
        const preview = (c.lastMessage || '').trim() || (isGroup ? 'Groupe' : 'Discussion');
        const unread = !!(c.updatedAt && c.updatedAt.toMillis && getChatReadMap()[c.id] && c.updatedAt.toMillis() > (getChatReadMap()[c.id] || 0));
        // simpler unread: if lastFrom is not me and updated after last read
        let isUnread = false;
        try {
          const readMap = getChatReadMap();
          const lastRead = readMap[c.id] || 0;
          const updatedMs = c.updatedAt && c.updatedAt.toMillis ? c.updatedAt.toMillis() : 0;
          isUnread = updatedMs > lastRead && c.lastFrom && c.lastFrom !== currentUser.uid;
        } catch (e) {}
        const card = document.createElement('div');
        card.className = 'friend-card chatable conv-card' + (isUnread ? ' unread' : '');
        const avContent = isGroup ? '👥' : escapeHtml(initialsFromName(title));
        card.innerHTML = `
          <div class="conv-avatar ${isGroup ? 'group' : ''}" style="background:${avatarColor}33;color:${avatarColor};border-color:${avatarColor}66">${avContent}</div>
          <div class="conv-body">
            <div class="fname">${escapeHtml(title)}${isUnread ? '<span class="conv-unread-dot"></span>' : ''}</div>
            <div class="fmeta">${escapeHtml(preview.slice(0, 56))}</div>
          </div>
          <div class="conv-date">${escapeHtml(when)}</div>`;
        card.addEventListener('click', () => {
          if (isGroup) {
            openChatThread(c.id, {
              type: 'group',
              name: c.name || 'Groupe',
              participants: c.participants || [],
              pseudos: c.pseudos || {}
            });
          } else {
            const other = (c.participants || []).find(u => u !== currentUser.uid);
            showChatThread({
              uid: other,
              pseudo: (c.pseudos && c.pseudos[other]) || other
            });
          }
        });
        list.appendChild(card);
      });
    } catch (e) {
      console.error(e);
      const err = document.createElement('div');
      err.className = 'social-empty';
      err.textContent = 'Erreur conversations (index Firestore ?)';
      list.appendChild(err);
    }
  }

  async function renderChatFriendsList() {
    const list = document.getElementById('messagesFriendsList');
    if (!list) return;
    if (!currentUser) {
      list.innerHTML = '<div class="social-empty">Connecte-toi</div>';
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
            <div class="fmeta">Message privé</div>
          </div>
          <div class="friend-actions">
            <button type="button" class="primary">Écrire</button>
          </div>`;
        card.addEventListener('click', () => showChatThread({ uid: doc.id, pseudo: f.pseudo || doc.id }));
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
    const isGroup = activeChatMeta && activeChatMeta.type === 'group';
    messagesUnsub = db.collection('conversations').doc(chatId).collection('messages')
      .orderBy('createdAt', 'asc')
      .limitToLast(120)
      .onSnapshot(snap => {
        if (snap.empty) {
          box.innerHTML = '<div class="social-empty">Aucun message — dis bonjour 👋</div>';
          return;
        }
        box.innerHTML = '';
        let lastDayKey = '';
        snap.forEach(doc => {
          const m = doc.data();
          const mine = m.from === currentUser.uid;
          let d = null;
          if (m.createdAt && m.createdAt.toDate) d = m.createdAt.toDate();
          if (d) {
            const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
            if (key !== lastDayKey) {
              lastDayKey = key;
              const sep = document.createElement('div');
              sep.className = 'chat-day-sep';
              sep.textContent = formatChatDay(d);
              box.appendChild(sep);
            }
          }
          const wrap = document.createElement('div');
          wrap.className = 'chat-row ' + (mine ? 'me' : 'them');
          const col = colorForUid(m.from);
          const pseudo = m.fromPseudo ||
            (activeChatMeta && activeChatMeta.pseudos && activeChatMeta.pseudos[m.from]) ||
            '';
          const shownName = displayNameForUid(m.from, pseudo);
          if (!mine && isGroup) {
            const av = document.createElement('div');
            av.className = 'chat-msg-avatar';
            av.style.background = col + '33';
            av.style.color = col;
            av.textContent = initialsFromName(shownName || pseudo || '?');
            wrap.appendChild(av);
          }
          const bubble = document.createElement('div');
          bubble.className = 'chat-bubble ' + (mine ? 'me' : 'them');
          if (!mine && isGroup) {
            bubble.style.borderLeft = '3px solid ' + col;
            bubble.style.background = col + '18';
          }
          let time = '';
          if (d) time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
          const nameHtml = (!mine && isGroup && (shownName || pseudo))
            ? `<div class="cname" style="color:${col}">${escapeHtml(shownName || pseudo)}</div>`
            : (!mine && (shownName || pseudo) ? `<div class="cname">${escapeHtml(shownName || pseudo)}</div>` : '');
          const kind = m.kind || 'text';
          if (kind === 'score') {
            bubble.classList.add('chat-card', 'chat-card-score');
            bubble.innerHTML = `${nameHtml}
              <div class="chat-card-title">📊 Score du jour</div>
              <div class="chat-card-big">${escapeHtml(String(m.score ?? '—'))} <span>pts</span></div>
              <div class="chat-card-sub">${escapeHtml(m.rankName || '')}${m.dayKey ? ' · ' + escapeHtml(m.dayKey) : ''}</div>
              <span class="ctime">${time}</span>`;
          } else if (kind === 'calendar') {
            bubble.classList.add('chat-card', 'chat-card-cal');
            bubble.innerHTML = `${nameHtml}
              <div class="chat-card-title">📅 Calendrier</div>
              <div class="chat-card-big" style="font-size:16px;">${escapeHtml(m.calTitle || 'Séance')}</div>
              <div class="chat-card-sub">${escapeHtml(m.dayKey || '')}${m.calDetails ? ' · ' + escapeHtml(m.calDetails) : ''}</div>
              <button type="button" class="chat-card-btn" data-open-cal="${escapeHtml(m.dayKey || '')}">Voir dans le calendrier</button>
              <span class="ctime">${time}</span>`;
          } else if (kind === 'vote') {
            bubble.classList.add('chat-card', 'chat-card-vote');
            const votes = m.votes || {};
            const opts = m.options || [];
            const counts = {};
            opts.forEach(o => { counts[o.id] = 0; });
            Object.values(votes).forEach(v => { if (counts[v] != null) counts[v]++; });
            const totalVotes = Object.keys(votes).length;
            const myVote = votes[currentUser.uid];
            let optsHtml = opts.map(o => {
              const n = counts[o.id] || 0;
              const pct = totalVotes ? Math.round((n / totalVotes) * 100) : 0;
              const selected = myVote === o.id ? ' selected' : '';
              return `<button type="button" class="vote-opt${selected}" data-vote-msg="${doc.id}" data-vote-opt="${escapeHtml(o.id)}">
                <span class="vote-label">${escapeHtml(o.label)}</span>
                <span class="vote-count">${n} · ${pct}%</span>
                <span class="vote-bar" style="width:${pct}%"></span>
              </button>`;
            }).join('');
            bubble.innerHTML = `${nameHtml}
              <div class="chat-card-title">🗳️ ${escapeHtml(m.voteTitle || 'Vote défi')}</div>
              <div class="chat-card-sub">${totalVotes} vote${totalVotes > 1 ? 's' : ''}</div>
              <div class="vote-opts">${optsHtml}</div>
              <span class="ctime">${time}</span>`;
          } else {
            bubble.innerHTML = `${nameHtml}<div class="cbody">${escapeHtml(m.text || '')}</div><span class="ctime">${time}</span>`;
          }
          wrap.appendChild(bubble);
          box.appendChild(wrap);
        });
        // bind calendar + vote buttons
        box.querySelectorAll('[data-open-cal]').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const key = btn.getAttribute('data-open-cal');
            if (typeof showSection === 'function') showSection('section-calendar');
            if (typeof selectCalDay === 'function' && key) selectCalDay(key);
            if (typeof closeSocialPanel === 'function') closeSocialPanel();
          });
        });
        box.querySelectorAll('[data-vote-msg]').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const msgId = btn.getAttribute('data-vote-msg');
            const optId = btn.getAttribute('data-vote-opt');
            if (!msgId || !optId || !activeChatId || !currentUser) return;
            try {
              await db.collection('conversations').doc(activeChatId)
                .collection('messages').doc(msgId)
                .set({ votes: { [currentUser.uid]: optId } }, { merge: true });
            } catch (err) {
              console.error(err);
              socialFlash('Vote impossible', 'err');
            }
          });
        });
        box.scrollTop = box.scrollHeight;
      }, err => {
        console.error(err);
        box.innerHTML = '<div class="social-empty">Erreur messages (règles Firestore ?)</div>';
      });
  }


  async function postSpecialChatMessage(kind, data, previewText) {
    if (activeChatId === ADMIN_CHAT_ID && !isAdminUser()) {
      socialFlash('Seul l’admin peut écrire dans Annonces Admin', 'err');
      return;
    }
    if (!currentUser || !activeChatId || !activeChatMeta) return;
    try {
      const convRef = db.collection('conversations').doc(activeChatId);
      const msgRef = convRef.collection('messages').doc();
      const batch = db.batch();
      const participants = (activeChatMeta.participants || []).slice().sort();
      const pseudos = Object.assign({}, activeChatMeta.pseudos || {}, {
        [currentUser.uid]: state.pseudo || ''
      });
      const payload = {
        type: activeChatMeta.type || 'dm',
        participants,
        pseudos,
        lastMessage: (previewText || '').slice(0, 120),
        lastFrom: currentUser.uid,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      if (activeChatMeta.type === 'group') payload.name = activeChatMeta.name || 'Groupe';
      batch.set(convRef, payload, { merge: true });
      batch.set(msgRef, Object.assign({
        from: currentUser.uid,
        fromPseudo: state.pseudo || '',
        kind,
        text: previewText || '',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }, data || {}));
      await batch.commit();
      logEvent('message_special', { kind });
    } catch (e) {
      console.error(e);
      socialFlash('Envoi impossible', 'err');
    }
  }

  async function sendScoreShare() {
    document.getElementById('chatPlusMenu').style.display = 'none';
    if (!currentUser || !activeChatId) return;
    const score = typeof computeScore === 'function' ? Math.round(computeScore(state)) : 0;
    const rank = typeof getRank === 'function' ? getRank(score).current : { name: '—' };
    const day = typeof todayKey === 'function' ? todayKey() : '';
    await postSpecialChatMessage('score', {
      score,
      rankName: rank.name || '',
      dayKey: day
    }, 'Score : ' + score + ' pts (' + (rank.name || '') + ')');
    socialFlash('Score envoyé', 'ok');
  }

  async function sendCalendarShare() {
    document.getElementById('chatPlusMenu').style.display = 'none';
    if (!currentUser || !activeChatId) return;
    const day = (typeof calSelectedKey !== 'undefined' && calSelectedKey)
      ? calSelectedKey
      : (typeof todayKey === 'function' ? todayKey() : '');
    let title = 'Séance du ' + day;
    let details = '';
    if (state.plannedSessions && state.plannedSessions[day]) {
      const p = state.plannedSessions[day];
      title = p.title || title;
      details = p.details || '';
    } else if (state.dayNotes && state.dayNotes[day]) {
      details = String(state.dayNotes[day]).slice(0, 120);
      title = 'Note du ' + day;
    } else if (day === (typeof todayKey === 'function' ? todayKey() : '') && typeof computeScore === 'function') {
      const sc = Math.round(computeScore(state));
      details = sc > 0 ? ('Score en cours : ' + sc + ' pts') : 'Rien de programmé — jour libre';
    } else {
      details = 'Rien de programmé sur ce jour';
    }
    await postSpecialChatMessage('calendar', {
      dayKey: day,
      calTitle: title,
      calDetails: details
    }, '📅 ' + title);
    socialFlash('Jour partagé', 'ok');
  }

  async function sendChallengeVote() {
    document.getElementById('chatPlusMenu').style.display = 'none';
    if (!currentUser || !activeChatId) return;
    const options = [
      { id: 'score_day', label: 'Score du jour' },
      { id: 'exercise', label: 'Exercice (pompes…)' },
      { id: 'chrono', label: 'Chrono duel' },
      { id: 'goal', label: 'Objectif points' }
    ];
    await postSpecialChatMessage('vote', {
      voteTitle: 'Quel défi on fait ?',
      options,
      votes: {}
    }, '🗳️ Vote défi');
    socialFlash('Vote créé', 'ok');
  }

  async function sendChatMessage() {
    if (activeChatId === ADMIN_CHAT_ID && !isAdminUser()) {
      socialFlash('Seul l’admin peut écrire dans Annonces Admin', 'err');
      return;
    }
    if (!currentUser || !activeChatId || !activeChatMeta) return;
    const input = document.getElementById('chatInput');
    const text = (input.value || '').trim();
    if (!text) return;
    input.value = '';
    try {
      const convRef = db.collection('conversations').doc(activeChatId);
      const msgRef = convRef.collection('messages').doc();
      const batch = db.batch();
      const participants = (activeChatMeta.participants || []).slice().sort();
      const pseudos = Object.assign({}, activeChatMeta.pseudos || {}, {
        [currentUser.uid]: state.pseudo || ''
      });
      const payload = {
        type: activeChatMeta.type || 'dm',
        participants,
        pseudos,
        lastMessage: text.slice(0, 120),
        lastFrom: currentUser.uid,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      if (activeChatMeta.type === 'group') payload.name = activeChatMeta.name || 'Groupe';
      batch.set(convRef, payload, { merge: true });
      batch.set(msgRef, {
        from: currentUser.uid,
        fromPseudo: state.pseudo || '',
        text: text.slice(0, 500),
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await batch.commit();
      logEvent('message_sent', { type: activeChatMeta.type || 'dm' });
    } catch (e) {
      console.error(e);
      socialFlash('Impossible d’envoyer le message', 'err');
    }
  }

  async function openGroupCreate() {
    document.getElementById('chatListView').style.display = 'none';
    document.getElementById('chatThreadView').style.display = 'none';
    document.getElementById('groupCreateView').style.display = 'block';
    document.getElementById('groupNameInput').value = '';
    const box = document.getElementById('groupMembersPick');
    box.innerHTML = '<div class="social-empty">Chargement…</div>';
    try {
      const snap = await db.collection('users').doc(currentUser.uid).collection('friends').get();
      if (snap.empty) {
        box.innerHTML = '<div class="social-empty">Ajoute des amis avant de créer un groupe</div>';
        return;
      }
      box.innerHTML = '';
      snap.forEach(doc => {
        const f = doc.data();
        const row = document.createElement('label');
        row.className = 'group-pick-row';
        row.innerHTML = `
          <input type="checkbox" value="${doc.id}" data-pseudo="${escapeHtml(f.pseudo || doc.id)}">
          <span>@${escapeHtml(f.pseudo || doc.id)}</span>`;
        box.appendChild(row);
      });
    } catch (e) {
      console.error(e);
      box.innerHTML = '<div class="social-empty">Erreur</div>';
    }
  }

  async function createGroup() {
    if (!currentUser) return;
    const name = (document.getElementById('groupNameInput').value || '').trim().slice(0, 40);
    if (name.length < 2) {
      socialFlash('Nom de groupe trop court', 'err');
      return;
    }
    const checks = Array.from(document.querySelectorAll('#groupMembersPick input[type=checkbox]:checked'));
    if (!checks.length) {
      socialFlash('Choisis au moins un ami', 'err');
      return;
    }
    const participants = [currentUser.uid];
    const pseudos = { [currentUser.uid]: state.pseudo || '' };
    checks.forEach(c => {
      participants.push(c.value);
      pseudos[c.value] = c.getAttribute('data-pseudo') || c.value;
    });
    try {
      const ref = db.collection('conversations').doc();
      await ref.set({
        type: 'group',
        name,
        participants,
        pseudos,
        createdBy: currentUser.uid,
        lastMessage: 'Groupe créé',
        lastFrom: currentUser.uid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      socialFlash('Groupe « ' + name + ' » créé', 'ok');
      openChatThread(ref.id, { type: 'group', name, participants, pseudos });
      logEvent('group_created');
    } catch (e) {
      console.error(e);
      socialFlash('Création impossible (règles Firestore ?)', 'err');
    }
  }

  async function renameChat() {
    if (!activeChatMeta) return;
    if (activeChatMeta.type === 'group') {
      if (!activeChatId) return;
      const next = prompt('Nouveau nom du groupe :', activeChatMeta.name || '');
      if (next === null) return;
      const name = next.trim().slice(0, 40);
      if (name.length < 2) {
        socialFlash('Nom trop court', 'err');
        return;
      }
      try {
        await db.collection('conversations').doc(activeChatId).update({
          name,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        activeChatMeta.name = name;
        document.getElementById('chatThreadTitle').textContent = name;
        socialFlash('Groupe renommé', 'ok');
      } catch (e) {
        console.error(e);
        socialFlash('Renommage impossible', 'err');
      }
      return;
    }
    // Surnom local pour un contact
    const other = activeChatMeta.otherUid || (activeChatMeta.participants || []).find(u => u !== currentUser.uid);
    if (!other) return;
    const current = displayNameForUid(other, activeChatMeta.pseudo || other);
    const next = prompt('Surnom pour ce contact (local) :', current);
    if (next === null) return;
    const nick = next.trim().slice(0, 30);
    if (!state.chatNicknames) state.chatNicknames = {};
    if (!nick) delete state.chatNicknames[other];
    else state.chatNicknames[other] = nick;
    saveState();
    if (typeof saveToCloud === 'function') saveToCloud();
    document.getElementById('chatThreadTitle').textContent = chatTitleFromMeta(activeChatMeta);
    socialFlash(nick ? 'Surnom synchronisé (tous tes appareils)' : 'Surnom effacé', 'ok');
  }

  function toggleChatPlusMenu() {
    const menu = document.getElementById('chatPlusMenu');
    if (!menu) return;
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  }

  function openChatChallengeComposer() {
    if (!activeChatMeta || !currentUser) return;
    document.getElementById('chatPlusMenu').style.display = 'none';
    document.getElementById('chatThreadView').style.display = 'none';
    document.getElementById('chatChallengeView').style.display = 'block';

    const typeSel = document.getElementById('chatChType');
    const syncFields = () => {
      document.getElementById('chatChExField').style.display = typeSel.value === 'exercise' ? 'block' : 'none';
      document.getElementById('chatChGoalField').style.display = typeSel.value === 'goal' ? 'block' : 'none';
    };
    typeSel.onchange = syncFields;
    syncFields();

    const exSel = document.getElementById('chatChEx');
    exSel.innerHTML = '';
    (state.exercises || []).forEach(ex => {
      const opt = document.createElement('option');
      opt.value = ex.id;
      opt.textContent = ex.name;
      exSel.appendChild(opt);
    });

    const box = document.getElementById('chatChMembers');
    const parts = (activeChatMeta.participants || []).filter(u => u !== currentUser.uid);
    if (activeChatMeta.type === 'dm' && parts[0]) {
      const pseudo = activeChatMeta.pseudo || (activeChatMeta.pseudos && activeChatMeta.pseudos[parts[0]]) || parts[0];
      box.innerHTML = `<label class="group-pick-row"><input type="checkbox" checked disabled value="${parts[0]}" data-pseudo="${escapeHtml(pseudo)}"><span>@${escapeHtml(displayNameForUid(parts[0], pseudo))} (toi inclus)</span></label>`;
    } else {
      box.innerHTML = '';
      parts.forEach(uid => {
        const pseudo = (activeChatMeta.pseudos && activeChatMeta.pseudos[uid]) || uid;
        const row = document.createElement('label');
        row.className = 'group-pick-row';
        row.innerHTML = `<input type="checkbox" checked value="${uid}" data-pseudo="${escapeHtml(pseudo)}"><span>@${escapeHtml(displayNameForUid(uid, pseudo))}</span>`;
        box.appendChild(row);
      });
    }
  }

  async function sendChatChallenge() {
    if (!currentUser || !state.pseudo || !activeChatMeta) return;
    const type = document.getElementById('chatChType').value;
    let memberInputs = Array.from(document.querySelectorAll('#chatChMembers input[type=checkbox]'));
    if (activeChatMeta.type === 'dm') {
      memberInputs = memberInputs; // already the other person
    } else {
      memberInputs = memberInputs.filter(i => i.checked);
    }
    const others = memberInputs.map(i => ({
      uid: i.value,
      pseudo: i.getAttribute('data-pseudo') || i.value
    }));
    if (!others.length) {
      socialFlash('Choisis au moins un participant', 'err');
      return;
    }
    if (others.length > 3) {
      socialFlash('Maximum 4 personnes (toi + 3)', 'err');
      return;
    }

    const participants = [currentUser.uid, ...others.map(o => o.uid)];
    const pseudos = { [currentUser.uid]: state.pseudo };
    others.forEach(o => { pseudos[o.uid] = o.pseudo; });
    const scores = {};
    participants.forEach(u => { scores[u] = null; });

    const data = {
      type,
      mode: participants.length > 2 ? 'multi' : 'duo',
      fromUid: currentUser.uid,
      fromPseudo: state.pseudo,
      toUid: others[0].uid,
      toPseudo: others[0].pseudo,
      participants,
      pseudos,
      scores,
      status: 'active',
      dayKey: todayKey(),
      conversationId: activeChatId || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    if (type === 'exercise') {
      const exId = document.getElementById('chatChEx').value;
      const ex = (state.exercises || []).find(e => e.id === exId);
      if (!ex) { socialFlash('Exercice invalide', 'err'); return; }
      data.exerciseId = ex.id;
      data.exerciseName = ex.name;
      data.exerciseUnit = ex.unit;
    }
    if (type === 'goal') {
      const g = parseFloat(document.getElementById('chatChGoal').value) || 0;
      if (g < 10) { socialFlash('Objectif trop bas', 'err'); return; }
      data.goalPoints = g;
    }

    try {
      await db.collection('challenges').add(data);
      // Message système dans le chat
      if (activeChatId) {
        const convRef = db.collection('conversations').doc(activeChatId);
        await convRef.collection('messages').add({
          from: currentUser.uid,
          fromPseudo: state.pseudo || '',
          text: '🏆 Défi lancé : ' + (type === 'score_day' ? 'Score du jour' : type === 'exercise' ? (data.exerciseName || 'Exercice') : ('Objectif ' + data.goalPoints + ' pts')) + ' (' + participants.length + ' joueurs)',
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          system: true
        });
        await convRef.set({
          lastMessage: '🏆 Nouveau défi',
          lastFrom: currentUser.uid,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
      socialFlash('Défi envoyé à ' + participants.length + ' joueurs', 'ok');
      logEvent('challenge_sent_chat', { type, n: participants.length });
      document.getElementById('chatChallengeView').style.display = 'none';
      document.getElementById('chatThreadView').style.display = 'flex';
    } catch (e) {
      console.error(e);
      socialFlash('Erreur envoi défi (règles ?)', 'err');
    }
  }

  document.getElementById('chatBackBtn').addEventListener('click', showChatList);
  document.getElementById('chatSendBtn').addEventListener('click', sendChatMessage);
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatMessage();
  });
  document.getElementById('createGroupBtn')?.addEventListener('click', openGroupCreate);
  document.getElementById('groupCreateCancel')?.addEventListener('click', showChatList);
  document.getElementById('groupCreateConfirm')?.addEventListener('click', createGroup);
  document.getElementById('chatRenameBtn')?.addEventListener('click', renameChat);
  document.getElementById('chatPlusBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleChatPlusMenu();
  });
  document.getElementById('chatPlusRename')?.addEventListener('click', () => {
    document.getElementById('chatPlusMenu').style.display = 'none';
    renameChat();
  });
  document.getElementById('chatPlusChallenge')?.addEventListener('click', openChatChallengeComposer);
  document.getElementById('chatPlusScore')?.addEventListener('click', sendScoreShare);
  document.getElementById('chatPlusCalendar')?.addEventListener('click', sendCalendarShare);
  document.getElementById('chatPlusVote')?.addEventListener('click', sendChallengeVote);
  document.getElementById('chatChCancel')?.addEventListener('click', () => {
    document.getElementById('chatChallengeView').style.display = 'none';
    document.getElementById('chatThreadView').style.display = 'flex';
  });
  document.getElementById('chatChSend')?.addEventListener('click', sendChatChallenge);

  // Quand on ouvre l'onglet Messages
  document.querySelectorAll('.social-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.social === 'messages') {
        showChatList();
      }
    });
  });

  auth && auth.onAuthStateChanged((user) => {
    refreshSocialLoginGate();
    if (!user) {
      stopSocialListeners();
      if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
      const badge = document.getElementById('socialBadge');
      if (badge) badge.classList.remove('show');
      showChatList();
    }
  });

