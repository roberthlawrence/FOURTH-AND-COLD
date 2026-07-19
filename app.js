/* =========================================================
   4TH & COLD SQUARES — app.js
   Firebase Firestore + Auth (anonymous for players,
   Google sign-in for admins) + ESPN scoreboard API.
   ========================================================= */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously,
  signInWithPopup, signInWithRedirect, getRedirectResult,
  GoogleAuthProvider, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, collection, onSnapshot, getDoc, getDocs,
  setDoc, updateDoc, deleteDoc, addDoc, serverTimestamp, writeBatch,
  query, orderBy, limit, startAfter
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ---------------- constants / state ---------------- */
const GRID = 10;
const ESPN_ROOT = "https://site.api.espn.com/apis/site/v2/sports";
const ESPN = ESPN_ROOT + "/football/college-football";
const TEXAS_TEAM_ID = "251";
const MLB_TEAM_ID = "13"; // Texas Rangers
const sportMode = () => cfg?.sportMode || "cfb";
const soccerMode = () => sportMode() === "soccer";
const mlbMode = () => sportMode() === "mlb";
const espnBase = () =>
  soccerMode() ? ESPN_ROOT + "/soccer/fifa.world" :
  mlbMode() ? ESPN_ROOT + "/baseball/mlb" : ESPN;
const numPeriods = () => soccerMode() ? 2 : 4;
const periodLabel = (q) =>
  soccerMode() ? (q === 1 ? "HALF" : "FINAL") :
  mlbMode() ? "INN " + q :
  "Q" + q; // Q4 pays end-of-regulation; the true final (incl. OT) shows as a separate FINAL chip
const LIVE_POLL_MS = 60_000;
/* College season runs Aug–Jan; in Jan the "season" is still last year's */
function seasonYear() {
  const now = new Date();
  return now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
}
async function fetchTexasSchedule() {
  // Try most-specific first: explicit season + regular-season type, then
  // looser variants. Track errors so the UI can tell "blocked" from "empty".
  const yr = seasonYear();
  const urls = [
    `${ESPN}/teams/${TEXAS_TEAM_ID}/schedule?season=${yr}&seasontype=2`,
    `${ESPN}/teams/${TEXAS_TEAM_ID}/schedule?season=${yr}`,
    `${ESPN}/teams/${TEXAS_TEAM_ID}/schedule?season=${yr + 1}&seasontype=2`,
    `${ESPN}/teams/${TEXAS_TEAM_ID}/schedule`
  ];
  let lastError = null;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) { lastError = "HTTP " + res.status; continue; }
      const data = await res.json();
      if ((data.events || []).length) return data;
    } catch (err) { lastError = err.message || String(err); }
  }
  return { events: [], error: lastError };
}
/* World Cup has no "team schedule" — sweep the tournament scoreboard across a
   date window (recent results + upcoming matches) */
async function fetchWorldCupMatches() {
  const DAY = 86400000;
  const fmt = (t) => {
    const d = new Date(t);
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  };
  const start = Date.now() - 12 * DAY, end = Date.now() + 14 * DAY;
  const seen = new Set(), events = [];
  const collect = (data) => (data?.events || []).forEach(e => {
    if (!seen.has(e.id)) { seen.add(e.id); events.push(e); }
  });
  // Try the date-range form first (one request)…
  try {
    const res = await fetch(`${ESPN_ROOT}/soccer/fifa.world/scoreboard?dates=${fmt(start)}-${fmt(end)}`);
    collect(await res.json());
  } catch (_) {}
  // …fall back to per-day requests in parallel
  if (!events.length) {
    const days = [];
    for (let t = start; t <= end; t += DAY) days.push(t);
    const results = await Promise.allSettled(days.map(t =>
      fetch(`${ESPN_ROOT}/soccer/fifa.world/scoreboard?dates=${fmt(t)}`).then(r => r.json())
    ));
    results.forEach(r => { if (r.status === "fulfilled") collect(r.value); });
  }
  events.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  return events.map(e => ({
    opponent: e.name || e.shortName || "Match",
    date: (e.date || "").slice(0, 10),
    espnEventId: e.id
  }));
}

let me = { fullName: "", email: "" };     // player identity (honor system, uid-backed)
let uid = null;
let adminEmail = null;                    // set when Google-signed-in AND allow-listed
let cfg = null;                           // config/current
let squares = new Map();                  // "r_c" -> data
let games = [];                           // sorted game docs
let activeGameId = null;
let liveTimer = null;
let liveState = null;                     // latest ESPN pull for active game
let unsubGames = null, unsubSquares = null, unsubCfg = null, unsubPay = null;
let payments = new Map();                 // email -> payment doc
let payouts = new Map();                  // "gameId_qN" -> payout confirmation doc
let profiles = new Map();                 // emailDocId -> {firstName, lastName, email}
let unsubPayouts = null, unsubProfiles = null;
let highlightEmail = null;                // payment-admin highlight: whose squares glow blue

/* ---------------- tiny DOM helpers ---------------- */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3200);
}
const money = (n) => "$" + Number(n || 0).toLocaleString();
const digitsOf = (n) => Math.abs(Number(n) || 0) % 10;

/* ---------------- branded loading screen ----------------
   Shown on load and on every screen transition — minimum display time keeps
   the logo-fill animation from flickering on fast operations. */
const LOAD_MIN_MS = 750;
let loadShownAt = 0;
function showLoading() {
  loadShownAt = Date.now();
  $("loadScreen").classList.add("show");
}
function hideLoading() {
  const wait = Math.max(0, LOAD_MIN_MS - (Date.now() - loadShownAt));
  setTimeout(() => $("loadScreen").classList.remove("show"), wait);
}

/* ---------------- identity ---------------- */
function loadIdentity() {
  try {
    const n = localStorage.getItem("fc_name"), e = localStorage.getItem("fc_email");
    if (n && e) { me = { fullName: n, email: e.toLowerCase() }; return true; }
  } catch (_) {}
  return false;
}
function saveIdentity() {
  try {
    localStorage.setItem("fc_name", me.fullName);
    localStorage.setItem("fc_email", me.email);
  } catch (_) {}
}

/* ---------------- boot / auth ----------------
   Players get an invisible anonymous session (needed to write claims).
   Identity is email-based with double-entry confirmation at signup.
   Admins use Google sign-in. */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    adminEmail = null;
    await signInAnonymously(auth).catch(err => toast("Auth error: " + err.message));
    return;
  }
  uid = user.uid;
  if (!user.isAnonymous && user.email &&
      user.providerData.some(p => p.providerId === "google.com")) {
    adminEmail = user.email.toLowerCase();
  }
  route();
  if (cfg) onConfig();
});

/* Player can act once they have an identity and any auth session */
function canAct() {
  return !!(auth.currentUser && me.email);
}

function route() {
  const hasId = loadIdentity();
  $("welcomePanel").classList.toggle("hidden", hasId);
  $("app").classList.toggle("hidden", !hasId);
  $("userChip").classList.toggle("hidden", !hasId);
  if (hasId) $("userChipName").textContent = me.fullName;
}

/* ---------------- Firestore listeners ---------------- */
function startListeners() {
  if (unsubCfg) return; // already running
  unsubCfg = onSnapshot(doc(db, "config", "current"), (snap) => {
    cfg = snap.exists() ? snap.data() : null;
    onConfig();
    hideLoading(); // boot loader ends once live data arrives
  });
  unsubSquares = onSnapshot(collection(db, "squares"), (qs) => {
    squares.clear();
    qs.forEach(d => squares.set(d.id, d.data()));
    renderBoard(); renderMyPanel(); renderPot();
    if (isAdmin()) renderPayments();
  });
  unsubGames = onSnapshot(collection(db, "games"), (qs) => {
    games = [];
    qs.forEach(d => games.push({ id: d.id, ...d.data() }));
    games.sort((a, b) => (a.order || 0) - (b.order || 0));
    if (!activeGameId && games.length) activeGameId = defaultGame().id;
    renderTabs(); renderBoard(); renderWinners(); renderAdminGame(); renderPot(); renderWinnerBanner();
    if (isAdmin()) renderPayoutsList();
  });
  unsubPayouts = onSnapshot(collection(db, "payouts"), (qs) => {
    payouts.clear();
    qs.forEach(d => payouts.set(d.id, d.data()));
    renderWinners(); renderWinnerBanner();
    if (isAdmin()) renderPayoutsList();
  });
}

function defaultGame() {
  // Land on the game that matters: preseason → game 1; in season → the live or
  // next game; a finished game keeps the spotlight for 3 days ("did I win?"),
  // then the default rolls forward.
  const now = Date.now();
  const AFTERGLOW = 3 * 86400000;
  const pick = games.find(g => {
    if (!g.finalScore) return true; // not finished (upcoming, live, or awaiting score pull)
    const t = Date.parse((g.date || "") + "T12:00:00");
    return !isNaN(t) && now < t + AFTERGLOW; // finished, still in its 3-day window
  });
  return pick || games[games.length - 1];
}

function isPowerAdmin() {
  return !!(adminEmail && cfg && (cfg.adminEmails || []).map(e => e.toLowerCase()).includes(adminEmail));
}
function isPaymentAdmin() {
  return !!(adminEmail && cfg && (cfg.paymentAdminEmails || []).map(e => e.toLowerCase()).includes(adminEmail));
}
function isAdmin() { return isPowerAdmin() || isPaymentAdmin(); }
/* Payment admins can rename/release squares; power admins can do anything */
function canManageSquares() { return isAdmin(); }

/* ---- audit trail: every meaningful action gets a row ---- */
function audit(action, details) {
  const actor = adminEmail || me.email || "anonymous";
  const role = isPowerAdmin() ? "power-admin" : isPaymentAdmin() ? "payment-admin" : "player";
  addDoc(collection(db, "audit"), {
    ts: serverTimestamp(),
    actor, actorName: me.fullName || "", role,
    action, details: details || ""
  }).catch(() => { /* audit must never block the action itself */ });
}

function onConfig() {
  if (!cfg) {
    // First run: no season configured yet
    $("welcomeBlurb").textContent = "Season not configured yet. Admin: sign in and run Season setup.";
    if (adminEmail) { // let a signed-in Googler bootstrap
      $("adminPanel").classList.remove("hidden");
      $("adminWho").textContent = adminEmail;
      ["grpBoard", "grpNumbers", "grpScores", "grpPayments", "grpAudit"]
        .forEach(id => $(id).classList.add("hidden"));
      $("seasonForm").classList.remove("hidden");
      initGameCountSelect();
      renderCfgGames([]);
    }
    return;
  }
  $("brandSeason").textContent = (cfg.seasonName || "SQUARES").toUpperCase();
  $("welcomeBlurb").textContent = cfg.blurb || "";
  const power = isPowerAdmin(), pay = isPaymentAdmin();
  const admin = power || pay;
  // Admin tools stay tucked away until requested — the toggle lives at the bottom
  $("adminToolsBar").classList.toggle("hidden", !admin);
  $("adminPanel").classList.toggle("hidden", !(admin && adminToolsOpen));
  // Pot/financials are admin eyes only (both tiers), visible without opening tools
  $("potPanel").classList.toggle("hidden", !admin);
  if (adminEmail) $("adminLoginBtn").textContent = "Sign out";
  if (admin) {
    $("adminWho").textContent = adminEmail;
    $("adminRole").textContent = power ? "POWER ADMIN" : "PAYMENT ADMIN";
    $("adminRole").classList.toggle("pay", !power);
    // Payment admins: payments only. Power admins: everything.
    ["grpBoard", "grpNumbers", "grpScores", "grpSeason", "grpAudit"]
      .forEach(id => $(id).classList.toggle("hidden", !power));
    $("grpPayments").classList.remove("hidden");
    $("lockBtn").classList.toggle("hidden", !!cfg.boardLocked);
    $("unlockBtn").classList.toggle("hidden", !cfg.boardLocked);
    if (power && $("seasonForm").classList.contains("hidden")) fillSeasonForm();
    renderAdminGame();
    renderPayments();
    if (!unsubPay) {
      unsubPay = onSnapshot(collection(db, "payments"), (qs) => {
        payments.clear();
        qs.forEach(d => payments.set(d.id, d.data()));
        renderPayments(); renderPot(); renderMyPanel();
      });
    }
    if (!unsubProfiles) {
      unsubProfiles = onSnapshot(collection(db, "profiles"), (qs) => {
        profiles.clear();
        qs.forEach(d => profiles.set(d.id, d.data()));
        renderPayments();
      });
    }
  }
  renderBoard(); renderMyPanel(); renderPot(); renderVenmo();
}

