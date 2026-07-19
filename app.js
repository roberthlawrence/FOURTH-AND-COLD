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
  (q === 4 ? "FINAL" : "Q" + q);
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
let unsubPayouts = null;
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

/* ---------------- boot ---------------- */
onAuthStateChanged(auth, async (user) => {
  if (!user) { await signInAnonymously(auth).catch(err => toast("Auth error: " + err.message)); return; }
  uid = user.uid;
  if (!user.isAnonymous && user.email) {
    // Google sign-in — admin check happens once config loads
    adminEmail = user.email.toLowerCase();
  }
  startListeners();
  route();
});

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
  });
  unsubPayouts = onSnapshot(collection(db, "payouts"), (qs) => {
    payouts.clear();
    qs.forEach(d => payouts.set(d.id, d.data()));
    renderWinners(); renderWinnerBanner();
  });
}

function defaultGame() {
  // pick today's game if any, else next upcoming, else last
  const today = new Date(); today.setHours(0,0,0,0);
  const upcoming = games.find(g => new Date(g.date + "T23:59:59") >= today);
  return upcoming || games[games.length - 1];
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
  $("adminPanel").classList.toggle("hidden", !admin);
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
  }
  renderBoard(); renderMyPanel(); renderPot(); renderVenmo();
}

/* ---------------- welcome / identity flow ---------------- */
$("enterBoardBtn").onclick = () => {
  const n = $("wFullName").value.trim();
  const e = $("wEmail").value.trim().toLowerCase();
  if (!n || !e || !e.includes("@")) { toast("Enter your full name and a valid email."); return; }
  me = { fullName: n, email: e };
  saveIdentity();
  route();
  renderBoard(); renderMyPanel(); renderWinnerBanner();
};
$("switchUserBtn").onclick = () => {
  localStorage.removeItem("fc_name"); localStorage.removeItem("fc_email");
  me = { fullName: "", email: "" };
  route();
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

  // Big top-axis team bar (burnt orange)
  const axisRow = el("tr");
  const axisCorner = el("th", "corner"); axisCorner.colSpan = 2;
  axisRow.appendChild(axisCorner);
  const axisTh = el("th", "axisTop");
  axisTh.colSpan = GRID;
  axisTh.appendChild(el("span", "axisBar", topName));
  axisRow.appendChild(axisTh);
  board.appendChild(axisRow);

  // Digit header row (top digits in orange)
  const head = el("tr");
  const headCorner = el("th", "corner"); headCorner.colSpan = 2;
  head.appendChild(headCorner);
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
  const pay = payments.get(payDocId(me.email));
  const bal = $("myBalance");
  if (pay && Number(pay.amountReceived) >= owed && owed > 0) {
    bal.innerHTML = `${mine.length} square${mine.length === 1 ? "" : "s"} · ${money(owed)} — <span class="settled">PAID ✓</span>`;
  } else if (mine.length) {
    bal.innerHTML = `${mine.length} square${mine.length === 1 ? "" : "s"} · <span class="due">${money(owed)} due</span>`;
  } else bal.textContent = "";
}

function renderVenmo() {
  const box = $("venmoBox");
  box.innerHTML = "";
  (cfg?.venmo || []).forEach(v => {
    const line = el("div");
    const a = el("a", null, "@" + v.handle);
    a.href = "https://venmo.com/u/" + v.handle;
    a.target = "_blank"; a.rel = "noopener";
    line.appendChild(a);
    if (v.note) line.append(" — " + v.note);
    box.appendChild(line);
  });
  if (cfg?.venmo?.length) {
    box.appendChild(el("div", "finePrint", `Include your name and "4th and Cold Squares" in the payment note.`));
  }
}

