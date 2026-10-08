// Snake × Jev
// Code owns the rules and reports what the snake observes (what's in each direction, where the food is).
// Jev decides where to move with a Choice question; code never tells it which move is safe or good.

const N = 20; // grid size
const CELL = 24; // px per cell on a 480px canvas
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPPOSITE = { up: "down", down: "up", left: "right", right: "left" };
const ARROWS = { up: "↑", down: "↓", left: "←", right: "→" };

const $ = (id) => document.getElementById(id);
const board = $("board");
const ctx = board.getContext("2d");

let snake, dir, food, score, alive, deathReason;
let best = 0;
let running = false;
let driver = "jev";
let pendingHumanDir = null;
let humanTimer = null;
let lastProbs = null; // candidate-move overlay from the latest Jev answer
let loopId = 0;

const log = [];
const totals = { calls: 0, latency: 0, inTok: 0, outTok: 0 };

// ---------- game rules ----------

function reset() {
  snake = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
  dir = "right";
  score = 0;
  alive = true;
  deathReason = "";
  lastProbs = null;
  placeFood();
  hideOverlay();
  updateStats();
  render();
}

function placeFood() {
  const free = [];
  for (let x = 0; x < N; x++)
    for (let y = 0; y < N; y++) if (!snake.some((s) => s.x === x && s.y === y)) free.push({ x, y });
  food = free[Math.floor(Math.random() * free.length)];
}

const inBounds = (p) => p.x >= 0 && p.y >= 0 && p.x < N && p.y < N;
const key = (p) => p.x + "," + p.y;
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

// Game physics for one move. Used to apply the move and to grade Jev afterward; never sent to Jev.
function analyzeMove(d) {
  const head = snake[0];
  const next = { x: head.x + DIRS[d][0], y: head.y + DIRS[d][1] };
  const eats = next.x === food.x && next.y === food.y;
  // The tail moves away this turn unless the snake grows.
  const body = eats ? snake : snake.slice(0, -1);
  if (!inBounds(next)) return { dir: d, next, deadly: true, reason: "wall" };
  if (body.some((s) => s.x === next.x && s.y === next.y)) return { dir: d, next, deadly: true, reason: "body" };
  return { dir: d, next, deadly: false, eats };
}

// What the snake can see looking in one direction from its head: raw observations, no verdicts.
function lookToward(d) {
  const head = snake[0];
  const [dx, dy] = DIRS[d];
  const tail = snake[snake.length - 1];
  for (let k = 1; ; k++) {
    const p = { x: head.x + dx * k, y: head.y + dy * k };
    let thing = null;
    if (!inBounds(p)) thing = "the wall";
    else if (p.x === food.x && p.y === food.y) thing = "the food";
    else if (p.x === tail.x && p.y === tail.y) thing = "the tip of the snake's tail";
    else if (snake.some((s) => s.x === p.x && s.y === p.y)) thing = "the snake's own body";
    if (thing) return k === 1 ? `${thing}, directly next to the head` : `${k - 1} empty square${k > 2 ? "s" : ""}, then ${thing}`;
  }
}

function foodLocation() {
  const head = snake[0];
  const dx = food.x - head.x;
  const dy = food.y - head.y;
  const sq = (n) => `${Math.abs(n)} square${Math.abs(n) > 1 ? "s" : ""}`;
  const parts = [];
  if (dy) parts.push(`${sq(dy)} ${dy < 0 ? "up" : "down"}`);
  if (dx) parts.push(`${sq(dx)} to the ${dx < 0 ? "left" : "right"}`);
  return `The food is ${parts.join(" and ")} from the head.`;
}

function step(d) {
  const m = analyzeMove(d);
  dir = d;
  if (m.deadly) {
    alive = false;
    deathReason = m.reason === "wall" ? "Hit the wall" : "Ran into itself";
    return;
  }
  snake.unshift(m.next);
  if (m.eats) {
    score++;
    best = Math.max(best, score);
    placeFood();
  } else {
    snake.pop();
  }
}

// ---------- Jev ----------

// Jev gets the rules, the goal, and what the snake observes. No hints about which move is safe or good.
const INSTRUCTIONS = "Which direction should the snake move next to achieve `goal`?";