/* ---------------- welcome / identity flow (email-first) ----------------
   1. Email only. If the browser still holds a verified session for it, they're
      in instantly — no link, no typing.
   2. Known email (profile exists) but no live session: auto-fill their name,
      send the sign-in link, skip the name step.
   3. Brand-new email: ask first/last name once, then send the link. */
let pendingEmail = "";
let adminToolsOpen = false;
$("adminToolsBtn").onclick = () => {
  adminToolsOpen = !adminToolsOpen;
  $("adminToolsBtn").textContent = adminToolsOpen ? "Hide admin tools" : "Show admin tools";
  $("adminPanel").classList.toggle("hidden", !adminToolsOpen);
  if (adminToolsOpen) $("adminPanel").scrollIntoView({ behavior: "smooth", block: "start" });
};

/* Keep the display name synced to the canonical profile (fixes stale or
   email-prefix names saved before the profile existed) */
async function refreshIdentityFromProfile() {
  if (!me.email) return;
  const prof = await fetchProfile(me.email);
  if (!prof) return;
  const name = ((prof.firstName || "") + " " + (prof.lastName || "")).trim();
  if (name && name !== me.fullName) {
    me.fullName = name;
    saveIdentity(); route();
  }
}
/* Tap your name in the top bar to fix a typo — updates the profile everywhere */
$("userChipName").onclick = async () => {
  if (!me.email) return;
  const prof = await fetchProfile(me.email) || {};
  const first = (prompt("First name:", prof.firstName || me.fullName.split(" ")[0] || "") || "").trim();
  if (!first) return;
  const last = (prompt("Last name:", prof.lastName || me.fullName.split(" ").slice(1).join(" ") || "") || "").trim();
  if (!last) return;
  try {
    await setDoc(doc(db, "profiles", payDocId(me.email)), {
      firstName: first, lastName: last, email: me.email, updatedAt: serverTimestamp()
    }, { merge: true });
    me.fullName = first + " " + last;
    saveIdentity(); route();
    audit("profile.update", `${me.email} → ${me.fullName}`);
    toast("Name updated to " + me.fullName + ".");
  } catch (err) { toast(friendlyErr(err)); }
};
async function fetchProfile(email) {
  try {
    const snap = await getDoc(doc(db, "profiles", payDocId(email)));
    return snap.exists() ? snap.data() : null;
  } catch (_) { return null; }
}
function profileName(p, email) {
  const n = (((p?.firstName || "") + " " + (p?.lastName || "")).trim());
  return n || email.split("@")[0]; // prefix only as a last resort; profile sync repairs it
}
$("continueBtn").onclick = async () => {
  const email = $("wEmail").value.trim().toLowerCase();
  if (!email || !email.includes("@")) { toast("Enter a valid email."); return; }
  pendingEmail = email;
  showLoading();
  const prof = await fetchProfile(email);
  if (prof) {
    // Known email — straight in, name auto-loaded
    me = { fullName: profileName(prof, email), email };
    saveIdentity(); route();
    renderBoard(); renderMyPanel(); renderWinnerBanner();
    refreshMyPayment();
    hideLoading();
    toast("Welcome back, " + me.fullName.split(" ")[0] + "!");
    return;
  }
  // Brand-new email → name + confirm-email step
  $("emailStep").classList.add("hidden");
  $("nameStep").classList.remove("hidden");
  setTimeout(() => $("wFirstName").focus(), 50);
  hideLoading();
};
/* New player joins: names + email typed a second time. Match → in. Mismatch →
   error and back to square one (typo protection without email round-trips). */
$("joinBtn").onclick = async () => {
  const first = $("wFirstName").value.trim();
  const last = $("wLastName").value.trim();
  const confirmEmail = $("wEmailConfirm").value.trim().toLowerCase();
  if (!first || !last) { toast("Enter your first and last name."); return; }
  if (!pendingEmail) { $("nameStep").classList.add("hidden"); $("emailStep").classList.remove("hidden"); return; }
  if (confirmEmail !== pendingEmail) {
    toast("Emails didn't match — let's try that again from the top.");
    $("wEmail").value = ""; $("wEmailConfirm").value = "";
    $("wFirstName").value = ""; $("wLastName").value = "";
    pendingEmail = "";
    $("nameStep").classList.add("hidden");
    $("emailStep").classList.remove("hidden");
    setTimeout(() => $("wEmail").focus(), 50);
    return;
  }
  showLoading();
  try {
    if (!auth.currentUser) await signInAnonymously(auth);
    me = { fullName: first + " " + last, email: pendingEmail };
    saveIdentity();
    await setDoc(doc(db, "profiles", payDocId(pendingEmail)), {
      firstName: first, lastName: last, email: pendingEmail,
      uid: auth.currentUser.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    }, { merge: true });
    audit("player.join", pendingEmail);
    route();
    renderBoard(); renderMyPanel(); renderWinnerBanner();
    refreshMyPayment();
    toast("Welcome to the board, " + first + "! 🤘");
  } catch (err) { toast(friendlyErr(err)); }
  hideLoading();
};
$("switchUserBtn").onclick = async () => {
  showLoading();
  localStorage.removeItem("fc_name"); localStorage.removeItem("fc_email");
  localStorage.removeItem("fc_pending");
  me = { fullName: "", email: "" };
  // keep the anonymous session — same device keeps edit rights on its claims
  route();
  renderBoard(); renderMyPanel(); renderWinnerBanner();
  hideLoading();
};

/* ---------------- admin sign in ---------------- */
$("adminLoginBtn").onclick = async () => {
  if (adminEmail) {
    await signOut(auth); adminEmail = null;
    location.reload();
    return;
  }
  const provider = new GoogleAuthProvider();
  try {
    const res = await signInWithPopup(auth, provider);
    adminEmail = res.user.email.toLowerCase();
    $("adminLoginBtn").textContent = "Sign out";
    onConfig();
    if (!isAdmin() && cfg) toast("Signed in, but " + adminEmail + " isn't on the admin list.");
    else toast("Admin mode on.");
  } catch (err) {
    // Mobile browsers often block popups — fall back to full-page redirect
    const code = err.code || "";
    if (code.includes("popup") || code.includes("operation-not-supported")) {
      await signInWithRedirect(auth, provider);
    } else {
      toast("Sign-in failed: " + err.message);
    }
  }
};
// Completes a redirect-based sign-in when the page comes back
getRedirectResult(auth).then(res => {
  if (res?.user?.email) {
    adminEmail = res.user.email.toLowerCase();
    onConfig();
    toast(isAdmin() ? "Admin mode on." : "Signed in, but " + adminEmail + " isn't on the admin list.");
  }
}).catch(() => {});

/* ---------------- game tabs ---------------- */
/* Sticky top-bar chip: selected game + score, visible from anywhere on the page */
function renderTopGameChip() {
  const box = $("topGameChip");
  const g = currentGame();
  box.innerHTML = "";
  if (!g) return;
  const label = (soccerMode() || mlbMode()) ? (g.opponent || g.id) : "TEX vs " + (g.opponent || "TBD");
  box.appendChild(el("span", "tgName", label));
  const score = el("span", "tgScore");
  if (liveState && liveState.gameId === g.id && (liveState.inProgress || liveState.done)) {
    score.textContent = `${liveState.texasScore}–${liveState.oppScore} `;
    if (liveState.done) score.append("F");
    else {
      const per = (soccerMode() ? "H" : mlbMode() ? "I" : "Q") + liveState.period;
      const live = el("span", "tgLive", "● ");
      score.append(live, per);
    }
  } else if (g.finalScore) {
    score.textContent = `${g.finalScore.t}–${g.finalScore.o} F`;
  } else {
    const d = new Date((g.date || "") + "T12:00:00");
    score.textContent = isNaN(d) ? "" : (d.getMonth() + 1) + "/" + d.getDate();
  }
  box.appendChild(score);
}

function renderTabs() {
  const nav = $("gameTabs");
  nav.innerHTML = "";
  games.forEach(g => {
    const b = el("button", "gameTab" + (g.id === activeGameId ? " active" : ""));
    b.type = "button";
    b.append(el("span", null, g.opponent || "TBD"));
    const d = new Date(g.date + "T12:00:00");
    b.append(el("span", "gDate", isNaN(d) ? "" : (d.getMonth() + 1) + "/" + d.getDate()));
    if (liveState && liveState.gameId === g.id && liveState.inProgress) b.classList.add("liveNow");
    b.onclick = () => { activeGameId = g.id; stopLivePoll(); renderTabs(); renderBoard(); renderWinners(); renderAdminGame(); maybeStartLivePoll(); };
    nav.appendChild(b);
  });
  renderTopGameChip();
}

/* ---------------- board render ---------------- */
function currentGame() { return games.find(g => g.id === activeGameId) || null; }

/* Per-period scores + winners pinned above the board, so "which period did I
   win?" (and double wins) is obvious at a glance */
function renderPeriodStrip(g) {
  const strip = $("periodStrip");
  strip.innerHTML = "";
  if (!g) return;
  let anyContent = false;
  for (let q = 1; q <= numPeriods(); q++) {
    const w = g.winners?.["q" + q];
    const chip = el("div", "perChip");
    chip.appendChild(el("span", "pcLabel", periodLabel(q)));
    if (w) {
      anyContent = true;
      chip.classList.add("hasWin");
      chip.appendChild(el("span", "pcScore", `${w.texasScore}–${w.oppScore}`));
      if (w.empty) {
        chip.appendChild(el("span", "pcWho empty", "→ tailgate"));
      } else {
        chip.appendChild(el("span", "pcWho", w.squareName));
        if (me.email && w.email === me.email) {
          chip.classList.add("myWin");
          chip.title = "You won this one!";
        }
      }
    } else if (liveState && liveState.gameId === g.id && liveState.inProgress && liveState.period === q) {
      // The period currently being played shows the live score
      anyContent = true;
      chip.appendChild(el("span", "pcScore", `${liveState.texasScore}–${liveState.oppScore}`));
      chip.appendChild(el("span", "pcWho empty", "live"));
    } else {
      chip.appendChild(el("span", "pcScore", "–"));
      chip.appendChild(el("span", "pcWho empty", ""));
    }
    strip.appendChild(chip);
  }
  // Informational FINAL chip: the true final score (OT/extra innings included).
  // For football this is display-only — Q4 above is what pays.
  if (!soccerMode() && g.finalScore) {
    anyContent = true;
    const fin = el("div", "perChip hasWin finalInfo");
    fin.appendChild(el("span", "pcLabel", "FINAL"));
    fin.appendChild(el("span", "pcScore", `${g.finalScore.t}–${g.finalScore.o}`));
    const wentLong = (g.finalScore.periods || 0) > numPeriods();
    fin.appendChild(el("span", "pcWho empty",
      mlbMode() ? "full game" : (wentLong ? "OT — Q4 pays" : "game over")));
    strip.appendChild(fin);
  }
  // Nothing recorded and nothing live? Hide the strip to keep pre-game clean.
  if (!anyContent) strip.innerHTML = "";
}