/* ---------------- winners ledger ---------------- */
function winnerKeysForGame(g) {
  const set = new Set();
  if (!g?.winners) return set;
  Object.values(g.winners).forEach(w => { if (w?.key) set.add(w.key); });
  return set;
}
const payoutId = (gameId, q) => `${gameId}_q${q}`;

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
          badge.onclick = async () => {
            if (!confirm(`Undo payout confirmation for ${w.squareName}?`)) return;
            try {
              await deleteDoc(doc(db, "payouts", payoutId(g.id, idx + 1)));
              audit("payout.undo", `${g.opponent || g.id} ${periodLabel(idx + 1)} — ${w.fullName} (${w.email})`);
              toast("Payout confirmation removed.");
            } catch (err) { toast(friendlyErr(err)); }
          };
        }
        payCol.appendChild(badge);
      } else if (isAdmin()) {
        const btn = el("button", "markPaidBtn", "Mark paid");
        btn.type = "button";
        btn.onclick = async () => {
          if (!confirm(`Confirm ${money(cfg?.payoutPerWin)} sent to ${w.fullName} for ${periodLabel(idx + 1)}?`)) return;
          try {
            await setDoc(doc(db, "payouts", payoutId(g.id, idx + 1)), {
              gameId: g.id, period: idx + 1,
              email: w.email, fullName: w.fullName, squareName: w.squareName,
              amount: cfg?.payoutPerWin || 0,
              paid: true, paidBy: adminEmail, paidAt: serverTimestamp()
            });
            audit("payout.sent", `${g.opponent || g.id} ${periodLabel(idx + 1)} — ${money(cfg?.payoutPerWin)} to ${w.fullName} (${w.email})`);
            toast("Payout marked as sent.");
          } catch (err) { toast(friendlyErr(err)); }
        };
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
async function autoRecordWinners(g, comp) {
  if (!isPowerAdmin()) return;
  const computed = computePeriodWinners(g, comp);
  const existing = g.winners || {};
  const newKeys = Object.keys(computed).filter(k => !existing[k]);
  if (!newKeys.length) return;
  const winners = { ...existing };
  newKeys.forEach(k => winners[k] = computed[k]);
  try {
    await updateDoc(doc(db, "games", g.id), { winners });
    const summary = newKeys.map(k => `${periodLabel(Number(k.slice(1)))}: ${winners[k].squareName}`).join(" · ");
    audit("winner.auto", `${g.opponent || g.id} — ${summary}`);
    toast("Winner recorded — " + summary);
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
    await updateDoc(doc(db, "games", g.id), { winners, espnEventId: eventId });
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
  // aggregate squares by email
  const byEmail = new Map();
  squares.forEach(s => {
    const k = s.email;
    if (!byEmail.has(k)) byEmail.set(k, { fullName: s.fullName, email: k, count: 0 });
    byEmail.get(k).count++;
  });
  return [...byEmail.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}
function renderPayments() {
  if (!isAdmin()) return;
  const wrap = $("payTableWrap");
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
    tr.appendChild(el("td", "emailCell", r.email));
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
    // Tap the row (not the inputs) to light up this person's squares on the board
    tr.onclick = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "OPTION") return;
      if (highlightEmail === r.email) {
        highlightEmail = null;
        toast("Highlight cleared.");
      } else {
        highlightEmail = r.email;
        toast(`Highlighting ${r.fullName}'s ${r.count} square${r.count === 1 ? "" : "s"} in blue — tap the row again to clear.`);
        $("boardSection").scrollIntoView({ behavior: "smooth", block: "start" });
      }
      renderBoard(); renderPayments();
    };
    const save = async () => {
      try {
        await setDoc(doc(db, "payments", payDocId(r.email)), {
          fullName: r.fullName, email: r.email,
          amountReceived: Number(inp.value || 0),
          paidTo: sel.value === "—" ? "" : sel.value,
          updatedAt: serverTimestamp()
        }, { merge: true });
        audit("payment.update", `${r.fullName} (${r.email}): $${Number(inp.value || 0)} via ${sel.value === "—" ? "unset" : sel.value} — owed $${owed}`);
      } catch (err) { toast(friendlyErr(err)); }
    };
    inp.onchange = save; sel.onchange = save;
    table.appendChild(tr);
  });
  wrap.innerHTML = "";
  if (!rows.length) wrap.appendChild(el("div", "emptyNote", "No squares claimed yet."));
  else wrap.appendChild(table);
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

$("clearBoardBtn").onclick = async () => {
  if (!confirm("Are you sure? This will delete ALL data — every square, payment, drawn number, and winner.")) return;
  if (!confirm("Are you REALLY sure? Is this really a new season?")) return;
  try {
    const batch = writeBatch(db);
    (await getDocs(collection(db, "squares"))).forEach(d => batch.delete(d.ref));
    (await getDocs(collection(db, "payments"))).forEach(d => batch.delete(d.ref));
    (await getDocs(collection(db, "payouts"))).forEach(d => batch.delete(d.ref));
    games.forEach(g => batch.update(doc(db, "games", g.id), { texasDigits: null, oppDigits: null, numbersLocked: false, winners: {} }));
    batch.update(doc(db, "config", "current"), { boardLocked: false });
    await batch.commit();
    audit("season.clear", "All squares, payments, numbers, and winners wiped for a new season");
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
  try {
    const parts = [collection(db, "audit"), orderBy("ts", "desc")];
    const qy = auditCursor
      ? query(parts[0], parts[1], startAfter(auditCursor), limit(AUDIT_PAGE))
      : query(parts[0], parts[1], limit(AUDIT_PAGE));
    const snap = await getDocs(qy);
    if (reset && snap.empty) {
      list.appendChild(el("div", "emptyNote", "No activity recorded yet."));
      $("auditMoreBtn").classList.add("hidden");
      return;
    }
    appendAuditRows(snap);
    auditCursor = snap.docs[snap.docs.length - 1] || auditCursor;
    // More pages likely if we got a full page back
    $("auditMoreBtn").classList.toggle("hidden", snap.size < AUDIT_PAGE);
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

/* ---------------- kick off live polling on load ---------------- */
setTimeout(() => maybeStartLivePoll(), 2500);