const RULES =
  "Snake on a walled grid. Each turn the snake's head moves one square up, down, left, or right, and the body follows it. " +
  "The snake cannot reverse into its own neck. If the head moves into the wall or into the snake's own body, the game ends. " +
  "If the head moves onto the food, the snake grows one square longer and new food appears. " +
  "The tip of the tail leaves its square every turn, so the head can safely move into the square where the tail tip is now.";

const GOAL = "Stay alive as long as possible and eat as much food as possible.";

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function askJev() {
  const options = Object.keys(DIRS).filter((d) => d !== OPPOSITE[dir]);
  const moves = options.map(analyzeMove); // for grading and the board overlay only
  const sees = {};
  for (const d of options) sees[d] = lookToward(d);

  // Jev can lean toward the first-listed option, so the order is shuffled every turn.
  const criteria = {};
  for (const d of shuffle([...options])) criteria[d] = `Move the head one square ${d}.`;

  const state = { rules: RULES, goal: GOAL, what_the_snake_sees: sees, food: foodLocation() };
  const questions = { next_move: { type: "choice", instructions: INSTRUCTIONS, criteria } };
  const snapshot = { snake: snake.map((s) => ({ ...s })), food: { ...food }, dir };

  let result;
  try {
    const r = await fetch("/api/jev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, questions }),
    });
    result = await r.json();
  } catch (err) {
    result = { ok: false, error: String(err) };
  }

  const answer = result.response?.answers?.next_move;
  const entry = {
    n: log.length + 1,
    time: new Date().toISOString(),
    snapshot,
    moves,
    ok: Boolean(result.ok && answer),
    latency_ms: result.latency_ms,
    status: result.status,
    retries: result.retries || [],
    request: result.request || { state, questions },
    response: result.response ?? null,
    error: result.ok ? null : result.error || result.response?.detail || `HTTP ${result.status}`,
  };
  if (entry.ok) {
    entry.choice = answer.choice;
    entry.probabilities = answer.probabilities;
    entry.confidence = answer.confidence;
    entry.choseDeadly = moves.find((m) => m.dir === answer.choice)?.deadly && moves.some((m) => !m.deadly);
    totals.calls++;
    totals.latency += result.latency_ms || 0;
    totals.inTok += result.response.usage?.input_tokens || 0;
    totals.outTok += result.response.usage?.output_tokens || 0;
  }
  log.push(entry);
  if (log.length > 500) log.shift();
  addLogEntry(entry);
  updateStats();
  return entry;
}

let consecutiveFailures = 0;

async function jevTurn() {
  const entry = await askJev();
  if (!entry.ok) {
    consecutiveFailures++;
    const msg = typeof entry.error === "string" ? entry.error : entry.error?.message || JSON.stringify(entry.error);
    // The server already retried. Bad keys / invalid requests, or repeated outages, stop the game.
    const fatal = entry.status === 401 || entry.status === 422 || consecutiveFailures >= 3;
    if (fatal || !running) {
      stop();
      showOverlay("Jev call failed", msg);
      return false;
    }
    showOverlay("Jev is temporarily unavailable", "Retrying…");
    await sleep(1500);
    hideOverlay();
    return true; // same board, ask again
  }
  consecutiveFailures = 0;
  lastProbs = entry.moves.map((m) => ({ ...m, p: entry.probabilities[m.dir] ?? 0, chosen: m.dir === entry.choice }));
  render();
  await sleep(Number($("delay").value));
  step(entry.choice);
  lastProbs = null;
  render();
  updateStats();
  if (!alive) await gameOver();
  return true;
}

async function jevLoop(id) {
  while (running && id === loopId) {
    if (!alive) reset();
    const ok = await jevTurn();
    if (!ok) return;
  }
}

async function gameOver() {
  showOverlay(`${deathReason} — score ${score}`, $("autoRestart").checked && running ? "Restarting…" : "Press Start to play again");
  if ($("autoRestart").checked && running) {
    await sleep(1600);
    if (running) reset();
  } else {
    stop();
  }
}

// ---------- human mode ----------

function humanTick() {
  if (pendingHumanDir && pendingHumanDir !== OPPOSITE[dir]) dir = pendingHumanDir;
  pendingHumanDir = null;
  step(dir);
  render();
  updateStats();
  if (!alive) {
    clearInterval(humanTimer);
    humanTimer = null;
    gameOver().then(() => running && driver === "human" && start());
  }
}