function renderBoard() {
  const g = currentGame();
  renderPeriodStrip(g);
  const board = $("board");
  board.innerHTML = "";
  // Column sizing: vertical axis bar, digit rail, then the 10 squares
  const cg = el("colgroup");
  const c1 = el("col"); c1.style.width = "30px"; cg.appendChild(c1);
  const c2 = el("col"); c2.style.width = "40px"; cg.appendChild(c2);
  for (let i = 0; i < GRID; i++) cg.appendChild(el("col"));
  board.appendChild(cg);
  $("boardTitle").textContent = g
    ? ((soccerMode() || mlbMode()) ? (g.opponent || "TBD") : "TEXAS vs " + (g.opponent || "TBD"))
    : "Board";
  $("boardStatus").textContent = cfg?.boardLocked ? "Board locked" : "Board open — tap a square";

  const cols = g?.texasDigits || null;   // TEXAS/home digits across the top
  const rows = g?.oppDigits || null;     // OPPONENT/away digits down the side
  const topName = (soccerMode() || mlbMode()) ? "HOME" : "TEXAS";
  const sideName = (soccerMode() || mlbMode()) ? "AWAY" : (g?.opponent || "OPPONENT");

  // Big top-axis team bar (burnt orange); corner block carries the badge
  const axisRow = el("tr");
  const axisCorner = el("th", "corner cornerLogo");
  axisCorner.colSpan = 2;
  axisCorner.rowSpan = 2; // spans down beside the digit rail too
  const cornerImg = document.createElement("img");
  cornerImg.src = "logo-dark.png";
  cornerImg.alt = "";
  axisCorner.appendChild(cornerImg);
  axisRow.appendChild(axisCorner);
  const axisTh = el("th", "axisTop");
  axisTh.colSpan = GRID;
  axisTh.appendChild(el("span", "axisBar", topName));
  axisRow.appendChild(axisTh);
  board.appendChild(axisRow);

  // Digit header row (top digits in orange) — corner already spanned above
  const head = el("tr");
  for (let c = 1; c <= GRID; c++) {
    const th = el("th", "digit colD" + (cols ? "" : " undrawn"), cols ? String(cols[c - 1]) : "?");
    th.dataset.axis = "col"; th.dataset.idx = c - 1;
    head.appendChild(th);
  }
  board.appendChild(head);

  const winKey = liveWinningKey();
  const recordedWins = winnerKeysForGame(g);

  for (let r = 1; r <= GRID; r++) {
    const tr = el("tr");
    if (r === 1) {
      // Vertical side-axis team bar (smoke), spans the whole grid
      const vAxis = el("th", "vAxis", sideName);
      vAxis.rowSpan = GRID;
      vAxis.title = sideName;
      tr.appendChild(vAxis);
    }
    const th = el("th", "digit rowD" + (rows ? "" : " undrawn"), rows ? String(rows[r - 1]) : "?");
    th.dataset.axis = "row"; th.dataset.idx = r - 1;
    tr.appendChild(th);
    for (let c = 1; c <= GRID; c++) {
      const key = r + "_" + c;
      const sq = squares.get(key);
      const td = el("td", "sq");
      td.dataset.key = key;
      if (sq) {
        td.classList.add("taken");
        td.textContent = sq.squareName;
        td.title = "Taken by " + sq.fullName;
        if (me.email && sq.email === me.email) td.classList.add("mine");
        if (highlightEmail && sq.email === highlightEmail) td.classList.add("payHL");
      } else {
        td.classList.add("open");
      }
      if (recordedWins.has(key)) td.classList.add("winner");
      if (winKey === key) td.classList.add("liveLead");
      td.tabIndex = 0;
      td.setAttribute("role", "button");
      td.setAttribute("aria-label", sq
        ? `Row ${r} column ${c}, claimed by ${sq.squareName}`
        : `Row ${r} column ${c}, open`);
      td.onclick = () => onSquareTap(r, c, sq);
      td.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSquareTap(r, c, sq); } };
      tr.appendChild(td);
    }
    board.appendChild(tr);
  }
}

/* ---------------- claiming ---------------- */
let modalCtx = null;
function onSquareTap(row, col, sq) {
  if (!me.email) { toast("Enter your name and email first."); route(); return; }
  if (!canAct() && !isAdmin()) {
    toast("One sec — still connecting. Try again in a moment.");
    return;
  }
  const locked = !!cfg?.boardLocked;
  const mine = sq && sq.email === me.email;
  const admin = isAdmin();

  if (sq && !mine && !admin) { toast("Taken by " + sq.fullName + "."); return; }
  if (locked && !admin) { toast("Board is locked for the season."); return; }

  modalCtx = { row, col, sq };
  $("modalTitle").textContent = sq ? "Edit square" : "Claim this square";
  $("modalSub").textContent = `Row ${row} · Column ${col}` + (sq && admin && !mine ? ` · owner: ${sq.fullName} (${sq.email})` : "");
  $("sqNameInput").value = sq ? sq.squareName : suggestName();
  $("modalHelp").textContent = sq ? "" : `This square is yours for all ${games.length || 6} games at ${money(cfg?.pricePerSquare)} — Venmo after claiming.`;
  $("modalSaveBtn").textContent = sq ? "Save" : "Claim";
  $("modalReleaseBtn").classList.toggle("hidden", !sq);
  $("modalOverlay").classList.add("show");
  setTimeout(() => $("sqNameInput").focus(), 50);
}
function suggestName() {
  if (!me.fullName || me.fullName.includes("@")) return "";
  const parts = me.fullName.split(/\s+/);
  return parts.length > 1 ? parts[0] + " " + parts[parts.length - 1][0] : me.fullName;
}
function closeModal() { $("modalOverlay").classList.remove("show"); modalCtx = null; }
$("modalCancelBtn").onclick = closeModal;
$("modalOverlay").onclick = (e) => { if (e.target === $("modalOverlay")) closeModal(); };
$("sqNameInput").onkeydown = (e) => {
  if (e.key === "Enter") $("modalSaveBtn").click();
  if (e.key === "Escape") closeModal();
};

$("modalSaveBtn").onclick = async () => {
  if (!modalCtx) return;
  const name = $("sqNameInput").value.trim();
  if (!name) { toast("Square name can't be empty."); return; }
  const { row, col, sq } = modalCtx;
  const key = row + "_" + col;
  try {
    if (sq) {
      await updateDoc(doc(db, "squares", key), { squareName: name });
      audit("square.rename", `R${row}C${col}: "${sq.squareName}" → "${name}" (owner ${sq.email})`);
      toast("Square updated.");
    } else {
      await setDoc(doc(db, "squares", key), {
        row, col, squareName: name,
        fullName: me.fullName, email: me.email,
        uid, claimedAt: serverTimestamp()
      });
      audit("square.claim", `R${row}C${col} claimed as "${name}"`);
      toast("Square claimed. Hook 'em. Don't forget to Venmo!");
    }
    closeModal();
  } catch (err) { toast(friendlyErr(err)); }
};

$("modalReleaseBtn").onclick = async () => {
  if (!modalCtx?.sq) return;
  const { row, col } = modalCtx;
  if (!confirm("Release this square? Anyone can claim it after.")) return;
  try {
    await deleteDoc(doc(db, "squares", row + "_" + col));
    audit("square.release", `R${row}C${col} "${modalCtx.sq.squareName}" (owner ${modalCtx.sq.email}) released`);
    toast("Square released.");
    closeModal();
  } catch (err) { toast(friendlyErr(err)); }
};

function friendlyErr(err) {
  if ((err.code || "").includes("permission-denied"))
    return cfg?.boardLocked ? "Board is locked — ask an admin." : "Not allowed — this square may belong to someone else.";
  return "Error: " + (err.message || err);
}

/* ---------------- my squares panel ---------------- */
function renderMyPanel() {
  const panel = $("myPanel");
  if (!me.email) { panel.classList.add("hidden"); return; }
  const mine = [...squares.entries()].filter(([, s]) => s.email === me.email);
  panel.classList.remove("hidden");
  const list = $("mySquaresList");
  list.innerHTML = "";
  if (!mine.length) {
    list.appendChild(el("div", "emptyNote", "No squares yet — tap an open square on the board."));
  } else {
    mine.sort((a, b) => a[1].row - b[1].row || a[1].col - b[1].col);
    mine.forEach(([key, s]) => {
      const rowEl = el("div", "mySqRow");
      rowEl.appendChild(el("b", null, s.squareName));
      rowEl.appendChild(el("span", "coord", `Row ${s.row} · Col ${s.col}`));
      list.appendChild(rowEl);
    });
  }
  const owed = mine.length * (cfg?.pricePerSquare || 0);
  const pay = payments.get(payDocId(me.email)) || myPayment;
  const received = Number(pay?.amountReceived || 0);
  const bal = $("myBalance");
  if (received >= owed && owed > 0) {
    bal.innerHTML = `${mine.length} square${mine.length === 1 ? "" : "s"} · ${money(owed)} — <span class="settled">PAID ✓</span>`;
  } else if (mine.length) {
    const due = owed - received;
    bal.innerHTML = `${mine.length} square${mine.length === 1 ? "" : "s"} · ` +
      (received > 0 ? `${money(received)} received · ` : "") +
      `<span class="due">${money(due)} due</span>`;
  } else bal.textContent = "";
}

/* Player's own payment record (readable per rules) — drives balance display
   and the Venmo prefill. Admin-logged payments reduce what the link asks for. */
let myPayment = null;
async function refreshMyPayment() {
  if (!me.email) { myPayment = null; return; }
  // Players read their received-amount from the public profile mirror
  // (admins write it there whenever they log a payment)
  const prof = await fetchProfile(me.email);
  myPayment = prof && prof.received !== undefined ? { amountReceived: prof.received } : null;
  renderMyPanel();
}

/* Tap a handle → open the Venmo app on a prefilled payment screen with the
   CURRENT BALANCE DUE (owed minus whatever the collectors have logged).
   If payments haven't been logged yet, it prefills the full amount — the
   collection team keeping the ledger current is what sharpens this. */
async function openVenmo(handle) {
  const mine = [...squares.values()].filter(s => s.email === me.email).length;
  const owed = mine * (cfg?.pricePerSquare || 0);
  let received = 0;
  try {
    const prof = await fetchProfile(me.email);
    received = Number(prof?.received || 0);
  } catch (_) { /* fall back to full owed */ }
  const balance = Math.max(0, owed - received);
  const note = encodeURIComponent(`${me.fullName || ""} — 4th and Cold Squares`.trim());
  const amountPart = balance > 0 ? `&amount=${balance}` : "";
  const deepLink = `venmo://paycharge?txn=pay&recipients=${encodeURIComponent(handle)}${amountPart}&note=${note}`;
  const webFallback = `https://venmo.com/u/${encodeURIComponent(handle)}`;
  // If the app opens, this page backgrounds and the fallback timer is cancelled
  const fallback = setTimeout(() => { window.location.href = webFallback; }, 1400);
  const onHide = () => {
    if (document.hidden) { clearTimeout(fallback); document.removeEventListener("visibilitychange", onHide); }
  };
  document.addEventListener("visibilitychange", onHide);
  window.location.href = deepLink;
}

function renderVenmo() {
  const box = $("venmoBox");
  box.innerHTML = "";
  (cfg?.venmo || []).forEach(v => {
    const line = el("div");
    const a = el("a", null, "@" + v.handle);
    a.href = "https://venmo.com/u/" + v.handle;
    a.onclick = (e) => { e.preventDefault(); openVenmo(v.handle); };
    line.appendChild(a);
    if (v.note) line.append(" — " + v.note);
    box.appendChild(line);
  });
  if (cfg?.venmo?.length) {
    box.appendChild(el("div", "finePrint",
      `Tap a handle to open Venmo with your amount and note pre-filled — or pay manually and include your name and "4th and Cold Squares" in the note.`));
  }
}

/* ---------------- winners ledger ---------------- */
function winnerKeysForGame(g) {
  const set = new Set();
  if (!g?.winners) return set;
  // Only claimed wins get the gold ring — an empty-square (tailgate) win
  // shouldn't crown whoever claims that cell later
  Object.values(g.winners).forEach(w => { if (w?.key && !w.empty) set.add(w.key); });
  return set;
}
const payoutId = (gameId, q) => `${gameId}_q${q}`;

async function markPayoutPaid(g, q, w) {
  if (!confirm(`Confirm ${money(cfg?.payoutPerWin)} sent to ${w.fullName} for ${g.opponent || g.id} ${periodLabel(q)}?`)) return;
  try {
    await setDoc(doc(db, "payouts", payoutId(g.id, q)), {
      gameId: g.id, period: q,
      email: w.email, fullName: w.fullName, squareName: w.squareName,
      amount: cfg?.payoutPerWin || 0,
      paid: true, paidBy: adminEmail, paidAt: serverTimestamp()
    });
    audit("payout.sent", `${g.opponent || g.id} ${periodLabel(q)} — ${money(cfg?.payoutPerWin)} to ${w.fullName} (${w.email})`);
    toast("Payout marked as sent.");
  } catch (err) { toast(friendlyErr(err)); }
}
async function undoPayout(g, q, w) {
  if (!confirm(`Undo payout confirmation for ${w.squareName} (${g.opponent || g.id} ${periodLabel(q)})?`)) return;
  try {
    await deleteDoc(doc(db, "payouts", payoutId(g.id, q)));
    audit("payout.undo", `${g.opponent || g.id} ${periodLabel(q)} — ${w.fullName} (${w.email})`);
    toast("Payout confirmation removed.");
  } catch (err) { toast(friendlyErr(err)); }
}
/* All unpaid winners across every game */
function unpaidWinners() {
  const out = [];
  games.forEach(g => {
    Object.entries(g.winners || {}).forEach(([qKey, w]) => {
      if (!w || w.empty) return;
      const q = Number(qKey.slice(1));
      if (!payouts.get(payoutId(g.id, q))?.paid) out.push({ g, q, w });
    });
  });
  return out;
}

