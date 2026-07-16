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
  setDoc, updateDoc, deleteDoc, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ---------------- constants / state ---------------- */
const GRID = 10;
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/college-football";
const TEXAS_TEAM_ID = "251";
const LIVE_POLL_MS = 60_000;

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
    renderTabs(); renderBoard(); renderWinners(); renderAdminGame(); renderPot();
  });
}

function defaultGame() {
  // pick today's game if any, else next upcoming, else last
  const today = new Date(); today.setHours(0,0,0,0);
  const upcoming = games.find(g => new Date(g.date + "T23:59:59") >= today);
  return upcoming || games[games.length - 1];
}

function isAdmin() {
  return !!(adminEmail && cfg && (cfg.adminEmails || []).map(e => e.toLowerCase()).includes(adminEmail));
}

function onConfig() {
  if (!cfg) {
    // First run: no season configured yet
    $("welcomeBlurb").textContent = "Season not configured yet. Admin: sign in and run Season setup.";
    if (adminEmail) { // let a signed-in Googler bootstrap
      $("adminPanel").classList.remove("hidden");
      $("adminWho").textContent = adminEmail;
      $("seasonForm").classList.remove("hidden");
      renderCfgGames([]);
    }
    return;
  }
  $("brandSeason").textContent = (cfg.seasonName || "SQUARES").toUpperCase();
  $("welcomeBlurb").textContent = cfg.blurb || "";
  const admin = isAdmin();
  $("adminPanel").classList.toggle("hidden", !admin);
  if (adminEmail) $("adminLoginBtn").textContent = "Sign out";
  if (admin) {
    $("adminWho").textContent = adminEmail;
    $("lockBtn").classList.toggle("hidden", !!cfg.boardLocked);
    $("unlockBtn").classList.toggle("hidden", !cfg.boardLocked);
    fillSeasonForm();
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
  renderBoard(); renderMyPanel();
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

function renderBoard() {
  const g = currentGame();
  const board = $("board");
  board.innerHTML = "";
  $("boardTitle").textContent = g ? ("TEXAS vs " + (g.opponent || "TBD")) : "Board";
  $("boardStatus").textContent = cfg?.boardLocked ? "Board locked" : "Board open — tap a square";

  const cols = g?.texasDigits || null;   // TEXAS digits across the top
  const rows = g?.oppDigits || null;     // OPPONENT digits down the side

  // Axis label row
  const axisRow = el("tr");
  axisRow.appendChild(el("th", "corner"));
  const axisTh = el("th", "axisLabel", "TEXAS →");
  axisTh.colSpan = GRID;
  axisRow.appendChild(axisTh);
  board.appendChild(axisRow);

  // Digit header row
  const head = el("tr");
  head.appendChild(el("th", "corner"));
  for (let c = 1; c <= GRID; c++) {
    const th = el("th", "digit" + (cols ? "" : " undrawn"), cols ? String(cols[c - 1]) : "?");
    th.dataset.axis = "col"; th.dataset.idx = c - 1;
    head.appendChild(th);
  }
  board.appendChild(head);

  const winKey = liveWinningKey();
  const recordedWins = winnerKeysForGame(g);

  for (let r = 1; r <= GRID; r++) {
    const tr = el("tr");
    const th = el("th", "digit" + (rows ? "" : " undrawn"), rows ? String(rows[r - 1]) : "?");
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

  // OPPONENT axis label (first digit column) — use a caption-ish approach via title attr on row headers
  const oppLabel = g?.opponent ? g.opponent.toUpperCase() + " ↓" : "OPPONENT ↓";
  board.querySelectorAll("tr")[2]?.querySelector("th.digit")?.setAttribute("title", oppLabel);
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
      toast("Square updated.");
    } else {
      await setDoc(doc(db, "squares", key), {
        row, col, squareName: name,
        fullName: me.fullName, email: me.email,
        uid, claimedAt: serverTimestamp()
      });
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
function renderWinners() {
  const list = $("winnersList");
  list.innerHTML = "";
  const g = currentGame();
  if (!g) return;
  const qs = ["q1", "q2", "q3", "q4"];
  const labels = { q1: "Q1", q2: "Q2", q3: "Q3", q4: "FINAL" };
  let any = false;
  qs.forEach(q => {
    const w = g.winners?.[q];
    if (!w) return;
    any = true;
    const row = el("div", "winRow");
    row.appendChild(el("span", "winQ", labels[q]));
    const mid = el("div");
    mid.appendChild(el("div", "winName", w.squareName + (w.fullName ? " · " + w.fullName : "")));
    mid.appendChild(el("div", "winScore", `TEX ${w.texasScore} — ${g.opponent || "OPP"} ${w.oppScore}`));
    row.appendChild(mid);
    row.appendChild(el("span", "winPay", w.empty ? "→ tailgate" : money(cfg?.payoutPerWin)));
    list.appendChild(row);
  });
  if (!any) list.appendChild(el("div", "emptyNote", "No winners recorded yet for this game."));
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
  const totalWins = games.length * 4;
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
    const res = await fetch(`${ESPN}/teams/${TEXAS_TEAM_ID}/schedule`);
    const data = await res.json();
    const ev = (data.events || []).find(e => (e.date || "").slice(0, 10) === g.date);
    return ev ? ev.id : null;
  } catch (_) { return null; }
}
async function pullLive() {
  const g = currentGame();
  if (!g) return;
  const eventId = await resolveEventId(g);
  if (!eventId) return;
  try {
    const res = await fetch(`${ESPN}/summary?event=${eventId}`);
    const data = await res.json();
    const comp = data?.header?.competitions?.[0];
    if (!comp) return;
    const texas = comp.competitors.find(c => c.id === TEXAS_TEAM_ID || c.team?.id === TEXAS_TEAM_ID);
    const opp = comp.competitors.find(c => c !== texas);
    if (!texas || !opp) return;
    const status = comp.status || data?.header?.competitions?.[0]?.status || {};
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
      oppAbbrev: opp.team?.abbreviation || (g.opponent || "OPP").slice(0, 4).toUpperCase()
    };
    renderScoreStrip(g);
    renderTabs();
    renderBoard();
    if (!liveState.inProgress && !liveState.done) $("scoreStrip").classList.add("hidden");
  } catch (_) { /* network hiccup, next poll */ }
}
function renderScoreStrip(g) {
  if (!liveState || (!liveState.inProgress && !liveState.done)) return;
  $("scoreStrip").classList.remove("hidden");
  $("scoreTexas").textContent = liveState.texasScore;
  $("scoreOpp").textContent = liveState.oppScore;
  $("scoreOppLabel").textContent = liveState.oppAbbrev;
  $("scoreQtr").textContent = liveState.done ? "FINAL" : "Q" + liveState.period;
  $("scoreClock").textContent = liveState.done ? "" : liveState.clock;
}
/* which square is currently "leading" (would win if the quarter ended now) */
function liveWinningKey() {
  const g = currentGame();
  if (!g || !liveState || liveState.gameId !== g.id) return null;
  if (!liveState.inProgress) return null;
  if (liveState.period > 4) return null; // OT: Q4 result already locked at end of regulation
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
    toast(v ? "Board locked." : "Board unlocked.");
  } catch (err) { toast(friendlyErr(err)); }
}

function renderAdminGame() {
  if (!isAdmin()) return;
  const g = currentGame();
  $("drawGameName").textContent = g ? (g.opponent || g.id) : "—";
  $("drawBtn").classList.toggle("hidden", !!g?.texasDigits);
  $("redrawBtn").classList.toggle("hidden", !g?.texasDigits);
  $("espnIdInput").value = g?.espnEventId || "";
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
  if (g.texasDigits && !force) return;
  const tex = shuffledDigits(), opp = shuffledDigits();
  await animateDraw(tex, opp);
  try {
    await updateDoc(doc(db, "games", g.id), { texasDigits: tex, oppDigits: opp, drawnAt: serverTimestamp() });
    toast("Numbers drawn for " + (g.opponent || g.id) + "!");
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
    toast("ESPN ID saved.");
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
    const res = await fetch(`${ESPN}/summary?event=${eventId}`);
    const data = await res.json();
    const comp = data?.header?.competitions?.[0];
    const texas = comp.competitors.find(c => c.id === TEXAS_TEAM_ID || c.team?.id === TEXAS_TEAM_ID);
    const opp = comp.competitors.find(c => c !== texas);
    const tLines = (texas.linescores || []).map(l => Number(l.displayValue ?? l.value ?? 0));
    const oLines = (opp.linescores || []).map(l => Number(l.displayValue ?? l.value ?? 0));
    const state = comp.status?.type?.state;
    const period = comp.status?.period || tLines.length;
    // completed quarters: all listed linescores except the one in progress
    let completed = Math.min(tLines.length, oLines.length);
    if (state === "in" && period <= completed) completed = period - 1;
    if (state === "post") completed = 4; // final counts as Q4 (incl. OT rolled into final score)
    const winners = { ...(g.winners || {}) };
    let recorded = [];
    let tSum = 0, oSum = 0;
    for (let q = 1; q <= Math.min(completed, 4); q++) {
      // Every quarter, including Q4, is cumulative through that quarter's
      // linescore — Q4 pays on the end-of-regulation score, OT excluded.
      tSum += tLines[q - 1] || 0; oSum += oLines[q - 1] || 0;
      const col = g.texasDigits.indexOf(digitsOf(tSum)) + 1;
      const row = g.oppDigits.indexOf(digitsOf(oSum)) + 1;
      const key = row + "_" + col;
      const sq = squares.get(key);
      winners["q" + q] = {
        key,
        squareName: sq ? sq.squareName : "— empty —",
        fullName: sq ? sq.fullName : "",
        email: sq ? sq.email : "",
        empty: !sq,
        texasScore: tSum, oppScore: oSum
      };
      recorded.push(`Q${q}: ${winners["q" + q].squareName} (TEX ${tSum}–${oSum})`);
    }
    await updateDoc(doc(db, "games", g.id), { winners, espnEventId: eventId });
    $("pullResult").textContent = recorded.length
      ? "Recorded → " + recorded.join(" · ")
      : "No completed quarters yet.";
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
  ["Name", "Sq", "Owed", "Received", "Paid to", "Status"].forEach(h => thead.appendChild(el("th", null, h)));
  table.appendChild(thead);
  const collectors = (cfg?.venmo || []).map(v => v.handle);
  rows.forEach(r => {
    const pay = payments.get(payDocId(r.email)) || {};
    const owed = r.count * price;
    const tr = el("tr");
    const nameTd = el("td", null, r.fullName); nameTd.title = r.email;
    tr.appendChild(nameTd);
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
    const save = async () => {
      try {
        await setDoc(doc(db, "payments", payDocId(r.email)), {
          fullName: r.fullName, email: r.email,
          amountReceived: Number(inp.value || 0),
          paidTo: sel.value === "—" ? "" : sel.value,
          updatedAt: serverTimestamp()
        }, { merge: true });
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
$("seasonToggleBtn").onclick = () => $("seasonForm").classList.toggle("hidden");

function fillSeasonForm() {
  if (!cfg) return;
  $("cfgSeasonName").value = cfg.seasonName || "";
  $("cfgPrice").value = cfg.pricePerSquare ?? 250;
  $("cfgPayout").value = cfg.payoutPerWin ?? 500;
  $("cfgAdmins").value = (cfg.adminEmails || []).join(", ");
  $("cfgVenmo").value = (cfg.venmo || []).map(v => v.handle + " | " + (v.note || "")).join("\n");
  $("cfgBlurb").value = cfg.blurb || "";
  renderCfgGames(games);
}
function renderCfgGames(list) {
  const box = $("cfgGames");
  box.innerHTML = "";
  for (let i = 0; i < 6; i++) {
    const g = list[i] || {};
    const row = el("div", "cfgGameRow");
    const opp = el("input"); opp.type = "text"; opp.placeholder = "Opponent " + (i + 1); opp.value = g.opponent || "";
    const date = el("input"); date.type = "text"; date.placeholder = "YYYY-MM-DD"; date.value = g.date || "";
    row.appendChild(opp); row.appendChild(date);
    box.appendChild(row);
  }
}
$("fetchScheduleBtn").onclick = async () => {
  try {
    const res = await fetch(`${ESPN}/teams/${TEXAS_TEAM_ID}/schedule`);
    const data = await res.json();
    const homes = (data.events || []).filter(e => {
      const c = e.competitions?.[0];
      const home = c?.competitors?.find(x => x.homeAway === "home");
      return home && (home.id === TEXAS_TEAM_ID || home.team?.id === TEXAS_TEAM_ID);
    }).map(e => {
      const c = e.competitions[0];
      const away = c.competitors.find(x => x.homeAway === "away");
      return { opponent: away?.team?.shortDisplayName || away?.team?.abbreviation || "TBD", date: (e.date || "").slice(0, 10), espnEventId: e.id };
    });
    const last6 = homes.slice(-6);
    if (!last6.length) { toast("No home games found in ESPN schedule yet."); return; }
    renderCfgGames(last6);
    $("cfgGames")._espnIds = last6.map(g => g.espnEventId);
    toast(`Loaded ${last6.length} home games — review dates, then Save season.`);
  } catch (err) { toast("Schedule fetch failed: " + err.message); }
};

$("saveSeasonBtn").onclick = async () => {
  const adminList = $("cfgAdmins").value.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (adminEmail && !adminList.includes(adminEmail)) adminList.push(adminEmail); // don't lock yourself out
  const venmo = $("cfgVenmo").value.split("\n").map(l => {
    const [handle, note] = l.split("|").map(s => (s || "").trim());
    return handle ? { handle: handle.replace(/^@/, ""), note: note || "" } : null;
  }).filter(Boolean);
  const cfgData = {
    seasonName: $("cfgSeasonName").value.trim() || "Squares",
    pricePerSquare: Number($("cfgPrice").value || 0),
    payoutPerWin: Number($("cfgPayout").value || 0),
    adminEmails: adminList,
    venmo,
    blurb: $("cfgBlurb").value,
    boardLocked: cfg?.boardLocked || false
  };
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, "config", "current"), cfgData, { merge: true });
    const rows = [...$("cfgGames").querySelectorAll(".cfgGameRow")];
    const espnIds = $("cfgGames")._espnIds || [];
    rows.forEach((row, i) => {
      const [opp, date] = row.querySelectorAll("input");
      if (!opp.value.trim()) return;
      const gid = "game" + (i + 1);
      const existing = games.find(g => g.id === gid) || {};
      batch.set(doc(db, "games", gid), {
        order: i + 1,
        opponent: opp.value.trim(),
        date: date.value.trim(),
        espnEventId: existing.espnEventId || espnIds[i] || "",
        texasDigits: existing.texasDigits || null,
        oppDigits: existing.oppDigits || null,
        winners: existing.winners || {}
      }, { merge: true });
    });
    await batch.commit();
    toast("Season saved.");
  } catch (err) { toast(friendlyErr(err)); }
};

$("clearBoardBtn").onclick = async () => {
  if (!confirm("Clear ALL squares, payments, numbers, and winners? This starts a fresh season.")) return;
  if (!confirm("Really sure? This cannot be undone.")) return;
  try {
    const batch = writeBatch(db);
    (await getDocs(collection(db, "squares"))).forEach(d => batch.delete(d.ref));
    (await getDocs(collection(db, "payments"))).forEach(d => batch.delete(d.ref));
    games.forEach(g => batch.update(doc(db, "games", g.id), { texasDigits: null, oppDigits: null, winners: {} }));
    batch.update(doc(db, "config", "current"), { boardLocked: false });
    await batch.commit();
    toast("Fresh board. New season, who dis.");
  } catch (err) { toast(friendlyErr(err)); }
};

/* ---------------- kick off live polling on load ---------------- */
setTimeout(() => maybeStartLivePoll(), 2500);