// ---------- controls ----------

function start() {
  if (!alive) reset();
  hideOverlay();
  running = true;
  $("startBtn").textContent = "Pause";
  if (driver === "jev") jevLoop(++loopId);
  else if (!humanTimer) humanTimer = setInterval(humanTick, 120);
}

function stop() {
  running = false;
  loopId++;
  clearInterval(humanTimer);
  humanTimer = null;
  $("startBtn").textContent = "Start";
}

function setDriver(d) {
  stop();
  driver = d;
  $("driverJev").classList.toggle("on", d === "jev");
  $("driverHuman").classList.toggle("on", d === "human");
  $("stepBtn").disabled = d !== "jev";
}

$("startBtn").onclick = () => (running ? stop() : start());
$("stepBtn").onclick = async () => {
  if (running) return;
  if (!alive) reset();
  hideOverlay();
  $("stepBtn").disabled = true;
  await jevTurn();
  $("stepBtn").disabled = false;
};
$("resetBtn").onclick = () => {
  stop();
  reset();
};
$("driverJev").onclick = () => setDriver("jev");
$("driverHuman").onclick = () => setDriver("human");
$("delay").oninput = (e) => ($("delayVal").textContent = e.target.value + "ms");
$("clearBtn").onclick = () => {
  log.length = 0;
  $("logList").innerHTML = "";
};
$("downloadBtn").onclick = () => {
  // Only the exchange with Jev: the exact request body and the raw API response.
  const calls = log.map((e) => ({ request: e.request, response: e.response }));
  const blob = new Blob([JSON.stringify(calls, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "jev-snake-calls.json" });
  a.click();
  URL.revokeObjectURL(a.href);
};

document.addEventListener("keydown", (e) => {
  const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  if (e.code === "Space" && e.target.tagName !== "BUTTON") {
    e.preventDefault();
    running ? stop() : start();
  } else if (map[e.key] && driver === "human") {
    e.preventDefault();
    pendingHumanDir = map[e.key];
    if (!running) start();
  }
});

// ---------- rendering ----------

function drawBoard(c, s, f, size, probs) {
  const cell = size / N;
  c.fillStyle = "#151a1f";
  c.fillRect(0, 0, size, size);
  if (size > 200) {
    c.fillStyle = "#1a2026";
    for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) if ((x + y) % 2) c.fillRect(x * cell, y * cell, cell, cell);
  }
  // food
  c.fillStyle = "#ff7b72";
  c.beginPath();
  c.arc((f.x + 0.5) * cell, (f.y + 0.5) * cell, cell * 0.36, 0, Math.PI * 2);
  c.fill();
  // snake: head bright, body fading
  s.forEach((p, i) => {
    const t = i / Math.max(s.length - 1, 1);
    c.fillStyle = i === 0 ? "#7ee787" : `hsl(135, ${55 - t * 20}%, ${48 - t * 18}%)`;
    const inset = i === 0 ? 1 : 2;
    roundRect(c, p.x * cell + inset, p.y * cell + inset, cell - inset * 2, cell - inset * 2, cell * 0.25);
  });
  // Jev's probabilities over the candidate squares
  if (probs) {
    for (const m of probs) {
      if (!inBounds(m.next)) continue; // wall moves have no square to shade
      const { x: cx, y: cy } = m.next;
      c.fillStyle = m.chosen ? `rgba(210,168,255,${0.25 + m.p * 0.6})` : `rgba(210,168,255,${0.08 + m.p * 0.5})`;
      if (m.deadly) c.fillStyle = `rgba(255,123,114,${0.2 + m.p * 0.6})`;
      c.fillRect(cx * cell, cy * cell, cell, cell);
      if (m.chosen) {
        c.strokeStyle = "#d2a8ff";
        c.lineWidth = 2;
        c.strokeRect(cx * cell + 1, cy * cell + 1, cell - 2, cell - 2);
      }
      if (size > 200) {
        c.fillStyle = "#e6edf3";
        c.font = `600 ${cell * 0.4}px JetBrains Mono, monospace`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(Math.round(m.p * 100), (cx + 0.5) * cell, (cy + 0.5) * cell);
      }
    }
  }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.roundRect ? c.roundRect(x, y, w, h, r) : c.rect(x, y, w, h);
  c.fill();
}