function renderWinners() {
  const list = $("winnersList");
  list.innerHTML = "";
  const g = currentGame();
  if (!g) return;
  const qs = [];
  for (let i = 1; i <= numPeriods(); i++) qs.push("q" + i);
  let any = false;
  qs.forEach((q, idx) => {
    const w = g.winners?.[q];
    if (!w) return;
    any = true;
    const row = el("div", "winRow");
    row.appendChild(el("span", "winQ", periodLabel(idx + 1)));
    const mid = el("div");
    mid.appendChild(el("div", "winName", w.squareName + (w.fullName ? " · " + w.fullName : "")));
    mid.appendChild(el("div", "winScore", soccerMode()
      ? `${w.texasScore} — ${w.oppScore}`
      : `TEX ${w.texasScore} — ${g.opponent || "OPP"} ${w.oppScore}`));
    row.appendChild(mid);
    // Right column: amount + payout status / admin controls
    const payCol = el("div", "payCol");
    payCol.appendChild(el("span", "winPay", w.empty ? "→ tailgate" : money(cfg?.payoutPerWin)));
    // Power admins can delete a bad entry (manual or pulled) outright
    if (isPowerAdmin()) {
      const rm = el("button", "removeWinBtn", "✕ remove");
      rm.type = "button";
      rm.onclick = async () => {
        if (!confirm(`Remove the ${periodLabel(idx + 1)} winner entry (${w.squareName})? You can re-pull or re-enter it after.`)) return;
        const winners = { ...(g.winners || {}) };
        delete winners[q];
        try {
          await updateDoc(doc(db, "games", g.id), { winners });
          audit("winner.remove", `${g.opponent || g.id} ${periodLabel(idx + 1)} — removed "${w.squareName}" (${w.texasScore}–${w.oppScore})${w.manual ? " [was manual]" : ""}`);
          toast(periodLabel(idx + 1) + " winner removed.");
        } catch (err) { toast(friendlyErr(err)); }
      };
      payCol.appendChild(rm);
    }
    if (!w.empty) {
      const p = payouts.get(payoutId(g.id, idx + 1));
      if (p?.paid) {
        const badge = el("span", "payBadge sent", "PAID ✓");
        if (isAdmin()) {
          badge.title = "Tap to undo";
          badge.style.cursor = "pointer";
          badge.onclick = () => undoPayout(g, idx + 1, w);
        }
        payCol.appendChild(badge);
      } else if (isAdmin()) {
        const btn = el("button", "markPaidBtn", "Mark paid");
        btn.type = "button";
        btn.onclick = () => markPayoutPaid(g, idx + 1, w);
        payCol.appendChild(btn);
      } else {
        payCol.appendChild(el("span", "payBadge proc", "processing"));
      }
    }
    row.appendChild(payCol);
    list.appendChild(row);
  });
  if (!any) list.appendChild(el("div", "emptyNote", "No winners recorded yet for this game."));
}

/* Congratulations banner for signed-in winners, across all games */
function renderWinnerBanner() {
  const banner = $("winnerBanner");
  if (!me.email) { banner.classList.add("hidden"); return; }
  const wins = [];
  games.forEach(g => {
    Object.entries(g.winners || {}).forEach(([qKey, w]) => {
      if (!w || w.empty || w.email !== me.email) return;
      const q = Number(qKey.slice(1));
      wins.push({ g, q, w, payout: payouts.get(payoutId(g.id, q)) });
    });
  });
  if (!wins.length) { banner.classList.add("hidden"); return; }
  banner.classList.remove("hidden");
  banner.innerHTML = "";
  const firstName = (me.fullName || "").split(/\s+/)[0] || "champ";
  banner.appendChild(el("h2", "bannerHead", `🎉 Congratulations, ${firstName}!`));
  const total = wins.length * (cfg?.payoutPerWin || 0);
  banner.appendChild(el("p", "bannerSub",
    `${wins.length} win${wins.length === 1 ? "" : "s"} this season — ${money(total)} total.`));
  wins.forEach(({ g, q, payout }) => {
    const line = el("div", "bannerWin");
    line.appendChild(el("span", null, `${g.opponent || g.id} · ${periodLabel(q)} · ${money(cfg?.payoutPerWin)}`));
    line.appendChild(el("span", "payBadge " + (payout?.paid ? "sent" : "proc"),
      payout?.paid ? "PAYMENT SENT ✓" : "processing"));
    banner.appendChild(line);
  });
  if (wins.some(x => !x.payout?.paid)) {
    const handles = (cfg?.venmo || []).map(v => "@" + v.handle).join(", ");
    banner.appendChild(el("p", "bannerNote",
      `Your payout is processing${handles ? " — reach out to " + handles + " with any questions" : ""}.`));
  }
}

/* ---------------- pot tracker ---------------- */
function renderPot() {
  const box = $("potBars");
  box.innerHTML = "";
  if (!cfg) return;
  const sold = squares.size;
  const gross = sold * (cfg.pricePerSquare || 0);
  let winsPaid = 0;
  games.forEach(g => Object.values(g.winners || {}).forEach(w => { if (w && !w.empty) winsPaid++; }));
  const paidOut = winsPaid * (cfg.payoutPerWin || 0);
  const totalWins = games.length * numPeriods();
  const lines = [
    ["Squares sold", `${sold} / 100`],
    ["Gross pot", money(gross)],
    [`Payouts (${winsPaid} of ${totalWins} wins)`, money(paidOut)],
  ];
  lines.forEach(([k, v]) => {
    const line = el("div", "potLine");
    line.appendChild(el("span", null, k));
    line.appendChild(el("b", null, v));
    box.appendChild(line);
  });
  const tail = el("div", "potLine");
  tail.appendChild(el("span", null, "To the tailgate fund"));
  tail.appendChild(el("b", "potBig", money(gross - (totalWins * (cfg.payoutPerWin || 0)))));
  box.appendChild(tail);
}

/* ---------------- LIVE scores (ESPN) ---------------- */
function gameDateIsToday(g) {
  if (!g?.date) return false;
  const today = new Date();
  const [y, m, d] = g.date.split("-").map(Number);
  return today.getFullYear() === y && (today.getMonth() + 1) === m && today.getDate() === d;
}
function maybeStartLivePoll() {
  const g = currentGame();
  if (g && (gameDateIsToday(g) || liveState?.inProgress)) startLivePoll();
}
function startLivePoll() {
  stopLivePoll();
  pullLive();
  liveTimer = setInterval(pullLive, LIVE_POLL_MS);
}
function stopLivePoll() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null; liveState = null;
  $("scoreStrip").classList.add("hidden");
}
async function resolveEventId(g) {
  if (g.espnEventId) return g.espnEventId;
  try {
    if (soccerMode()) {
      // Look up the day's World Cup scoreboard, match by team names in the game label
      const res = await fetch(`${espnBase()}/scoreboard?dates=${(g.date || "").replace(/-/g, "")}`);
      const data = await res.json();
      const events = data.events || [];
      if (!events.length) return null;
      if (events.length === 1) return events[0].id;
      const tokens = (g.opponent || "").toLowerCase().split(/[^a-z]+/).filter(t => t.length > 2);
      let best = null, bestScore = -1;
      events.forEach(e => {
        const name = (e.name || "").toLowerCase();
        const score = tokens.filter(t => name.includes(t)).length;
        if (score > bestScore) { bestScore = score; best = e; }
      });
      return best ? best.id : null;
    }
    if (mlbMode()) {
      const res = await fetch(`${ESPN_ROOT}/baseball/mlb/teams/${MLB_TEAM_ID}/schedule`);
      const data = await res.json();
      const ev = (data.events || []).find(e => (e.date || "").slice(0, 10) === g.date);
      return ev ? ev.id : null;
    }
    const data = await fetchTexasSchedule();
    const ev = (data.events || []).find(e => (e.date || "").slice(0, 10) === g.date);
    return ev ? ev.id : null;
  } catch (_) { return null; }
}
function pickCompetitors(comp) {
  let texas, opp;
  if (soccerMode() || mlbMode()) {
    texas = comp.competitors.find(c => c.homeAway === "home");
    opp = comp.competitors.find(c => c.homeAway === "away");
  } else {
    texas = comp.competitors.find(c => c.id === TEXAS_TEAM_ID || c.team?.id === TEXAS_TEAM_ID);
    opp = comp.competitors.find(c => c !== texas);
  }
  return { texas, opp };
}
/* Rangers schedule, trimmed to a recent/upcoming window for the dropdowns */
async function fetchRangersWindow() {
  const DAY = 86400000;
  const lo = Date.now() - 12 * DAY, hi = Date.now() + 14 * DAY;
  try {
    const res = await fetch(`${ESPN_ROOT}/baseball/mlb/teams/${MLB_TEAM_ID}/schedule`);
    const data = await res.json();
    return (data.events || [])
      .filter(e => { const t = Date.parse(e.date); return t >= lo && t <= hi; })
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
      .map(e => ({
        opponent: e.shortName || e.name || "Game",
        date: (e.date || "").slice(0, 10),
        espnEventId: e.id
      }));
  } catch (_) { return []; }
}
/* Compute completed-period winners from an ESPN summary competition object.
   Shared by the manual Pull button and the live auto-recorder. */
function computePeriodWinners(g, comp) {
  const { texas, opp } = pickCompetitors(comp);
  if (!texas || !opp || !g.texasDigits || !g.oppDigits) return {};
  const tLines = (texas.linescores || []).map(l => Number(l.displayValue ?? l.value ?? 0));
  const oLines = (opp.linescores || []).map(l => Number(l.displayValue ?? l.value ?? 0));
  const state = comp.status?.type?.state;
  const detail = comp.status?.type?.detail || comp.status?.type?.shortDetail || "";
  const period = comp.status?.period || tLines.length;
  const nPer = numPeriods();
  let completed = Math.min(tLines.length, oLines.length);
  if (state === "in" && period <= completed) completed = period - 1;
  if (soccerMode() && state === "in" && /half\s*-?\s*time|^ht$/i.test(detail)) completed = 1;
  // Final: soccer/CFB record all periods; MLB records however many of the
  // first 4 innings the linescores show (they'll all be there for a final)
  if (state === "post") completed = mlbMode() ? Math.min(nPer, completed) : nPer;
  const out = {};
  let tSum = 0, oSum = 0;
  for (let q = 1; q <= Math.min(completed, nPer); q++) {
    if (soccerMode() && q === nPer && state === "post") {
      // Soccer final pays on the true final score — extra time counts
      tSum = Number(texas.score || 0); oSum = Number(opp.score || 0);
    } else if (soccerMode() && q === 1 && !tLines.length && /half\s*-?\s*time|^ht$/i.test(detail)) {
      tSum = Number(texas.score || 0); oSum = Number(opp.score || 0);
    } else {
      // Cumulative through this period's linescore.
      // CFB Q4 pays end-of-regulation (OT excluded); MLB pays innings 1–4.
      tSum += tLines[q - 1] || 0; oSum += oLines[q - 1] || 0;
    }
    const col = g.texasDigits.indexOf(digitsOf(tSum)) + 1;
    const row = g.oppDigits.indexOf(digitsOf(oSum)) + 1;
    const key = row + "_" + col;
    const sq = squares.get(key);
    out["q" + q] = {
      key,
      squareName: sq ? sq.squareName : "— empty —",
      fullName: sq ? sq.fullName : "",
      email: sq ? sq.email : "",
      empty: !sq,
      texasScore: tSum, oppScore: oSum
    };
  }
  return out;
}
/* Auto-record: while a power admin has the page open on game day, newly
   completed periods get written automatically — no button pushing. Everyone
   else sees them appear in real time via Firestore sync. */
/* Final game score (incl. OT/extra innings) for the informational FINAL chip */
function finalScoreOf(comp) {
  const { texas, opp } = pickCompetitors(comp);
  return {
    t: Number(texas?.score || 0),
    o: Number(opp?.score || 0),
    periods: Math.max((texas?.linescores || []).length, (opp?.linescores || []).length)
  };
}
async function autoRecordWinners(g, comp) {
  if (!isPowerAdmin()) return;
  const computed = computePeriodWinners(g, comp);
  const existing = g.winners || {};
  const newKeys = Object.keys(computed).filter(k => !existing[k]);
  const state = comp.status?.type?.state;
  const updates = {};
  if (newKeys.length) {
    const winners = { ...existing };
    newKeys.forEach(k => winners[k] = computed[k]);
    updates.winners = winners;
  }
  if (state === "post" && !g.finalScore) updates.finalScore = finalScoreOf(comp);
  if (!Object.keys(updates).length) return;
  try {
    await updateDoc(doc(db, "games", g.id), updates);
    if (newKeys.length) {
      const summary = newKeys.map(k => `${periodLabel(Number(k.slice(1)))}: ${updates.winners[k].squareName}`).join(" · ");
      audit("winner.auto", `${g.opponent || g.id} — ${summary}`);
      toast("Winner recorded — " + summary);
    }
  } catch (_) { /* another admin's device may have written it first — fine */ }
}
async function pullLive() {
  const g = currentGame();
  if (!g) return;
  const eventId = await resolveEventId(g);
  if (!eventId) return;
  try {
    const res = await fetch(`${espnBase()}/summary?event=${eventId}`);
    const data = await res.json();
    const comp = data?.header?.competitions?.[0];
    if (!comp) return;
    const { texas, opp } = pickCompetitors(comp);
    if (!texas || !opp) return;
    const status = comp.status || {};
    const state = status?.type?.state; // pre | in | post
    liveState = {
      gameId: g.id,
      inProgress: state === "in",
      done: state === "post",
      texasScore: Number(texas.score || 0),
      oppScore: Number(opp.score || 0),
      texasLines: (texas.linescores || []).map(l => Number(l.displayValue ?? l.value ?? 0)),
      oppLines: (opp.linescores || []).map(l => Number(l.displayValue ?? l.value ?? 0)),
      period: status?.period || 0,
      clock: status?.type?.shortDetail || status?.displayClock || "",
      texAbbrev: (soccerMode() || mlbMode())
        ? (texas.team?.abbreviation || "HOME")
        : "TEXAS",
      oppAbbrev: opp.team?.abbreviation || (g.opponent || "OPP").slice(0, 4).toUpperCase()
    };
    renderScoreStrip(g);
    renderTabs();
    renderBoard();
    if (!liveState.inProgress && !liveState.done) $("scoreStrip").classList.add("hidden");
    // Hands-free winner recording as each period completes
    if (liveState.inProgress || liveState.done) autoRecordWinners(g, comp);
  } catch (_) { /* network hiccup, next poll */ }
}
function renderScoreStrip(g) {
  if (!liveState || (!liveState.inProgress && !liveState.done)) return;
  $("scoreStrip").classList.remove("hidden");
  $("scoreTexas").textContent = liveState.texasScore;
  $("scoreOpp").textContent = liveState.oppScore;
  document.querySelector("#scoreStrip .scoreTeam .scoreLabel").textContent = liveState.texAbbrev;
  $("scoreOppLabel").textContent = liveState.oppAbbrev;
  const perLabel = soccerMode() ? "H" + liveState.period : (mlbMode() ? "INN " + liveState.period : "Q" + liveState.period);
  $("scoreQtr").textContent = liveState.done ? "FINAL" : perLabel;
  $("scoreClock").textContent = liveState.done ? "" : liveState.clock;
}
/* which square is currently "leading" (would win if the period ended now) */
function liveWinningKey() {
  const g = currentGame();
  if (!g || !liveState || liveState.gameId !== g.id) return null;
  if (!liveState.inProgress) return null;
  // CFB only: OT doesn't count — Q4 result locked at end of regulation.
  // Soccer: extra time DOES count toward the final, so keep pulsing.
  if (!soccerMode() && liveState.period > 4) return null;
  if (!g.texasDigits || !g.oppDigits) return null;
  const tCol = g.texasDigits.indexOf(digitsOf(liveState.texasScore)) + 1;
  const oRow = g.oppDigits.indexOf(digitsOf(liveState.oppScore)) + 1;
  if (tCol < 1 || oRow < 1) return null;
  return oRow + "_" + tCol;
}

/* ---------------- ADMIN: lock / draw / scores ---------------- */
$("lockBtn").onclick = () => setLock(true);
$("unlockBtn").onclick = () => setLock(false);
async function setLock(v) {
  try {
    await updateDoc(doc(db, "config", "current"), { boardLocked: v });
    audit(v ? "board.lock" : "board.unlock", "");
    toast(v ? "Board locked." : "Board unlocked.");
  } catch (err) { toast(friendlyErr(err)); }
}

function renderAdminGame() {
  if (!isPowerAdmin()) return;
  const g = currentGame();
  $("drawGameName").textContent = g ? (g.opponent || g.id) : "—";
  const locked = !!g?.numbersLocked;
  const drawn = !!g?.texasDigits;
  $("drawBtn").classList.toggle("hidden", drawn || locked);
  $("redrawBtn").classList.toggle("hidden", !drawn || locked);
  $("manualNumbersBox").classList.toggle("hidden", locked);
  $("lockNumbersBtn").classList.toggle("hidden", !drawn || locked);
  $("unlockNumbersBtn").classList.toggle("hidden", !locked);
  $("espnIdInput").value = g?.espnEventId || "";
  // Manual winner period options
  const sel = $("manualPeriod");
  sel.innerHTML = "";
  for (let q = 1; q <= numPeriods(); q++) {
    const o = el("option", null, periodLabel(q));
    o.value = q;
    sel.appendChild(o);
  }
}

function shuffledDigits() {
  const a = [0,1,2,3,4,5,6,7,8,9];
  // crypto-backed Fisher-Yates so nobody can accuse the commissioner of rigging it
  const rnd = new Uint32Array(9);
  crypto.getRandomValues(rnd);
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd[i - 1] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
$("drawBtn").onclick = () => drawNumbers(false);
$("redrawBtn").onclick = () => { if (confirm("Re-draw numbers for this game?")) drawNumbers(true); };
async function drawNumbers(force) {
  const g = currentGame();
  if (!g) return;
  if (g.numbersLocked) { toast("Numbers are locked for this game — unlock first."); return; }
  if (g.texasDigits && !force) return;
  const tex = shuffledDigits(), opp = shuffledDigits();
  await animateDraw(tex, opp);
  try {
    await updateDoc(doc(db, "games", g.id), { texasDigits: tex, oppDigits: opp, drawnAt: serverTimestamp() });
    audit("numbers.draw", `${g.opponent || g.id}: top [${tex.join(" ")}] side [${opp.join(" ")}]${force ? " (RE-DRAW)" : ""}`);
    toast("Numbers drawn for " + (g.opponent || g.id) + "!");
  } catch (err) { toast(friendlyErr(err)); }
}

/* Manual number entry — same validation, no animation */
function parseDigitList(str) {
  const digits = (str.match(/\d/g) || []).map(Number);
  if (digits.length !== 10) return null;
  if ([...Array(10).keys()].some(d => !digits.includes(d))) return null; // must be 0–9 exactly once
  return digits;
}
$("saveManualNumbersBtn").onclick = async () => {
  const g = currentGame();
  if (!g) return;
  if (g.numbersLocked) { toast("Numbers are locked — unlock first."); return; }
  const tex = parseDigitList($("manualTopDigits").value);
  const opp = parseDigitList($("manualSideDigits").value);
  if (!tex || !opp) { toast("Each axis needs the digits 0–9 exactly once, in your chosen order."); return; }
  try {
    await updateDoc(doc(db, "games", g.id), { texasDigits: tex, oppDigits: opp, drawnAt: serverTimestamp() });
    audit("numbers.manual", `${g.opponent || g.id}: top [${tex.join(" ")}] side [${opp.join(" ")}] entered manually`);
    toast("Manual numbers saved.");
    $("manualTopDigits").value = ""; $("manualSideDigits").value = "";
  } catch (err) { toast(friendlyErr(err)); }
};

$("lockNumbersBtn").onclick = () => setNumbersLock(true);
$("unlockNumbersBtn").onclick = () => {
  if (confirm("Unlock numbers for this game? Only do this to fix a mistake.")) setNumbersLock(false);
};
async function setNumbersLock(v) {
  const g = currentGame();
  if (!g) return;
  try {
    await updateDoc(doc(db, "games", g.id), { numbersLocked: v });
    audit(v ? "numbers.lock" : "numbers.unlock", g.opponent || g.id);
    toast(v ? "Numbers locked." : "Numbers unlocked.");
  } catch (err) { toast(friendlyErr(err)); }
}
function animateDraw(tex, opp) {
  return new Promise(resolve => {
    const colTh = [...document.querySelectorAll('th.digit[data-axis="col"]')];
    const rowTh = [...document.querySelectorAll('th.digit[data-axis="row"]')];
    const all = [...colTh, ...rowTh];
    all.forEach(th => th.classList.add("rolling"));
    let ticks = 0;
    const spin = setInterval(() => {
      ticks++;
      all.forEach(th => th.textContent = Math.floor(Math.random() * 10));
      if (ticks > 18) {
        clearInterval(spin);
        colTh.forEach((th, i) => { th.textContent = tex[i]; th.classList.remove("rolling", "undrawn"); });
        rowTh.forEach((th, i) => { th.textContent = opp[i]; th.classList.remove("rolling", "undrawn"); });
        resolve();
      }
    }, 90);
  });
}

$("saveEspnIdBtn").onclick = async () => {
  const g = currentGame(); if (!g) return;
  try {
    await updateDoc(doc(db, "games", g.id), { espnEventId: $("espnIdInput").value.trim() });
    audit("game.espnId", `${g.opponent || g.id} → ${$("espnIdInput").value.trim()}`);
    toast("ESPN ID saved.");
  } catch (err) { toast(friendlyErr(err)); }
};

/* One-tap announcement: builds a paste-ready update for the group text/email */
$("copyAnnounceBtn").onclick = async () => {
  const g = currentGame(); if (!g) return;
  const lines = [`🏈 ${(cfg?.seasonName || "Squares").toUpperCase()} — ${g.opponent || g.id}`];
  let any = false;
  for (let q = 1; q <= numPeriods(); q++) {
    const w = g.winners?.["q" + q];
    if (!w) continue;
    any = true;
    lines.push(`${periodLabel(q)}: ${w.squareName}${w.fullName ? " (" + w.fullName + ")" : ""} — ${w.texasScore}-${w.oppScore}${w.empty ? " → tailgate fund" : " wins " + money(cfg?.payoutPerWin)}`);
  }
  if (!any) { toast("No winners recorded for this game yet."); return; }
  if (!soccerMode() && g.finalScore) {
    const wentLong = (g.finalScore.periods || 0) > numPeriods();
    lines.push(`FINAL: ${g.finalScore.t}-${g.finalScore.o}${wentLong && !mlbMode() ? " (OT — Q4 score pays)" : ""}`);
  }
  lines.push("", "Board: " + location.href.split("#")[0].split("?")[0]);
  const text = lines.join("\n");
  // Phones: open the native share sheet (Messages, Mail, Facebook, etc.)
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (_) { /* cancelled — fall through to copy */ }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("Announcement copied — paste it into the group text, email, or Facebook group.");
  } catch (_) {
    prompt("Copy this announcement:", text);
  }
};

/* Manual winner entry — backup when ESPN is down or wrong */
$("manualWinnerBtn").onclick = async () => {
  const g = currentGame(); if (!g) return;
  if (!g.texasDigits || !g.oppDigits) { toast("Draw or enter numbers first."); return; }
  const q = Number($("manualPeriod").value);
  const tScore = $("manualTexScore").value, oScore = $("manualOppScore").value;
  if (tScore === "" || oScore === "") { toast("Enter both scores."); return; }
  const tSum = Number(tScore), oSum = Number(oScore);
  const col = g.texasDigits.indexOf(digitsOf(tSum)) + 1;
  const row = g.oppDigits.indexOf(digitsOf(oSum)) + 1;
  const key = row + "_" + col;
  const sq = squares.get(key);
  const winners = { ...(g.winners || {}) };
  winners["q" + q] = {
    key,
    squareName: sq ? sq.squareName : "— empty —",
    fullName: sq ? sq.fullName : "",
    email: sq ? sq.email : "",
    empty: !sq,
    texasScore: tSum, oppScore: oSum,
    manual: true
  };
  try {
    await updateDoc(doc(db, "games", g.id), { winners });
    audit("winner.manual", `${g.opponent || g.id} ${periodLabel(q)}: ${winners["q" + q].squareName} (${tSum}–${oSum}) entered manually`);
    toast(`${periodLabel(q)} winner recorded: ${winners["q" + q].squareName}`);
    $("manualTexScore").value = ""; $("manualOppScore").value = "";
  } catch (err) { toast(friendlyErr(err)); }
};
$("findEspnIdBtn").onclick = async () => {
  const g = currentGame(); if (!g) return;
  const id = await resolveEventId({ ...g, espnEventId: "" });
  if (id) { $("espnIdInput").value = id; toast("Found ESPN game " + id + " — hit Save."); }
  else toast("Couldn't match by date. Find the game ID in the espn.com URL.");
};