function render() {
  drawBoard(ctx, snake, food, board.width, lastProbs);
}

function updateStats() {
  $("score").textContent = score;
  $("best").textContent = best;
  $("calls").textContent = totals.calls;
  $("latency").textContent = totals.calls ? Math.round(totals.latency / totals.calls) + "ms" : "–";
  $("tokens").textContent = `${totals.inTok.toLocaleString()} / ${totals.outTok.toLocaleString()}`;
}

function showOverlay(title, sub = "") {
  const o = $("overlay");
  o.innerHTML = `<div>${escapeHtml(title)}<small>${escapeHtml(sub)}</small></div>`;
  o.classList.remove("hidden");
}
function hideOverlay() {
  $("overlay").classList.add("hidden");
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- call log ----------

function addLogEntry(e) {
  const list = $("logList");
  list.querySelector(".latest")?.classList.remove("latest");

  const li = document.createElement("li");
  li.className = "call latest" + (e.ok ? "" : " error");

  const thumb = document.createElement("canvas");
  thumb.width = thumb.height = 144;
  const probs = e.ok ? e.moves.map((m) => ({ ...m, p: e.probabilities[m.dir] ?? 0, chosen: m.dir === e.choice })) : null;
  drawBoard(thumb.getContext("2d"), e.snapshot.snake, e.snapshot.food, 144, probs);

  const usage = e.response?.usage;
  const head = `
    <div class="call-head">
      <span class="n">#${e.n}</span>
      ${e.ok ? `<span class="pick">${ARROWS[e.choice]} ${e.choice}</span><span>conf ${e.confidence.toFixed(2)}</span>` : `<span class="flag">error</span>`}
      ${e.latency_ms != null ? `<span>${e.latency_ms}ms</span>` : ""}
      ${e.retries?.length ? `<span class="retry" title="${escapeHtml(e.retries.map((r) => r.error?.error_type || r.error?.message || r.status).join(", "))}">↻ ${e.retries.length} retr${e.retries.length > 1 ? "ies" : "y"}</span>` : ""}
      ${usage ? `<span>${usage.input_tokens}→${usage.output_tokens} tok</span>` : ""}
      ${e.choseDeadly ? `<span class="flag">⚠ chose a deadly move</span>` : ""}
    </div>`;

  const order = Object.keys(e.request.questions.next_move.criteria);
  const opts = e.ok
    ? `<div class="opts">${order
        .map((d) => {
          const m = e.moves.find((x) => x.dir === d);
          const p = e.probabilities[d] ?? 0;
          return `<div class="opt ${d === e.choice ? "chosen" : ""} ${m.deadly ? "deadly" : ""}">
            <span class="name">${ARROWS[d]} ${d}</span><span class="bar"><i style="width:${(p * 100).toFixed(1)}%"></i></span><span class="pct">${(p * 100).toFixed(1)}%</span>
          </div><div class="desc">${"sees: " + escapeHtml(e.request.state.what_the_snake_sees[d])}</div>`;
        })
        .join("")}<div class="desc food">${escapeHtml(e.request.state.food)}</div></div>`
    : `<div class="desc" style="margin-left:0">${escapeHtml(typeof e.error === "string" ? e.error : JSON.stringify(e.error))}</div>`;

  const details = `
    <div class="details">
      <h4>State</h4><pre>${escapeHtml(JSON.stringify(e.request.state, null, 2))}</pre>
      <h4>Question</h4><pre>${escapeHtml(JSON.stringify(e.request.questions, null, 2))}</pre>
      <h4>Jev response</h4><pre>${escapeHtml(JSON.stringify(e.response ?? e.error, null, 2))}</pre>
    </div>`;

  li.innerHTML = `<div class="thumb"></div><div>${head}${opts}</div>${details}`;
  li.querySelector(".thumb").appendChild(thumb);
  li.onclick = (ev) => {
    if (ev.target.closest(".details")) return;
    li.classList.toggle("open");
  };
  list.prepend(li);
  while (list.children.length > 150) list.lastChild.remove();
}

// ---------- boot ----------

fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => {
    const tag = $("modelTag");
    tag.textContent = cfg.hasKey ? `model: ${cfg.model}` : "no API key — add TYPESAFE_API_KEY to .env";
    tag.classList.toggle("bad", !cfg.hasKey);
  })
  .catch(() => {});

reset();