$("pullScoresBtn").onclick = async () => {
  const g = currentGame(); if (!g) return;
  if (!g.texasDigits) { toast("Draw numbers first."); return; }
  const eventId = await resolveEventId(g);
  if (!eventId) { toast("No ESPN game ID — set one above."); return; }
  $("pullResult").textContent = "Pulling…";
  try {
    const res = await fetch(`${espnBase()}/summary?event=${eventId}`);
    if (!res.ok) {
      $("pullResult").textContent = `ESPN returned HTTP ${res.status} for game ID ${eventId} — that ID may be from a different sport mode. Clear it and tap Auto-find.`;
      return;
    }
    const data = await res.json();
    const comp = data?.header?.competitions?.[0];
    if (!comp || !comp.competitors) {
      $("pullResult").textContent = `ESPN sent no game data for ID ${eventId} — likely a wrong or stale game ID (e.g. saved under a different sport mode). Clear the ESPN game ID field and tap Auto-find.`;
      return;
    }
    const computed = computePeriodWinners(g, comp);
    if (!Object.keys(computed).length) {
      const st = comp.status?.type?.state;
      $("pullResult").textContent = st === "pre"
        ? "ESPN shows this game hasn't started yet."
        : "ESPN responded but no completed periods were found — if this game is over, the game ID may be wrong. Clear it and tap Auto-find.";
      return;
    }
    const winners = { ...(g.winners || {}) };
    const recorded = [];
    Object.keys(computed).forEach(k => {
      // Re-pulling refreshes ESPN-derived entries but never overwrites a
      // manually entered correction
      if (winners[k]?.manual) return;
      winners[k] = computed[k];
      recorded.push(`${periodLabel(Number(k.slice(1)))}: ${computed[k].squareName} (${computed[k].texasScore}–${computed[k].oppScore})`);
    });
    const state = comp.status?.type?.state;
    const gameUpdates = { winners, espnEventId: eventId };
    if (state === "post") gameUpdates.finalScore = finalScoreOf(comp);
    await updateDoc(doc(db, "games", g.id), gameUpdates);
    if (recorded.length) audit("winner.espnPull", `${g.opponent || g.id}: ${recorded.join(" · ")}`);
    $("pullResult").textContent = recorded.length
      ? "Recorded → " + recorded.join(" · ")
      : "No completed periods yet.";
    toast("Winners updated.");
  } catch (err) {
    $("pullResult").textContent = "Pull failed: " + (err.message || err);
  }
};

/* ---------------- ADMIN: payments ---------------- */
const payDocId = (email) => email.replace(/[.#$/\[\]]/g, ",");
function paymentRollup() {
  // aggregate squares by email; display the canonical profile name when we
  // have one (per-claim names can drift if someone re-enters differently)
  const byEmail = new Map();
  squares.forEach(s => {
    const k = s.email;
    if (!byEmail.has(k)) {
      const prof = profiles.get(payDocId(k));
      const profName = prof ? ((prof.firstName || "") + " " + (prof.lastName || "")).trim() : "";
      byEmail.set(k, { fullName: profName || s.fullName, email: k, count: 0 });
    }
    byEmail.get(k).count++;
  });
  return [...byEmail.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}
let payRenderDeferred = false;
$("payTableWrap").addEventListener("focusout", () => {
  // wait a tick so focus can settle on the next field (tabbing between inputs)
  setTimeout(() => {
    if (payRenderDeferred && !$("payTableWrap").contains(document.activeElement)) {
      payRenderDeferred = false;
      renderPayments();
    }
  }, 120);
});
function renderPayments() {
  if (!isAdmin()) return;
  const wrap = $("payTableWrap");
  // Don't yank the cursor: if an amount field is being edited, wait until
  // focus leaves the table, then refresh once.
  if (wrap.contains(document.activeElement) &&
      (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "SELECT")) {
    payRenderDeferred = true;
    return;
  }
  const rows = paymentRollup();
  const price = cfg?.pricePerSquare || 0;
  const table = el("table"); table.id = "payTable";
  const thead = el("tr");
  ["Name", "Email", "Sq", "Owed", "Received", "Paid to", "Status"].forEach(h => thead.appendChild(el("th", null, h)));
  table.appendChild(thead);
  const collectors = (cfg?.venmo || []).map(v => v.handle);
  rows.forEach(r => {
    const pay = payments.get(payDocId(r.email)) || {};
    const owed = r.count * price;
    const tr = el("tr");
    if (highlightEmail === r.email) tr.classList.add("hlRow");
    const nameTd = el("td", null, r.fullName);
    tr.appendChild(nameTd);
    const emailTd = el("td", "emailCell", r.email);
    tr.appendChild(emailTd);
    tr.appendChild(el("td", null, String(r.count)));
    tr.appendChild(el("td", null, money(owed)));
    const recTd = el("td");
    const inp = el("input"); inp.type = "number"; inp.inputMode = "numeric";
    inp.value = pay.amountReceived ?? "";
    inp.placeholder = "0";
    recTd.appendChild(inp); tr.appendChild(recTd);
    const toTd = el("td");
    const sel = el("select");
    sel.appendChild(el("option", null, "—"));
    collectors.forEach(c => {
      const o = el("option", null, c);
      if (pay.paidTo === c) o.selected = true;
      sel.appendChild(o);
    });
    toTd.appendChild(sel); tr.appendChild(toTd);
    const received = Number(pay.amountReceived || 0);
    const settled = received >= owed && owed > 0;
    tr.appendChild(el("td", settled ? "settledYes" : "settledNo", settled ? "Settled" : money(owed - received) + " due"));
    // Tap the NAME or EMAIL cell to light up this person's squares —
    // deliberately not the whole row, so editing the amount never triggers it
    const toggleHL = () => {
      if (highlightEmail === r.email) {
        highlightEmail = null;
        toast("Highlight cleared.");
      } else {
        highlightEmail = r.email;
        toast(`Highlighting ${r.fullName}'s ${r.count} square${r.count === 1 ? "" : "s"} in blue — tap the name again to clear.`);
        $("boardSection").scrollIntoView({ behavior: "smooth", block: "start" });
      }
      renderBoard(); renderPayments();
    };
    nameTd.classList.add("hlToggle");
    nameTd.title = "Tap to highlight their squares on the board";
    nameTd.onclick = toggleHL;
    emailTd.classList.add("hlToggle");
    emailTd.title = "Tap to highlight their squares on the board";
    emailTd.onclick = toggleHL;
    const save = async () => {
      try {
        await setDoc(doc(db, "payments", payDocId(r.email)), {
          fullName: r.fullName, email: r.email,
          amountReceived: Number(inp.value || 0),
          paidTo: sel.value === "—" ? "" : sel.value,
          updatedAt: serverTimestamp()
        }, { merge: true });
        // Mirror onto the profile so the player's own balance display and
        // Venmo prefill can see it (payments collection stays admin-only)
        setDoc(doc(db, "profiles", payDocId(r.email)), {
          email: r.email, received: Number(inp.value || 0), updatedAt: serverTimestamp()
        }, { merge: true }).catch(() => {});
        audit("payment.update", `${r.fullName} (${r.email}): $${Number(inp.value || 0)} via ${sel.value === "—" ? "unset" : sel.value} — owed $${owed}`);
      } catch (err) { toast(friendlyErr(err)); }
    };
    inp.onchange = save; sel.onchange = save;
    table.appendChild(tr);
  });
  wrap.innerHTML = "";
  if (!rows.length) wrap.appendChild(el("div", "emptyNote", "No squares claimed yet."));
  else wrap.appendChild(table);
  renderPayoutsList();
}

/* One screen, every game: outstanding + confirmed winner payouts */
function renderPayoutsList() {
  if (!isAdmin()) return;
  const list = $("payoutsList");
  const badge = $("unpaidBadge");
  list.innerHTML = "";
  const all = [];
  let tailgateWins = 0;
  games.forEach(g => {
    Object.entries(g.winners || {}).forEach(([qKey, w]) => {
      if (!w) return;
      if (w.empty) { tailgateWins++; return; }
      const q = Number(qKey.slice(1));
      all.push({ g, q, w, payout: payouts.get(payoutId(g.id, q)) });
    });
  });
  const unpaid = all.filter(x => !x.payout?.paid);
  badge.classList.remove("hidden");
  if (!all.length) {
    badge.classList.add("hidden");
    list.appendChild(el("div", "emptyNote", tailgateWins
      ? `${tailgateWins} winner${tailgateWins === 1 ? "" : "s"} recorded — all on unclaimed squares (→ tailgate fund). Nothing to pay out.`
      : "No winners recorded yet."));
    return;
  }
  badge.textContent = unpaid.length ? `${unpaid.length} UNPAID` : "ALL PAID ✓";
  badge.classList.toggle("allPaid", !unpaid.length);
  // Unpaid first, then paid — grouped so the to-do list is on top
  [...unpaid, ...all.filter(x => x.payout?.paid)].forEach(({ g, q, w, payout }) => {
    const row = el("div", "poRow");
    const left = el("div");
    left.appendChild(el("div", "poGame", `${g.opponent || g.id} · ${periodLabel(q)} — ${w.fullName || w.squareName}`));
    left.appendChild(el("div", "poMeta",
      `${w.squareName} · ${w.email} · ${money(cfg?.payoutPerWin)}${payout?.paid && payout.paidBy ? " · confirmed by " + payout.paidBy : ""}`));
    row.appendChild(left);
    const right = el("div");
    if (payout?.paid) {
      const b = el("span", "payBadge sent", "PAID ✓");
      b.title = "Tap to undo"; b.style.cursor = "pointer";
      b.onclick = () => undoPayout(g, q, w);
      right.appendChild(b);
    } else {
      const btn = el("button", "markPaidBtn", "Mark paid");
      btn.type = "button";
      btn.onclick = () => markPayoutPaid(g, q, w);
      right.appendChild(btn);
    }
    row.appendChild(right);
    list.appendChild(row);
  });
}

/* ---------------- ADMIN: season setup ---------------- */
$("seasonToggleBtn").onclick = () => {
  const f = $("seasonForm");
  if (f.classList.contains("hidden")) fillSeasonForm(); // fresh values on open, never while editing
  f.classList.toggle("hidden");
};
$("cfgSport").onchange = () => {
  toast("Sport changed — re-tap 'Fetch schedule from ESPN' so games and their ESPN IDs match this sport, then Save season.");
};

let espnHomeGames = []; // fetched ESPN home schedule, powers the per-row dropdowns

function initGameCountSelect() {
  const sel = $("cfgGameCount");
  if (sel.options.length) return;
  for (let n = 1; n <= 12; n++) {
    const o = el("option", null, String(n));
    o.value = n;
    sel.appendChild(o);
  }
  sel.value = "6";
  sel.onchange = () => renderCfgGames(currentCfgRows());
}
/* Read whatever's currently typed in the rows so changing count doesn't wipe entries */
function currentCfgRows() {
  return [...$("cfgGames").querySelectorAll(".cfgGameRow")].map(row => {
    const [opp, date] = row.querySelectorAll("input");
    return { opponent: opp.value, date: date.value, espnEventId: row.dataset.espnId || "" };
  });
}

function fillSeasonForm() {
  if (!cfg) return;
  initGameCountSelect();
  $("cfgSport").value = cfg.sportMode || "cfb";
  $("cfgSeasonName").value = cfg.seasonName || "";
  $("cfgPrice").value = cfg.pricePerSquare ?? 250;
  $("cfgPayout").value = cfg.payoutPerWin ?? 500;
  $("cfgAdmins").value = (cfg.adminEmails || []).join(", ");
  $("cfgPayAdmins").value = (cfg.paymentAdminEmails || []).join(", ");
  $("cfgVenmo").value = (cfg.venmo || []).map(v => v.handle + " | " + (v.note || "")).join("\n");
  $("cfgBlurb").value = cfg.blurb || "";
  $("cfgGameCount").value = String(games.length || cfg.gameCount || 6);
  renderCfgGames(games);
}
function renderCfgGames(list) {
  initGameCountSelect();
  const count = Number($("cfgGameCount").value || 6);
  const box = $("cfgGames");
  box.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const g = list[i] || {};
    const row = el("div", "cfgGameRow");
    if (g.espnEventId) row.dataset.espnId = g.espnEventId;
    const opp = el("input"); opp.type = "text"; opp.placeholder = "Opponent " + (i + 1); opp.value = g.opponent || "";
    const date = el("input"); date.type = "text"; date.placeholder = "YYYY-MM-DD"; date.value = g.date || "";
    // If the ESPN schedule has been fetched, offer a dropdown so games can be
    // hand-picked (skip the opener, keep the finale, etc.)
    if (espnHomeGames.length) {
      const pick = el("select");
      pick.appendChild(el("option", null, "— pick from ESPN schedule —"));
      espnHomeGames.forEach((h, hi) => {
        const o = el("option", null, `${h.opponent} (${h.date})`);
        o.value = hi;
        if (g.espnEventId && g.espnEventId === h.espnEventId) o.selected = true;
        pick.appendChild(o);
      });
      pick.onchange = () => {
        const h = espnHomeGames[Number(pick.value)];
        if (!h) return;
        opp.value = h.opponent;
        date.value = h.date;
        row.dataset.espnId = h.espnEventId;
      };
      const pickWrap = el("div", "cfgPickRow");
      pickWrap.appendChild(pick);
      box.appendChild(pickWrap);
    }
    row.appendChild(opp); row.appendChild(date);
    box.appendChild(row);
  }
}
$("fetchScheduleBtn").onclick = async () => {
  const count = Number($("cfgGameCount").value || 6);
  if ($("cfgSport").value === "mlb") {
    toast("Fetching Rangers schedule from ESPN…");
    try {
      espnHomeGames = await fetchRangersWindow();
      if (!espnHomeGames.length) {
        toast("ESPN returned no Rangers games in the last 12 / next 14 days — enter matchups and dates manually.");
        return;
      }
      renderCfgGames(espnHomeGames.slice(-count));
      toast(`Loaded ${espnHomeGames.length} Rangers games — pre-filled the latest ${Math.min(count, espnHomeGames.length)}. Use the dropdowns to swap, then Save season.`);
    } catch (err) { toast("Rangers fetch failed: " + err.message); }
    return;
  }
  if ($("cfgSport").value === "soccer") {
    toast("Fetching World Cup matches from ESPN…");
    try {
      espnHomeGames = await fetchWorldCupMatches();
      if (!espnHomeGames.length) {
        toast("ESPN returned no World Cup matches in the last 12 / next 14 days — enter matchups and dates manually.");
        return;
      }
      // Pre-fill the most recent + upcoming N; dropdowns let you swap any slot
      renderCfgGames(espnHomeGames.slice(-count));
      toast(`Loaded ${espnHomeGames.length} World Cup matches — pre-filled the latest ${Math.min(count, espnHomeGames.length)}. Use the dropdowns to swap, then Save season.`);
    } catch (err) { toast("World Cup fetch failed: " + err.message); }
    return;
  }
  try {
    const data = await fetchTexasSchedule();
    if (!(data.events || []).length) {
      toast(data.error
        ? "ESPN request failed (" + data.error + ") — the browser may be blocking it. Enter games manually, or try again on Wi-Fi/another browser."
        : `ESPN returned an empty ${seasonYear()} Texas schedule — enter opponents and dates manually for now.`);
      return;
    }
    espnHomeGames = (data.events || []).filter(e => {
      const c = e.competitions?.[0];
      const home = c?.competitors?.find(x => x.homeAway === "home");
      return home && (home.id === TEXAS_TEAM_ID || home.team?.id === TEXAS_TEAM_ID);
    }).map(e => {
      const c = e.competitions[0];
      const away = c.competitors.find(x => x.homeAway === "away");
      return { opponent: away?.team?.shortDisplayName || away?.team?.abbreviation || "TBD", date: (e.date || "").slice(0, 10), espnEventId: e.id };
    });
    if (!espnHomeGames.length) { toast("No home games found in ESPN schedule yet."); return; }
    // Pre-fill with the LAST N home games; use the dropdowns to swap any of them
    renderCfgGames(espnHomeGames.slice(-count));
    toast(`Loaded ${espnHomeGames.length} home games — pre-filled the last ${Math.min(count, espnHomeGames.length)}. Use the dropdowns to swap games, then Save season.`);
  } catch (err) { toast("Schedule fetch failed: " + err.message); }
};

$("saveSeasonBtn").onclick = async () => {
  const adminList = $("cfgAdmins").value.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (adminEmail && !adminList.includes(adminEmail)) adminList.push(adminEmail); // don't lock yourself out
  const payAdminList = $("cfgPayAdmins").value.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const venmo = $("cfgVenmo").value.split("\n").map(l => {
    const [handle, note] = l.split("|").map(s => (s || "").trim());
    return handle ? { handle: handle.replace(/^@/, ""), note: note || "" } : null;
  }).filter(Boolean);
  const gameCount = Number($("cfgGameCount").value || 6);
  const chosenSport = $("cfgSport").value;
  const cfgData = {
    sportMode: ["soccer", "mlb"].includes(chosenSport) ? chosenSport : "cfb",
    seasonName: $("cfgSeasonName").value.trim() || "Squares",
    pricePerSquare: Number($("cfgPrice").value || 0),
    payoutPerWin: Number($("cfgPayout").value || 0),
    adminEmails: adminList,
    paymentAdminEmails: payAdminList,
    gameCount,
    venmo,
    blurb: $("cfgBlurb").value,
    boardLocked: cfg?.boardLocked || false
  };
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, "config", "current"), cfgData, { merge: true });
    const rows = [...$("cfgGames").querySelectorAll(".cfgGameRow")];
    rows.forEach((row, i) => {
      const [opp, date] = row.querySelectorAll("input");
      if (!opp.value.trim()) return;
      const gid = "game" + (i + 1);
      const existing = games.find(g => g.id === gid) || {};
      batch.set(doc(db, "games", gid), {
        order: i + 1,
        opponent: opp.value.trim(),
        date: date.value.trim(),
        espnEventId: row.dataset.espnId || existing.espnEventId || "",
        texasDigits: existing.texasDigits || null,
        oppDigits: existing.oppDigits || null,
        numbersLocked: existing.numbersLocked || false,
        winners: existing.winners || {}
      }, { merge: true });
    });
    // Shrinking the season? Remove game docs beyond the new count.
    games.filter(g => (g.order || 0) > gameCount).forEach(g => batch.delete(doc(db, "games", g.id)));
    await batch.commit();
    audit("season.save", `${cfgData.seasonName} · ${cfgData.sportMode} · ${gameCount} games · $${cfgData.pricePerSquare}/sq · $${cfgData.payoutPerWin}/win · power[${adminList.join(", ")}] payment[${payAdminList.join(", ")}]`);
    toast("Season saved.");
  } catch (err) { toast(friendlyErr(err)); }
};

/* ---------------- ADMIN: season archive & restore ----------------
   Archive = one JSON with everything: config, squares, games (numbers,
   winners, finals), payments in, payouts out, profiles, and the audit log.
   Clearing a season always downloads one first. Restore writes it all back. */
function tsFileStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
async function buildSeasonArchive() {
  const dump = (m) => { const o = {}; m.forEach((v, k) => o[k] = v); return o; };
  const gamesObj = {};
  games.forEach(g => { const { id, ...rest } = g; gamesObj[id] = rest; });
  // Audit is fetched fresh (it's not held in memory)
  const auditRows = [];
  try {
    let cursor = null;
    while (auditRows.length < 10000) {
      const qy = cursor
        ? query(collection(db, "audit"), orderBy("ts", "desc"), startAfter(cursor), limit(500))
        : query(collection(db, "audit"), orderBy("ts", "desc"), limit(500));
      const snap = await getDocs(qy);
      if (snap.empty) break;
      snap.forEach(d => auditRows.push(d.data()));
      cursor = snap.docs[snap.docs.length - 1];
      if (snap.size < 500) break;
    }
  } catch (_) { /* audit optional in archive */ }
  return {
    archiveVersion: 1,
    app: "4th-and-cold-squares",
    seasonName: cfg?.seasonName || "Season",
    exportedAt: new Date().toISOString(),
    exportedBy: adminEmail || "",
    config: cfg || {},
    squares: dump(squares),
    games: gamesObj,
    payments: dump(payments),
    payouts: dump(payouts),
    profiles: dump(profiles),
    audit: auditRows
  };
}
function downloadArchive(archive) {
  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const slug = (archive.seasonName || "season").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  a.download = `4th-and-cold-archive-${slug}-${tsFileStamp()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
/* Human-readable CSV: boards per game, winners, payments in & out */
function csvEscape(v) {
  v = String(v ?? "");
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function buildCsv(archive) {
  const L = [];
  const row = (...cells) => L.push(cells.map(csvEscape).join(","));
  row("4TH AND COLD SQUARES — SEASON ARCHIVE");
  row("Season", archive.seasonName);
  row("Exported", archive.exportedAt, "by", archive.exportedBy || "");
  row("Price per square", archive.config?.pricePerSquare ?? "", "Payout per win", archive.config?.payoutPerWin ?? "");
  L.push("");
  // Claims list
  row("SQUARES CLAIMED");
  row("Row", "Col", "Square name", "Full name", "Email");
  Object.values(archive.squares || {})
    .sort((a, b) => (a.row - b.row) || (a.col - b.col))
    .forEach(sq => row(sq.row, sq.col, sq.squareName, sq.fullName, sq.email));
  L.push("");
  // One board grid per game (numbers differ per game)
  const gameIds = Object.keys(archive.games || {}).sort((a, b) =>
    ((archive.games[a].order || 0) - (archive.games[b].order || 0)));
  gameIds.forEach(gid => {
    const g = archive.games[gid];
    row("BOARD — " + (g.opponent || gid), g.date || "");
    const top = g.texasDigits, side = g.oppDigits;
    row("", ...(top ? top : Array(10).fill("?")));
    for (let r = 1; r <= 10; r++) {
      const cells = [];
      for (let c = 1; c <= 10; c++) {
        const sq = archive.squares?.[r + "_" + c];
        cells.push(sq ? sq.squareName : "");
      }
      row(side ? side[r - 1] : "?", ...cells);
    }
    L.push("");
  });
  // Winners across the season
  row("WINNERS");
  row("Game", "Period", "Square name", "Full name", "Email", "Score", "Payout confirmed", "Confirmed by");
  gameIds.forEach(gid => {
    const g = archive.games[gid];
    Object.entries(g.winners || {})
      .sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)))
      .forEach(([qk, w]) => {
        const q = Number(qk.slice(1));
        const p = archive.payouts?.[gid + "_q" + q];
        row(g.opponent || gid, qk.toUpperCase(), w.squareName, w.fullName || "", w.email || "",
            `${w.texasScore}-${w.oppScore}`, p?.paid ? "YES" : (w.empty ? "n/a (tailgate)" : "no"), p?.paidBy || "");
      });
    if (g.finalScore) row(g.opponent || gid, "FINAL SCORE", "", "", "", `${g.finalScore.t}-${g.finalScore.o}`, "", "");
  });
  L.push("");
  // Payments in
  row("PAYMENTS RECEIVED");
  row("Full name", "Email", "Amount received", "Paid to");
  Object.values(archive.payments || {}).forEach(p =>
    row(p.fullName || "", p.email || "", p.amountReceived ?? 0, p.paidTo || ""));
  return L.join("\n");
}
function downloadCsv(name, csv) {
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function archiveSlug(archive) {
  return (archive.seasonName || "season").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
/* Cloud copy: everything except the audit log (audit lives in its own
   collection forever and would blow Firestore's 1MB doc cap). CSV rides along. */
async function storeArchiveToCloud(archive) {
  const { audit: _omit, ...cloudCopy } = archive;
  cloudCopy.auditIncluded = false;
  cloudCopy.csv = buildCsv(archive);
  cloudCopy.ts = serverTimestamp();
  const id = archiveSlug(archive) + "-" + tsFileStamp() + "-" + Date.now().toString(36);
  await setDoc(doc(db, "archives", id), cloudCopy);
  return id;
}
$("archiveBtn").onclick = async () => {
  showLoading();
  try {
    const archive = await buildSeasonArchive();
    downloadArchive(archive);
    await storeArchiveToCloud(archive);
    audit("season.archive", `${archive.seasonName} — ${Object.keys(archive.squares).length} squares, ${Object.keys(archive.payments).length} payment records — downloaded + saved to cloud`);
    toast("Archive downloaded and saved to the cloud.");
  } catch (err) { toast("Archive failed: " + (err.message || err)); }
  hideLoading();
};

/* Live CSV: current state right now — unlike archive CSVs, which are
   point-in-time snapshots frozen when the archive was created */
$("csvNowBtn").onclick = async () => {
  showLoading();
  try {
    const archive = await buildSeasonArchive();
    downloadCsv(`4th-and-cold-${archiveSlug(archive)}-current-${tsFileStamp()}.csv`, buildCsv(archive));
    toast("Current CSV downloaded.");
  } catch (err) { toast("CSV failed: " + (err.message || err)); }
  hideLoading();
};

/* Browse cloud archives: download JSON/CSV or restore any past season */
$("cloudArchivesBtn").onclick = async () => {
  const list = $("cloudArchivesList");
  list.innerHTML = "";
  list.appendChild(el("div", "emptyNote", "Loading…"));
  try {
    const snap = await getDocs(query(collection(db, "archives"), orderBy("ts", "desc"), limit(50)));
    list.innerHTML = "";
    if (snap.empty) { list.appendChild(el("div", "emptyNote", "No cloud archives yet — they're created automatically whenever a season is archived or cleared.")); return; }
    snap.forEach(d => {
      const a = d.data();
      const rowEl = el("div", "poRow");
      const left = el("div");
      left.appendChild(el("div", "poGame", a.seasonName || d.id));
      left.appendChild(el("div", "poMeta",
        `${(a.exportedAt || "").slice(0, 10)} · ${Object.keys(a.squares || {}).length} squares · ${Object.keys(a.payments || {}).length} payments · by ${a.exportedBy || "?"}`));
      rowEl.appendChild(left);
      const right = el("div", "btnRow");
      const jBtn = el("button", "ghostBtn miniBtn", "JSON");
      jBtn.type = "button";
      jBtn.onclick = () => downloadArchive({ ...a, audit: a.audit || [] });
      const cBtn = el("button", "ghostBtn miniBtn", "CSV");
      cBtn.type = "button";
      cBtn.onclick = () => downloadCsv(`4th-and-cold-${archiveSlug(a)}-${(a.exportedAt || "").slice(0, 10)}.csv`, a.csv || buildCsv(a));
      const rBtn = el("button", "dangerBtn miniBtn", "Restore");
      rBtn.type = "button";
      rBtn.onclick = () => confirmAndRestore(a);
      const xBtn = el("button", "dangerBtn miniBtn", "✕");
      xBtn.type = "button";
      xBtn.title = "Delete this archive permanently";
      xBtn.onclick = async () => {
        if (!confirm(`Delete archive "${a.seasonName}" (${(a.exportedAt || "").slice(0, 10)})? This cannot be undone.`)) return;
        try {
          await deleteDoc(doc(db, "archives", d.id));
          audit("archive.delete", `${a.seasonName} (exported ${a.exportedAt || "?"})`);
          toast("Archive deleted.");
          $("cloudArchivesBtn").click(); // refresh the list
        } catch (err) { toast(friendlyErr(err)); }
      };
      right.append(jBtn, cBtn, rBtn, xBtn);
      rowEl.appendChild(right);
      list.appendChild(rowEl);
    });
  } catch (err) {
    list.innerHTML = "";
    list.appendChild(el("div", "emptyNote", "Couldn't load archives: " + (err.message || err)));
  }
};

/* Restore: overwrite the live season with an archive's contents.
   Firestore batches cap at 500 ops, so writes are chunked. */
function chunkedBatches() {
  const batches = [writeBatch(db)];
  let count = 0;
  const op = (fn) => {
    if (count >= 400) { batches.push(writeBatch(db)); count = 0; }
    fn(batches[batches.length - 1]);
    count++;
  };
  const commit = async () => { for (const b of batches) await b.commit(); };
  return { op, commit };
}
$("restoreBtn").onclick = () => $("restoreFile").click();
$("restoreFile").onchange = async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ""; // allow re-picking the same file later
  if (!file) return;
  let archive;
  try { archive = JSON.parse(await file.text()); }
  catch (_) { toast("That file isn't readable JSON."); return; }
  confirmAndRestore(archive);
};
async function confirmAndRestore(archive) {
  if (archive?.app !== "4th-and-cold-squares" || !archive.archiveVersion) {
    toast("That doesn't look like a 4th & Cold season archive."); return;
  }
  const when = (archive.exportedAt || "").slice(0, 10);
  if (!confirm(`Restore season "${archive.seasonName}" (exported ${when})? This OVERWRITES the current board, payments, payouts, and numbers.`)) return;
  if (!confirm("Really sure? Current data will be replaced by the archive.")) return;
  showLoading();
  try {
    const { op, commit } = chunkedBatches();
    // Wipe current docs that aren't in the archive, then write archive docs
    (await getDocs(collection(db, "squares"))).forEach(d => { if (!archive.squares?.[d.id]) op(b => b.delete(d.ref)); });
    (await getDocs(collection(db, "payments"))).forEach(d => { if (!archive.payments?.[d.id]) op(b => b.delete(d.ref)); });
    (await getDocs(collection(db, "payouts"))).forEach(d => { if (!archive.payouts?.[d.id]) op(b => b.delete(d.ref)); });
    (await getDocs(collection(db, "games"))).forEach(d => { if (!archive.games?.[d.id]) op(b => b.delete(d.ref)); });
    Object.entries(archive.squares || {}).forEach(([id, data]) => op(b => b.set(doc(db, "squares", id), data)));
    Object.entries(archive.payments || {}).forEach(([id, data]) => op(b => b.set(doc(db, "payments", id), data)));
    Object.entries(archive.payouts || {}).forEach(([id, data]) => op(b => b.set(doc(db, "payouts", id), data)));
    Object.entries(archive.games || {}).forEach(([id, data]) => op(b => b.set(doc(db, "games", id), data)));
    Object.entries(archive.profiles || {}).forEach(([id, data]) => op(b => b.set(doc(db, "profiles", id), data, { merge: true })));
    // Config last — and never restore yourself out of the admin list
    const cfgData = { ...(archive.config || {}) };
    const admins = (cfgData.adminEmails || []).map(x => String(x).toLowerCase());
    if (adminEmail && !admins.includes(adminEmail)) admins.push(adminEmail);
    cfgData.adminEmails = admins;
    op(b => b.set(doc(db, "config", "current"), cfgData));
    await commit();
    audit("season.restore", `Restored "${archive.seasonName}" (exported ${archive.exportedAt || "?"}) — ${Object.keys(archive.squares || {}).length} squares, ${Object.keys(archive.payments || {}).length} payments, ${Object.keys(archive.payouts || {}).length} payouts`);
    toast(`Season "${archive.seasonName}" restored.`);
  } catch (err) { toast("Restore failed: " + (err.message || err)); }
  hideLoading();
}

$("clearBoardBtn").onclick = async () => {
  if (!confirm("Are you sure? This will delete ALL data — every square, payment, drawn number, and winner.")) return;
  if (!confirm("Are you REALLY sure? Is this really a new season?")) return;
  // Archive first, always — the wipe never runs without a saved copy
  showLoading();
  let archived = false;
  try {
    const archive = await buildSeasonArchive();
    downloadArchive(archive);
    await storeArchiveToCloud(archive).catch(() => {}); // cloud copy is best-effort
    archived = true;
  } catch (_) { /* fall through to the confirm below */ }
  hideLoading();
  if (!archived) {
    if (!confirm("Couldn't build the archive download. Wipe WITHOUT a backup?")) return;
  } else {
    if (!confirm("Season archive downloaded to your device — check your downloads, then OK to wipe.")) return;
  }
  try {
    const batch = writeBatch(db);
    (await getDocs(collection(db, "squares"))).forEach(d => batch.delete(d.ref));
    (await getDocs(collection(db, "payments"))).forEach(d => batch.delete(d.ref));
    (await getDocs(collection(db, "payouts"))).forEach(d => batch.delete(d.ref));
    games.forEach(g => batch.update(doc(db, "games", g.id), { texasDigits: null, oppDigits: null, numbersLocked: false, winners: {}, finalScore: null }));
    batch.update(doc(db, "config", "current"), { boardLocked: false });
    await batch.commit();
    audit("season.clear", "All squares, payments, payouts, numbers, and winners wiped for a new season (archive downloaded first)");
    toast("Fresh board. New season, who dis.");
  } catch (err) { toast(friendlyErr(err)); }
};

/* ---------------- ADMIN: audit log viewer ---------------- */
const AUDIT_PAGE = 75;
let auditCursor = null; // last doc of the previous page, for pagination

function auditTime(a) {
  const when = a.ts?.toDate ? a.ts.toDate() : null;
  if (!when) return "—";
  return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")} ` +
    `${when.getHours()}:${String(when.getMinutes()).padStart(2, "0")}`;
}
function appendAuditRows(snap) {
  const list = $("auditList");
  snap.forEach(d => {
    const a = d.data();
    const row = el("div", "auditRow");
    row.appendChild(el("span", "aTime", auditTime(a)));
    const body = el("div");
    const line1 = el("div");
    line1.appendChild(el("span", "aAction", a.action + " "));
    line1.appendChild(el("span", "aActor", `${a.actorName ? a.actorName + " · " : ""}${a.actor} (${a.role})`));
    body.appendChild(line1);
    if (a.details) body.appendChild(el("div", "aDetails", a.details));
    row.appendChild(body);
    list.appendChild(row);
  });
}
async function loadAuditPage(reset) {
  const list = $("auditList");
  if (reset) { list.innerHTML = ""; auditCursor = null; }
  const pageSize = reset ? 5 : AUDIT_PAGE; // short first page keeps the panel compact
  try {
    const parts = [collection(db, "audit"), orderBy("ts", "desc")];
    const qy = auditCursor
      ? query(parts[0], parts[1], startAfter(auditCursor), limit(pageSize))
      : query(parts[0], parts[1], limit(pageSize));
    const snap = await getDocs(qy);
    if (reset && snap.empty) {
      list.appendChild(el("div", "emptyNote", "No activity recorded yet."));
      $("auditMoreBtn").classList.add("hidden");
      return;
    }
    appendAuditRows(snap);
    auditCursor = snap.docs[snap.docs.length - 1] || auditCursor;
    // More pages likely if we got a full page back
    $("auditMoreBtn").classList.toggle("hidden", snap.size < pageSize);
    if (!reset && snap.empty) toast("That's the whole log.");
  } catch (err) {
    list.appendChild(el("div", "emptyNote", "Couldn't load audit log: " + (err.message || err)));
  }
}
$("auditRefreshBtn").onclick = () => loadAuditPage(true);
$("auditMoreBtn").onclick = () => loadAuditPage(false);

/* Download the complete log as a text file (paged fetch, oldest last) */
$("auditDownloadBtn").onclick = async () => {
  toast("Building full log…");
  try {
    const lines = [];
    let cursor = null, fetched = 0;
    while (true) {
      const qy = cursor
        ? query(collection(db, "audit"), orderBy("ts", "desc"), startAfter(cursor), limit(500))
        : query(collection(db, "audit"), orderBy("ts", "desc"), limit(500));
      const snap = await getDocs(qy);
      if (snap.empty) break;
      snap.forEach(d => {
        const a = d.data();
        lines.push(`${auditTime(a)} | ${a.action} | ${a.actorName ? a.actorName + " " : ""}<${a.actor}> (${a.role})${a.details ? " | " + a.details : ""}`);
      });
      fetched += snap.size;
      cursor = snap.docs[snap.docs.length - 1];
      if (snap.size < 500 || fetched > 20000) break; // sanity ceiling
    }
    if (!lines.length) { toast("Log is empty."); return; }
    const header = `4TH & COLD SQUARES — FULL AUDIT LOG\nGenerated ${new Date().toLocaleString()} · ${lines.length} entries (newest first)\n${"=".repeat(60)}\n`;
    const blob = new Blob([header + lines.join("\n") + "\n"], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const d = new Date();
    a.download = `fourth-and-cold-audit-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`Downloaded ${lines.length} audit entries.`);
  } catch (err) { toast("Download failed: " + (err.message || err)); }
};

/* ---------------- kick off ---------------- */
startListeners();
setTimeout(() => hideLoading(), 6000); // safety net if the network is down
completeEmailLinkIfPresent();
setTimeout(() => { refreshIdentityFromProfile(); refreshMyPayment(); }, 1500);
setTimeout(() => maybeStartLivePoll(), 2500);
