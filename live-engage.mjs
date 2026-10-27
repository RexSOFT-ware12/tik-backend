// live-engage.mjs — engagement engine for the TikTok LIVE AI host.
//
// Dependency-free on purpose (no mongoose / network imports) so it can be unit-tested.
// live-host.mjs wires it to MongoDB, the LLM and the TikTok connector through `deps`.
//
// What lives here:
//   • chat games: trivia, riddle, guess-the-number, word chain (+ scoring)
//   • gift tiers, gift combos (streak merging), gift goals with rewards
//   • crown (top gifter), gifter perks (priority replies, "!pick" requests)
//   • show clock (timed segments + teasers) and idle engagement
//   • overlay state for the full-screen avatar HUD
//
// Rules the engine follows: it thanks and rewards, it never asks viewers to send gifts.

const MIN = 60000;

export const GAME_TYPES = ['trivia', 'riddle', 'guess_number', 'word_chain'];
export const GAME_TITLES = { trivia: 'Trivia', riddle: 'Riddle', guess_number: 'Guess the number', word_chain: 'Word chain' };
export const SEGMENT_KINDS = [...GAME_TYPES, 'announce', 'leaderboard', 'finale'];
export const IDLE_TYPES = ['question', 'joke', 'shoutout', 'goal', 'crown', 'teaser'];

export const DEFAULT_CONFIG = {
  tiers: [
    { name: 'Small', min: 1 },
    { name: 'Nice', min: 30 },
    { name: 'Big', min: 100 },
    { name: 'Epic', min: 500 },
    { name: 'Legendary', min: 2000 },
  ],
  gifterPerk: { minutes: 15, pickMinDiamonds: 10 },
  crown: { enabled: true },
  goals: [
    { id: 'goal-rose', title: 'Rose goal', giftName: 'Rose', unit: 'gifts', target: 10, progress: 0, hits: 0, repeat: true, active: true,
      reward: 'The host does a happy dance and tells a short funny story' },
  ],
  showClock: {
    enabled: true,
    teaserEveryMinutes: 5,
    teaserText: 'Stay with me, the best part is still coming!',
    segments: [
      { id: 's-trivia', atMinute: 3, kind: 'trivia', title: 'Trivia time', text: '', topic: '' },
      { id: 's-riddle', atMinute: 8, kind: 'riddle', title: 'Riddle round', text: '', topic: '' },
      { id: 's-guess', atMinute: 13, kind: 'guess_number', title: 'Guess the number', text: '', topic: '' },
      { id: 's-chain', atMinute: 18, kind: 'word_chain', title: 'Word chain', text: '', topic: '' },
      { id: 's-board', atMinute: 23, kind: 'leaderboard', title: 'Leaderboard check', text: '', topic: '' },
      { id: 's-finale', atMinute: 30, kind: 'finale', title: 'Finale surprise', text: 'A special thank-you moment for tonight\'s top fans', topic: '' },
    ],
  },
  idle: { enabled: true, seconds: 40, types: [...IDLE_TYPES] },
  games: { answerSeconds: 45, guessMax: 100, wordChainMaxWords: 12 },
  multilingual: { enabled: true, languages: ['English', 'Spanish', 'French', 'Portuguese', 'German', 'Arabic', 'Hindi', 'Indonesian', 'Swahili'] },
};

// ── tiny helpers ──────────────────────────────────────────────────────────────
const clamp = (n, lo, hi, d) => { n = Number(n); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const bool = (v, d) => (v === undefined || v === null ? d : v === true || v === 'true' || v === 1 || v === '1');
const uid = () => Math.random().toString(36).slice(2, 9);
const clone = (o) => JSON.parse(JSON.stringify(o));

/** lowercase, no accents, no punctuation, no leading article — for answer matching. */
export function norm(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(the|a|an)\s+/, '');
}

export function matchAnswer(text, answers) {
  const t = norm(text); if (!t) return false;
  const tokens = t.split(' ');
  for (const raw of answers || []) {
    const a = norm(raw); if (!a) continue;
    if (t === a) return true;
    if (tokens.length > 5) continue;
    if (a.length < 4 ? tokens.includes(a) : ` ${t} `.includes(` ${a} `)) return true;
  }
  return false;
}

export function dayKey(ts, tz = 'UTC') {
  try { return new Date(ts).toLocaleDateString('en-CA', { timeZone: tz }); }
  catch { return new Date(ts).toISOString().slice(0, 10); }
}

/** Mutates a viewer-like object; counts one visit per calendar day and keeps a day streak. */
export function updateStreak(v, ts = Date.now(), tz = 'UTC') {
  const today = dayKey(ts, tz);
  if (v.lastVisitDay === today) return { newDay: false, streak: v.streak || 1 };
  const yesterday = dayKey(ts - 86400000, tz);
  v.streak = v.lastVisitDay === yesterday ? (v.streak || 0) + 1 : 1;
  v.bestStreak = Math.max(v.bestStreak || 0, v.streak);
  v.visitCount = (v.visitCount || 0) + 1;
  v.lastVisitDay = today;
  return { newDay: true, streak: v.streak };
}

export function badgeFor(v = {}) {
  const visits = v.visitCount || 0, streak = v.streak || 0, dia = v.lifetimeDiamonds || 0;
  if (visits >= 10 || streak >= 7 || dia >= 500) return 'Super Fan';
  if (visits >= 3 || streak >= 3) return 'Regular';
  return 'Newcomer';
}

// ── content banks (used when no LLM is available, or the LLM returns junk) ──────
const TRIVIA = [
  ['What is the largest planet in our solar system?', ['Jupiter'], 'It is a gas giant with a famous red spot.'],
  ['How many continents are there on Earth?', ['7', 'seven'], 'It is a lucky number.'],
  ['What is the capital city of Japan?', ['Tokyo'], 'It hosted the Olympics in 2021.'],
  ['Which animal is called the king of the jungle?', ['lion', 'a lion'], 'It has a big mane.'],
  ['How many days are in a leap year?', ['366'], 'One more than a normal year.'],
  ['What color do you get when you mix blue and yellow?', ['green'], 'Think of grass.'],
  ['What is the hardest natural substance on Earth?', ['diamond', 'diamonds'], 'It is also a popular gift!'],
  ['Which planet is known as the Red Planet?', ['Mars'], 'Named after a Roman god of war.'],
  ['Which ocean is the largest?', ['Pacific', 'pacific ocean'], 'It sounds peaceful.'],
  ['How many strings does a standard guitar have?', ['6', 'six'], 'Half a dozen.'],
  ['Which gas do plants absorb from the air?', ['carbon dioxide', 'co2'], 'We breathe it out.'],
  ['Which country gave the Statue of Liberty to the USA?', ['France'], 'Think Eiffel Tower.'],
  ['How many colors are in a rainbow?', ['7', 'seven'], 'Red, orange, yellow...'],
  ['What is the capital of Brazil?', ['Brasilia'], 'It is not Rio.'],
  ['What is the fastest land animal?', ['cheetah'], 'A spotted big cat.'],
  ['Which fruit is said to keep the doctor away?', ['apple', 'an apple'], 'One a day.'],
  ['How many players per team are on the field in soccer?', ['11', 'eleven'], 'More than ten.'],
  ['What is the largest mammal in the world?', ['blue whale', 'whale'], 'It lives in the ocean.'],
];
const RIDDLES = [
  ['What has hands but cannot clap?', ['clock', 'a clock'], 'It tells you something all day.'],
  ['What gets wetter the more it dries?', ['towel', 'a towel'], 'You use it after a shower.'],
  ['What has keys but cannot open any locks?', ['piano', 'keyboard'], 'You can play music on it.'],
  ['What can you catch but never throw?', ['cold', 'a cold'], 'Achoo!'],
  ['I am tall when I am young and short when I am old. What am I?', ['candle', 'a candle'], 'I glow at birthday parties.'],
  ['What has to be broken before you can use it?', ['egg', 'an egg'], 'Breakfast!'],
  ['What goes up but never comes down?', ['age', 'your age'], 'Every birthday adds to it.'],
  ['What has many teeth but cannot bite?', ['comb', 'a comb'], 'You use it on your hair.'],
  ['The more of me you take, the more you leave behind. What am I?', ['footsteps', 'steps', 'footstep'], 'Think about walking.'],
  ['What runs but never walks?', ['river', 'water', 'a river'], 'It flows to the sea.'],
  ['What can travel around the world while staying in a corner?', ['stamp', 'a stamp'], 'It goes on an envelope.'],
];
const WORD_SEEDS = ['planet', 'music', 'dance', 'happy', 'smile', 'travel', 'golden', 'night', 'sunset'];

const pickFrom = (arr, rand) => arr[Math.floor(rand() * arr.length)];

export function sanitizeConfig(input = {}, base = DEFAULT_CONFIG) {
  const b = clone(base), i = input && typeof input === 'object' ? input : {};

  let tiers = Array.isArray(i.tiers) ? i.tiers : b.tiers;
  tiers = tiers.map(t => ({ name: str(t?.name, 20), min: clamp(t?.min, 0, 10_000_000, 0) })).filter(t => t.name)
    .sort((x, y) => x.min - y.min).slice(0, 8);
  if (!tiers.length) tiers = clone(DEFAULT_CONFIG.tiers);

  const goalsIn = Array.isArray(i.goals) ? i.goals : b.goals;
  const goals = goalsIn.slice(0, 12).map(g => ({
    id: str(g?.id, 40) || `goal-${uid()}`,
    title: str(g?.title, 60) || 'Gift goal',
    giftName: str(g?.giftName, 40),
    unit: g?.unit === 'diamonds' ? 'diamonds' : 'gifts',
    target: Math.round(clamp(g?.target, 1, 1_000_000, 10)),
    progress: Math.round(clamp(g?.progress, 0, 1_000_000_000, 0)),
    hits: Math.round(clamp(g?.hits, 0, 1_000_000, 0)),
    repeat: bool(g?.repeat, true),
    active: bool(g?.active, true),
    reward: str(g?.reward, 300),
  }));

  const c = { ...b.showClock, ...(i.showClock || {}) };
  const segIn = Array.isArray(c.segments) ? c.segments : b.showClock.segments;
  const segments = segIn.slice(0, 30).map(s => ({
    id: str(s?.id, 40) || `seg-${uid()}`,
    atMinute: clamp(s?.atMinute, 0, 600, 5),
    kind: SEGMENT_KINDS.includes(s?.kind) ? s.kind : 'announce',
    title: str(s?.title, 60) || 'Next up',
    text: str(s?.text, 300),
    topic: str(s?.topic, 80),
  })).sort((x, y) => x.atMinute - y.atMinute);

  const idleIn = { ...b.idle, ...(i.idle || {}) };
  const idleTypes = (Array.isArray(idleIn.types) ? idleIn.types : b.idle.types).filter(t => IDLE_TYPES.includes(t));

  const ml = { ...b.multilingual, ...(i.multilingual || {}) };
  const langs = (Array.isArray(ml.languages) ? ml.languages : String(ml.languages || '').split(','))
    .map(l => str(l, 30)).filter(Boolean).slice(0, 20);

  return {
    tiers,
    gifterPerk: {
      minutes: clamp(i.gifterPerk?.minutes ?? b.gifterPerk.minutes, 1, 120, 15),
      pickMinDiamonds: clamp(i.gifterPerk?.pickMinDiamonds ?? b.gifterPerk.pickMinDiamonds, 0, 1_000_000, 10),
    },
    crown: { enabled: bool(i.crown?.enabled, b.crown.enabled) },
    goals,
    showClock: {
      enabled: bool(c.enabled, true),
      teaserEveryMinutes: clamp(c.teaserEveryMinutes, 0, 60, 5),
      teaserText: str(c.teaserText, 200),
      segments,
    },
    idle: { enabled: bool(idleIn.enabled, true), seconds: clamp(idleIn.seconds, 15, 300, 40), types: idleTypes.length ? idleTypes : [...IDLE_TYPES] },
    games: {
      answerSeconds: clamp(i.games?.answerSeconds ?? b.games.answerSeconds, 15, 180, 45),
      guessMax: Math.round(clamp(i.games?.guessMax ?? b.games.guessMax, 10, 10000, 100)),
      wordChainMaxWords: Math.round(clamp(i.games?.wordChainMaxWords ?? b.games.wordChainMaxWords, 3, 50, 12)),
    },
    multilingual: { enabled: bool(ml.enabled, true), languages: langs.length ? langs : clone(DEFAULT_CONFIG.multilingual.languages) },
  };
}

// ── engine ────────────────────────────────────────────────────────────────────
/**
 * deps:
 *   emit(event)                  persist a host event (replyText is what the avatar speaks)  [required]
 *   say(prompt, fallback, opts)  LLM text with fallback, never throws                          [optional]
 *   genJson(prompt)              LLM JSON object or null                                       [optional]
 *   saveConfig(cfg)              persist config (goal progress changes often)                  [optional]
 *   onPoints({key,username,points})  persist game points on the viewer                         [optional]
 *   recentViewers()              [{username, streak, badge}] for shout-outs                    [optional]
 *   initialConfig, now, rand, setTimeout, clearTimeout, log                                    [optional]
 */
export function createEngine(deps = {}) {
  const now = deps.now || Date.now;
  const rand = deps.rand || Math.random;
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const log = deps.log || console;
  let cfg = sanitizeConfig(deps.initialConfig || {});

  const st = {
    session: { active: false, id: null, startedAt: 0, endedAt: 0 },
    gifters: new Map(), scorers: new Map(), perks: new Map(), combos: new Map(),
    game: null, lastGameAt: 0,
    lastSpoken: 0, lastIdleAt: 0, idleIdx: 0, lastTeaserAt: 0,
    clockFired: new Set(), currentSegment: null,
    viewers: { count: 0, peak: 0 },
    used: { trivia: new Set(), riddle: new Set() },
    ticking: false, saveTimer: null,
    speech: { speaking: false, queued: 0, at: 0 }, busyUntil: 0, lastEmitAt: 0, starting: false,
  };

  // ── config ──
  const getConfig = () => clone(cfg);
  const loadConfig = (obj) => { cfg = sanitizeConfig(obj || {}, DEFAULT_CONFIG); return getConfig(); };
  function persist() {
    if (!deps.saveConfig) return;
    clearT(st.saveTimer);
    st.saveTimer = setT(() => { Promise.resolve(deps.saveConfig(clone(cfg))).catch(e => log.warn?.('saveConfig failed:', e.message)); }, 400);
    st.saveTimer?.unref?.();
  }
  function updateConfig(partial = {}) {
    const next = { ...cfg };
    for (const k of ['tiers', 'gifterPerk', 'crown', 'showClock', 'idle', 'games', 'multilingual']) if (partial[k] !== undefined) next[k] = partial[k];
    cfg = sanitizeConfig(next, cfg); // goals are managed through the goal functions so progress is never wiped
    persist();
    return getConfig();
  }
  function upsertGoal(goal = {}) {
    const clean = sanitizeConfig({ goals: [goal] }, { ...cfg, goals: [] }).goals[0];
    const i = cfg.goals.findIndex(g => g.id === clean.id);
    if (i >= 0) { clean.progress = goal.progress === undefined ? cfg.goals[i].progress : clean.progress; clean.hits = cfg.goals[i].hits; cfg.goals[i] = clean; }
    else { if (cfg.goals.length >= 12) return null; cfg.goals.push(clean); }
    persist(); return clone(clean);
  }
  function deleteGoal(id) { const n = cfg.goals.length; cfg.goals = cfg.goals.filter(g => g.id !== id); if (cfg.goals.length !== n) persist(); return cfg.goals.length !== n; }
  function resetGoal(id) { const g = cfg.goals.find(x => x.id === id); if (!g) return null; g.progress = 0; g.active = true; persist(); return clone(g); }

  // ── session ──
  function startSession({ resetGoals = false } = {}) {
    st.session = { active: true, id: uid(), startedAt: now(), endedAt: 0 };
    st.gifters.clear(); st.scorers.clear(); st.perks.clear(); st.clockFired.clear();
    st.currentSegment = null; st.game = null; st.lastTeaserAt = now(); st.lastSpoken = now(); st.lastIdleAt = now();
    st.viewers.peak = st.viewers.count;
    if (resetGoals) { for (const g of cfg.goals) { g.progress = 0; g.active = true; } persist(); }
    return { ...st.session };
  }
  function stopSession() { st.session.active = false; st.session.endedAt = now(); st.game = null; return { ...st.session }; }
  const sessionInfo = () => ({ ...st.session, elapsedSeconds: st.session.active ? Math.floor((now() - st.session.startedAt) / 1000) : 0 });
  function setViewerCount(n) { n = Number(n); if (!Number.isFinite(n) || n < 0) return; st.viewers.count = n; st.viewers.peak = Math.max(st.viewers.peak, n); }
  /** Rough speaking time, so the host never stacks new filler lines on top of lines still being read. */
  const estimateSpeechMs = (text) => 1500 + Math.round((String(text || '').trim().split(/\s+/).filter(Boolean).length / 2.4) * 1000);
  function markSpoken(text) {
    const t = now();
    st.lastSpoken = t; st.lastEmitAt = t;
    st.busyUntil = Math.min(Math.max(st.busyUntil, t) + estimateSpeechMs(text), t + 45000);
  }
  const noteSpoken = (text) => markSpoken(text);
  /** Avatar Studio reports whether it is speaking and how many lines are waiting (sent with every poll). */
  function setSpeechState({ speaking = false, queued = 0 } = {}) { st.speech = { speaking: Boolean(speaking), queued: Math.max(0, Number(queued) || 0), at: now() }; }
  /** True while the avatar is (or is about to be) talking. Uses the Studio's report when fresh, an estimate otherwise. */
  function isBusy() {
    const t = now(), fresh = t - st.speech.at < 8000;
    if (fresh && (st.speech.speaking || st.speech.queued > 0)) return true;
    if (fresh && t - st.lastEmitAt > 6000) st.busyUntil = 0; // Studio has had time to pick the lines up and says it is idle
    return t < st.busyUntil;
  }

  // ── speech helpers ──
  const say = async (prompt, fallback, opts) => {
    if (!deps.say) return fallback;
    try { return (await deps.say(prompt, fallback, opts)) || fallback; } catch { return fallback; }
  };
  function currentSegmentLabel() {
    if (st.game && !st.game.ended) return `game:${st.game.type}`;
    if (st.currentSegment && now() < st.currentSegment.until) return st.currentSegment.title;
    return 'free chat';
  }
  async function speak(ev) {
    markSpoken(ev.replyText);
    try { await deps.emit({ segment: currentSegmentLabel(), ...ev }); } catch (e) { log.warn?.('emit failed:', e.message); }
  }

  // ── leaderboards ──
  const board = (map, field, n = 5) => [...map.values()].sort((a, b) => b[field] - a[field]).slice(0, n);
  const king = () => { const [top] = board(st.gifters, 'diamonds', 1); return top && top.diamonds > 0 ? top : null; };
  function leaderboards() {
    const gifters = board(st.gifters, 'diamonds').map(g => ({ username: g.username, diamonds: g.diamonds, gifts: g.gifts }));
    const scorers = board(st.scorers, 'points').map(s => ({ username: s.username, points: s.points, wins: s.wins }));
    return { gifters, scorers };
  }
  function award(m, points) {
    const s = st.scorers.get(m.key) || { key: m.key, username: m.username, points: 0, wins: 0 };
    s.username = m.username || s.username; s.points += points; st.scorers.set(m.key, s);
    try { deps.onPoints?.({ key: m.key, username: m.username, points }); } catch { /* ignore */ }
    return s;
  }

  // ── gifts: combos, tiers, goals, crown, perks ──
  /** Merge TikTok gift streaks so a x20 combo is ONE reaction at the end, not 20. */
  function pushGift(g, onFire) {
    const count = Math.max(1, Number(g.repeatCount) || 1);
    if (!g.streakable) return onFire({ ...g, repeatCount: count });
    const id = `${g.key}|${g.giftId || g.giftName}`;
    let e = st.combos.get(id);
    if (!e) { e = { ...g, id, count: 0, timer: null }; st.combos.set(id, e); }
    e.count = Math.max(e.count, count); e.diamonds = g.diamonds || e.diamonds; e.username = g.username || e.username;
    clearT(e.timer);
    const flush = () => { st.combos.delete(id); return onFire({ ...e, repeatCount: e.count }); };
    if (g.repeatEnd) return flush();
    e.timer = setT(() => { Promise.resolve(flush()).catch(err => log.warn?.('combo flush failed:', err.message)); }, 5000);
    e.timer?.unref?.();
    return null;
  }

  function registerGift(g) {
    const count = Math.max(1, Number(g.repeatCount) || 1);
    const unit = Math.max(0, Number(g.diamonds) || 0);
    const total = unit * count;
    const tiers = cfg.tiers;
    let tierIdx = 0; for (let i = 0; i < tiers.length; i++) if (total >= tiers[i].min) tierIdx = i;
    const tier = tiers[tierIdx].name;
    const basePriority = 60 + Math.round(40 * tierIdx / Math.max(1, tiers.length - 1));

    const prevKing = king();
    const e = st.gifters.get(g.key) || { key: g.key, username: g.username, diamonds: 0, gifts: 0 };
    e.username = g.username || e.username; e.diamonds += total; e.gifts += count; st.gifters.set(g.key, e);
    const newKing = king();
    let crownChange = null;
    if (cfg.crown.enabled && newKing?.key === g.key && prevKing && prevKing.key !== g.key) {
      crownChange = { from: prevKing.username, to: e.username, diamonds: e.diamonds };
    }

    const old = st.perks.get(g.key) || { picks: 0 };
    const perk = {
      until: now() + cfg.gifterPerk.minutes * MIN,
      picks: Math.min(3, (old.picks || 0) + (unit === 0 || total >= cfg.gifterPerk.pickMinDiamonds ? 1 : 0)),
      tier,
    };
    st.perks.set(g.key, perk);

    const goalHits = []; let goalTouched = false;
    for (const goal of cfg.goals) {
      if (!goal.active) continue;
      if (goal.giftName && norm(goal.giftName) !== norm(g.giftName)) continue;
      const add = goal.unit === 'diamonds' ? total : count;
      if (add <= 0) continue;
      goalTouched = true; goal.progress += add;
      let guard = 0;
      while (goal.progress >= goal.target && guard++ < 5) {
        goalHits.push({ id: goal.id, title: goal.title, reward: goal.reward, target: goal.target });
        goal.hits = (goal.hits || 0) + 1;
        if (goal.repeat) goal.progress -= goal.target; else { goal.progress = goal.target; goal.active = false; break; }
      }
      if (goal.repeat && goal.progress >= goal.target) goal.progress %= goal.target;
    }
    if (goalTouched) persist();

    const priority = Math.max(basePriority, goalHits.length ? 85 : 0, crownChange ? 75 : 0);
    return { ...g, repeatCount: count, total, tier, tierIdx, tiersCount: tiers.length, priority, isKing: newKing?.key === g.key, crownChange, goalHits, perk };
  }

  /** Called AFTER the gift thank-you was saved, so the order is: thanks → goal reward → crown. */
  async function afterGift(info) {
    for (const hit of info.goalHits || []) {
      const fallback = `We did it! ${hit.title} is complete! Thank you all so much!${hit.reward ? ` ${hit.reward}!` : ''}`;
      const text = await say(
        `The community goal "${hit.title}" was just completed with help from @${info.username}'s gift! Celebrate with everyone, then fulfil the reward: ${hit.reward || 'a big thank-you to everyone'}. Fun, family-friendly, under 4 sentences. Do not ask for more gifts.`,
        fallback, { kind: 'goal', maxTokens: 220 });
      await speak({ type: 'goal_reached', username: info.username, text: hit.title, replyText: text, reactionType: 'goal', priority: info.priority,
        overlay: { kind: 'goal', title: 'Goal reached!', subtitle: hit.title, reward: hit.reward } });
    }
    if (info.crownChange) {
      const { from, to } = info.crownChange;
      const text = await say(
        `@${to} just took the gift crown from @${from}! Announce it with playful rivalry, then cheer on @${from}. Never ask anyone to send gifts. Two sentences max.`,
        `Plot twist! @${to} takes the crown from @${from}! What a battle!`, { kind: 'crown', maxTokens: 120 });
      await speak({ type: 'crown_change', username: to, text: `${to} took the crown from ${from}`, replyText: text, reactionType: 'crown', priority: info.priority,
        overlay: { kind: 'crown', title: `@${to} takes the crown`, subtitle: `from @${from}` } });
    }
  }

  const perkFor = (key) => {
    const p = st.perks.get(key);
    return p && now() < p.until ? { active: true, picks: p.picks || 0, tier: p.tier, until: p.until } : { active: false, picks: 0 };
  };

  // ── games ──
  async function makeQA(type, topic) {
    const bank = type === 'trivia' ? TRIVIA : RIDDLES;
    if (deps.genJson) {
      const j = await deps.genJson(
        `Create one ${type === 'trivia' ? 'trivia question' : 'riddle'} for a TikTok LIVE audience${topic ? ` about "${topic}"` : ''}. ` +
        `Family-friendly, with ONE clear correct answer of 1-3 words that viewers can type in chat. ` +
        `Return JSON only: {"question":"...","answer":"...","aliases":["..."],"hint":"a hint that does NOT reveal the answer"}`).catch(() => null);
      const q = str(j?.question, 220), a = str(j?.answer, 40);
      if (q.length >= 10 && a) {
        const aliases = (Array.isArray(j.aliases) ? j.aliases : []).map(x => str(x, 40)).filter(Boolean).slice(0, 8);
        return { question: q, answers: [a, ...aliases], hint: str(j.hint, 160) };
      }
    }
    const used = st.used[type]; let idx = [...bank.keys()].filter(i => !used.has(i));
    if (!idx.length) { used.clear(); idx = [...bank.keys()]; }
    const i = pickFrom(idx, rand); used.add(i);
    const [question, answers, hint] = bank[i];
    return { question, answers, hint };
  }

  async function startGame(type, opts = {}) {
    if (!GAME_TYPES.includes(type)) return { ok: false, error: 'Unknown game type.' };
    if ((st.game && !st.game.ended) || st.starting) return { ok: false, error: 'A game is already running. Stop it first.' };
    st.starting = true;
    const t = now(), secs = cfg.games.answerSeconds;
    let g, intro;
    try {
    g = { id: uid(), type, startedAt: t, ended: false, attempts: 0, topic: str(opts.topic, 80), by: opts.by || 'admin', hintGiven: false };
    if (type === 'trivia' || type === 'riddle') {
      Object.assign(g, await makeQA(type, g.topic), { points: type === 'trivia' ? 100 : 150, endsAt: t + secs * 1000, hintAt: t + secs * 550 });
      intro = `${type === 'trivia' ? 'Trivia time!' : 'Riddle time!'} ${g.question} Type your answer in the chat!`;
    } else if (type === 'guess_number') {
      g.max = cfg.games.guessMax; g.target = 1 + Math.floor(rand() * g.max); g.low = 0; g.high = g.max + 1; g.points = 200;
      g.endsAt = t + Math.min(180, secs * 2) * 1000; g.pendingHint = false; g.lastHintAt = t;
      intro = `Let's play guess the number! I'm thinking of a number between 1 and ${g.max}. Type your guess in the chat!`;
    } else {
      g.current = pickFrom(WORD_SEEDS, rand); g.nextLetter = g.current.slice(-1); g.used = new Set([g.current]); g.chain = []; g.lastKey = null;
      g.max = cfg.games.wordChainMaxWords; g.points = 10; g.chainSeconds = 40; g.endsAt = t + g.chainSeconds * 1000;
      intro = `Word chain! I'll start with "${g.current}". Reply with a word that starts with the letter "${g.nextLetter.toUpperCase()}"! Each new word scores points.`;
    }
    // The question may have taken a few seconds to write: start the clock now, not when the request began.
    const shift = now() - t;
    if (shift > 0) for (const k of ['startedAt', 'endsAt', 'hintAt', 'lastHintAt']) if (g[k]) g[k] += shift;
    st.game = g; st.lastGameAt = t;
    } finally { st.starting = false; }
    await speak({ type: 'game_start', username: 'Host', text: GAME_TITLES[type], replyText: intro, reactionType: 'thinking', priority: 80, segment: `game:${type}` });
    return { ok: true, game: gameAdmin() };
  }

  async function winRound(m, g) {
    if (g.ended) return; g.ended = true;
    const elapsed = now() - g.startedAt, total = Math.max(1, g.endsAt - g.startedAt);
    const bonus = Math.round(50 * Math.max(0, 1 - elapsed / total)), pts = g.points + bonus;
    const s = award(m, pts); s.wins += 1;
    const answer = g.type === 'guess_number' ? String(g.target) : g.answers[0];
    const lines = [
      `@${m.username} got it! The answer is ${answer}. That's ${pts} points!`,
      `Yes! @${m.username} nailed it! It was ${answer}. Plus ${pts} points!`,
      `We have a winner: @${m.username}! The answer was ${answer}. ${pts} points for you!`,
    ];
    st.game = null; st.lastGameAt = now();
    await speak({ type: 'game_win', username: m.username, text: `${GAME_TITLES[g.type]}: ${answer}`, replyText: pickFrom(lines, rand), reactionType: 'win', priority: 82,
      segment: `game:${g.type}`, overlay: { kind: 'win', title: `@${m.username} got it!`, subtitle: `+${pts} pts · ${answer}` } });
  }

  async function endGame(reason = 'timeout') {
    const g = st.game; if (!g || g.ended) return false; g.ended = true;
    let line;
    if (g.type === 'word_chain') {
      const counts = {}; for (const c of g.chain) counts[c.username] = (counts[c.username] || 0) + 1;
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      line = g.chain.length
        ? `Word chain over! Together we built a chain of ${g.chain.length} words.${top ? ` Star player: @${top[0]} with ${top[1]}!` : ''} Great teamwork!`
        : 'Nobody continued the word chain this time, but we will try again soon!';
    } else if (g.type === 'guess_number') {
      line = `Time's up! The number was ${g.target}. So close! We will play again soon.`;
    } else {
      line = `Time's up! The answer was ${g.answers[0]}. Better luck next round!`;
    }
    st.game = null; st.lastGameAt = now();
    await speak({ type: 'game_end', username: 'Host', text: `${GAME_TITLES[g.type]} ended (${reason})`, replyText: line, reactionType: g.chain?.length ? 'win' : 'thinking', priority: 78, segment: `game:${g.type}` });
    return true;
  }

  async function gameChat(m, text) {
    const g = st.game; if (!g || g.ended) return null;
    const words = text.split(/\s+/).filter(Boolean);
    if (g.type === 'trivia' || g.type === 'riddle') {
      if (words.length > 6 || text.includes('?')) return null; // a real conversation, not an attempt
      g.attempts++;
      if (matchAnswer(text, g.answers)) await winRound(m, g);
      return { consumed: true };
    }
    if (g.type === 'guess_number') {
      const mm = text.match(/^\s*#?(\d{1,6})\s*$/); if (!mm) return null;
      const n = Number(mm[1]); g.attempts++;
      if (n < 1 || n > g.max) return { consumed: true };
      if (n === g.target) { await winRound(m, g); return { consumed: true }; }
      if (n < g.target) g.low = Math.max(g.low, n); else g.high = Math.min(g.high, n);
      g.pendingHint = true; g.lastGuess = { n, username: m.username };
      return { consumed: true };
    }
    // word chain
    if (!/^[a-zA-Z]{3,20}$/.test(text.trim())) return null;
    const w = text.trim().toLowerCase(); g.attempts++;
    const ok = w[0] === g.nextLetter && !g.used.has(w) && /[aeiouy]/.test(w) && m.key !== g.lastKey;
    if (!ok) return { consumed: true };
    g.used.add(w); g.chain.push({ word: w, username: m.username }); g.current = w; g.nextLetter = w.slice(-1); g.lastKey = m.key;
    g.endsAt = now() + g.chainSeconds * 1000;
    award(m, g.points);
    if (g.chain.length >= g.max) { await endGame('complete'); return { consumed: true }; }
    if (g.chain.length % 3 === 0) {
      await speak({ type: 'game_hint', username: m.username, text: w, reactionType: 'win', priority: 70, segment: 'game:word_chain',
        replyText: `"${w}" from @${m.username}! The chain is ${g.chain.length} words long. Next word starts with "${g.nextLetter.toUpperCase()}"!` });
    }
    return { consumed: true };
  }

  /** Called for every chat comment BEFORE the normal AI reply. */
  async function handleChat(m) {
    const text = str(m.text, 300);
    const out = { consumed: false, priority: 20, perk: null };
    const perk = perkFor(m.key);
    if (perk.active) { out.priority = 70; out.perk = perk; }
    const pm = text.match(/^!pick\s+(.{3,120})$/i);
    if (pm && perk.picks > 0) {
      st.perks.get(m.key).picks -= 1;
      return { ...out, consumed: true, special: pm[1].trim(), priority: 85 };
    }
    if (st.game) { const r = await gameChat(m, text); if (r) return { ...out, ...r }; }
    return out;
  }

  const guessHint = (g) => `The number is between ${g.low + 1} and ${g.high - 1}.`;
  function gameAdmin() {
    const g = st.game; if (!g) return null;
    return { ...gamePublic(), answer: g.type === 'guess_number' ? g.target : g.type === 'word_chain' ? null : g.answers?.[0] };
  }
  function gamePublic() {
    const g = st.game; if (!g || g.ended) return null;
    const total = Math.round((g.endsAt - g.startedAt) / 1000);
    const base = { id: g.id, type: g.type, title: GAME_TITLES[g.type], secondsLeft: Math.max(0, Math.ceil((g.endsAt - now()) / 1000)), totalSeconds: total, attempts: g.attempts, points: g.points };
    if (g.type === 'guess_number') return { ...base, prompt: `Guess a number from 1 to ${g.max}`, bounds: { low: g.low + 1, high: g.high - 1 } };
    if (g.type === 'word_chain') return { ...base, prompt: `Next word starts with "${g.nextLetter.toUpperCase()}"`, current: g.current, chain: g.chain.length, maxChain: g.max, lastWords: g.chain.slice(-4).map(c => c.word) };
    return { ...base, prompt: g.question, hint: g.hintGiven ? g.hintText : '' };
  }

  // ── show clock + idle ──
  function nextSegment(t = now()) {
    if (!st.session.active) return null;
    const elapsedSec = (t - st.session.startedAt) / 1000;
    const seg = cfg.showClock.segments.find(s => !st.clockFired.has(s.id));
    return seg ? { id: seg.id, title: seg.title, kind: seg.kind, inSeconds: Math.max(0, Math.round(seg.atMinute * 60 - elapsedSec)) } : null;
  }

  async function announceLeaderboard() {
    const { gifters, scorers } = leaderboards(); const k = king();
    const parts = [];
    if (scorers.length) parts.push(`Top players: ${scorers.slice(0, 3).map(s => `@${s.username} with ${s.points} points`).join(', ')}.`);
    if (k) parts.push(`The crown is worn by @${k.username}.`);
    const fallback = parts.length ? `Leaderboard time! ${parts.join(' ')} Keep playing, anyone can climb!` : 'Leaderboard time! No scores yet, so the next game is wide open!';
    await speak({ type: 'segment', username: 'Host', text: 'Leaderboard', replyText: fallback, reactionType: 'surprise', priority: 70,
      overlay: { kind: 'leaderboard', title: 'Leaderboard', subtitle: scorers[0] ? `@${scorers[0].username} leads` : '' } });
    void gifters;
  }

  async function runSegment(seg) {
    st.currentSegment = { title: seg.title, until: now() + 4 * MIN };
    if (GAME_TYPES.includes(seg.kind)) { await startGame(seg.kind, { topic: seg.topic, by: 'clock' }); return; }
    if (seg.kind === 'leaderboard') { await announceLeaderboard(); return; }
    if (seg.kind === 'finale') {
      const { scorers } = leaderboards(); const k = king();
      const names = [k && `crown holder @${k.username}`, scorers[0] && `top player @${scorers[0].username}`].filter(Boolean).join(' and ');
      const fb = `This is our finale moment! Thank you all for being here tonight${names ? `, and a special shout-out to ${names}` : ''}. You are amazing!`;
      const text = await say(`It's the finale moment of the show: ${seg.text || 'thank the community'}. Warmly thank everyone${names ? ` and celebrate ${names}` : ''}. Do not ask for gifts. Three sentences max.`, fb, { kind: 'finale', maxTokens: 180 });
      await speak({ type: 'segment', username: 'Host', text: seg.title, replyText: text, reactionType: 'surprise', priority: 78,
        overlay: { kind: 'finale', title: seg.title, subtitle: names } });
      return;
    }
    await speak({ type: 'segment', username: 'Host', text: seg.title, replyText: seg.text || seg.title, reactionType: 'surprise', priority: 70,
      overlay: { kind: 'segment', title: seg.title, subtitle: '' } });
  }

  async function clockTick(t) {
    const c = cfg.showClock; if (!c.enabled) return;
    const elapsedMin = (t - st.session.startedAt) / MIN;
    for (const seg of c.segments) {
      if (st.clockFired.has(seg.id)) continue;
      if (seg.atMinute > elapsedMin) break;
      const late = elapsedMin - seg.atMinute;
      // Never talk over a running game; give up on filler segments that are far too late.
      if (st.game || st.starting) { if (late > 4 && seg.kind !== 'finale') st.clockFired.add(seg.id); return; }
      // Give the avatar a moment to finish what it is saying (up to a minute), then go ahead.
      if (isBusy() && late < 1) return;
      st.clockFired.add(seg.id);
      await runSegment(seg);
      return;
    }
    const every = c.teaserEveryMinutes * MIN;
    if (every > 0 && !st.game && !st.starting && !isBusy() && t - st.lastTeaserAt >= every && t - st.lastSpoken > 6000) {
      const next = nextSegment(t);
      if (next && next.inSeconds <= 12 * 60) {
        st.lastTeaserAt = t;
        const mins = Math.max(1, Math.round(next.inSeconds / 60));
        const fb = `In about ${mins} minute${mins > 1 ? 's' : ''}: ${next.title}! Stay with me, you won't want to miss it!`;
        const stamp = st.lastSpoken;
        const text = await say(`Tease what's coming in about ${mins} minute(s): "${next.title}". One or two excited sentences that make viewers want to stay. ${c.teaserText}`, fb, { kind: 'teaser', maxTokens: 100 });
        if (st.lastSpoken !== stamp || st.game || st.starting) return; // something else was said while this was being written
        await speak({ type: 'teaser', username: 'Host', text: next.title, replyText: text, reactionType: 'surprise', priority: 40 });
      }
    }
  }

  async function buildIdle(type) {
    if (type === 'question') return { reaction: 'thinking', text: await say('Ask the chat ONE fun, easy-to-answer question that sparks comments (favorites, would-you-rather, quick opinions). One or two short sentences.', 'Quick question for chat: what is your favorite way to relax after a long day? Tell me in the comments!', { kind: 'idle', maxTokens: 90 }) };
    if (type === 'joke') return { reaction: 'funny', text: await say('Tell ONE short, clean, family-friendly joke, then react to it playfully.', 'Why did the scarecrow win an award? Because he was outstanding in his field!', { kind: 'idle', maxTokens: 100 }) };
    if (type === 'shoutout') {
      const list = (await deps.recentViewers?.().catch(() => [])) || []; const v = list.length ? pickFrom(list, rand) : null;
      if (!v?.username) return null;
      const extra = [v.streak > 1 ? `on a ${v.streak}-day streak` : '', v.badge && v.badge !== 'Newcomer' ? `a ${v.badge}` : ''].filter(Boolean).join(', ');
      return { reaction: 'welcome', text: await say(`Give a warm shout-out to @${v.username}${extra ? ` (${extra})` : ''} and ask them one friendly question. Use their username.`, `Shout-out to @${v.username}! So glad you're here. How is your day going?`, { kind: 'idle', maxTokens: 90 }) };
    }
    if (type === 'goal') {
      const g = cfg.goals.find(x => x.active && x.progress > 0 && x.progress < x.target); if (!g) return null;
      return { reaction: 'gift', text: await say(`Casually mention that the goal "${g.title}" is at ${g.progress} of ${g.target}. Thank everyone who has helped so far. NEVER ask or pressure anyone to send gifts.`, `We're at ${g.progress} of ${g.target} for ${g.title}! Thank you to everyone who has helped so far!`, { kind: 'idle', maxTokens: 90 }) };
    }
    if (type === 'crown') {
      const k = king(); if (!k || !cfg.crown.enabled) return null;
      return { reaction: 'surprise', text: await say(`Playfully mention that @${k.username} currently wears the gift crown. Keep it light. NEVER ask or pressure anyone to send gifts.`, `Shout-out to @${k.username}, our current crown holder! You are a star!`, { kind: 'idle', maxTokens: 80 }) };
    }
    if (type === 'teaser') {
      const n = nextSegment(); if (!n || n.inSeconds > 15 * 60) return null;
      const mins = Math.max(1, Math.round(n.inSeconds / 60));
      return { reaction: 'surprise', text: `Coming up in about ${mins} minute${mins > 1 ? 's' : ''}: ${n.title}! Stay with me!` };
    }
    return null;
  }

  async function idleTick(t) {
    const c = cfg.idle; if (!c.enabled || st.game || st.starting || isBusy()) return;
    const gap = c.seconds * 1000;
    if (t - st.lastSpoken < gap || t - st.lastIdleAt < gap) return;
    st.lastIdleAt = t;
    const stamp = st.lastSpoken;
    for (let i = 0; i < c.types.length; i++) {
      const type = c.types[st.idleIdx++ % c.types.length];
      const item = await buildIdle(type);
      if (st.lastSpoken !== stamp || st.game || st.starting) return; // chat, a gift or a game spoke while this line was being written: drop it
      if (item?.text) { await speak({ type: 'idle', username: 'Host', text: type, replyText: item.text, reactionType: item.reaction, priority: 5 }); return; }
    }
  }

  async function tick() {
    if (st.ticking) return; st.ticking = true;
    try {
      const t = now();
      const g = st.game;
      if (g && !g.ended) {
        if (t >= g.endsAt) { await endGame('timeout'); return; }
        if (!g.hintGiven && (g.type === 'trivia' || g.type === 'riddle') && t >= g.hintAt) {
          g.hintGiven = true; g.hintText = g.hint || `It starts with "${g.answers[0][0].toUpperCase()}" and has ${g.answers[0].length} characters.`;
          await speak({ type: 'game_hint', username: 'Host', text: 'hint', replyText: `Here's a hint: ${g.hintText}`, reactionType: 'thinking', priority: 75, segment: `game:${g.type}` });
        } else if (g.type === 'guess_number' && g.pendingHint && t - g.lastHintAt >= 20000) {
          g.pendingHint = false; g.lastHintAt = t;
          await speak({ type: 'game_hint', username: 'Host', text: 'hint', replyText: `${g.lastGuess ? `@${g.lastGuess.username} guessed ${g.lastGuess.n}! ` : ''}${guessHint(g)} Keep guessing!`, reactionType: 'thinking', priority: 75, segment: 'game:guess_number' });
        }
      }
      if (!st.session.active) return;
      await clockTick(t);
      await idleTick(t);
    } finally { st.ticking = false; }
  }

  // ── overlay state for the HUD ──
  function overlayState() {
    const k = king(); const second = board(st.gifters, 'diamonds', 2)[1];
    const { gifters, scorers } = leaderboards();
    return {
      session: sessionInfo(),
      viewers: { ...st.viewers },
      goals: cfg.goals.filter(g => g.active).map(g => ({ id: g.id, title: g.title, progress: g.progress, target: g.target, unit: g.unit, giftName: g.giftName, reward: g.reward, pct: Math.min(100, Math.round(100 * g.progress / g.target)) })),
      king: k && cfg.crown.enabled ? { username: k.username, diamonds: k.diamonds, lead: second ? k.diamonds - second.diamonds : k.diamonds } : null,
      gifters, scorers,
      game: gamePublic(),
      next: nextSegment(),
      combos: [...st.combos.values()].map(c => ({ username: c.username, giftName: c.giftName, count: c.count })),
    };
  }

  return {
    getConfig, loadConfig, updateConfig, upsertGoal, deleteGoal, resetGoal,
    startSession, stopSession, sessionInfo, setViewerCount, noteSpoken, setSpeechState, isBusy,
    pushGift, registerGift, afterGift, perkFor,
    startGame, endGame, handleChat, gameAdmin,
    tick, overlayState, leaderboards, nextSegment, currentSegmentLabel,
    _state: st,
  };
}

// ── analytics (pure: takes already-loaded events and viewer-count samples) ───────
const VIEWER_EVENTS = new Set(['chat', 'screen_comment', 'join', 'gift', 'follow', 'like_milestone', 'special_request']);

export function buildAnalytics(events = [], samples = [], since = new Date(Date.now() - 6 * 3600e3), nowMs = Date.now()) {
  const sinceMs = since.getTime();
  const span = Math.max(60000, nowMs - sinceMs);
  const bucketMs = span <= 2 * 3600e3 ? 2 * 60000 : span <= 8 * 3600e3 ? 5 * 60000 : 15 * 60000;
  const t0 = Math.floor(sinceMs / bucketMs) * bucketMs;
  const nb = Math.min(400, Math.floor((nowMs - t0) / bucketMs) + 1);
  const buckets = Array.from({ length: nb }, (_, i) => ({ t: t0 + i * bucketMs, comments: 0, joins: 0, gifts: 0, diamonds: 0, follows: 0, vSum: 0, vN: 0, viewers: null }));
  const at = (ms) => buckets[Math.min(nb - 1, Math.max(0, Math.floor((ms - t0) / bucketMs)))];

  const totals = { comments: 0, joins: 0, gifts: 0, diamonds: 0, follows: 0, uniqueChatters: 0, uniqueGifters: 0, gamesStarted: 0, gameWins: 0, goalsReached: 0, crownChanges: 0, specialRequests: 0 };
  const chatters = new Map(), gifters = new Map(), segs = new Map();
  const seg = (name) => { const k = name || 'free chat'; if (!segs.has(k)) segs.set(k, { name: k, comments: 0, joins: 0, gifts: 0, diamonds: 0, follows: 0, vSum: 0, vN: 0 }); return segs.get(k); };

  for (const e of events) {
    const ms = new Date(e.createdAt).getTime(); if (!Number.isFinite(ms)) continue;
    if (!VIEWER_EVENTS.has(e.type)) {
      if (e.type === 'game_start') totals.gamesStarted++;
      else if (e.type === 'game_win') totals.gameWins++;
      else if (e.type === 'goal_reached') totals.goalsReached++;
      else if (e.type === 'crown_change') totals.crownChanges++;
      continue;
    }
    const b = at(ms), sg = seg(e.segment), name = e.username || 'Viewer';
    if (e.type === 'chat' || e.type === 'screen_comment') { totals.comments++; b.comments++; sg.comments++; chatters.set(name, (chatters.get(name) || 0) + 1); }
    else if (e.type === 'special_request') { totals.specialRequests++; totals.comments++; b.comments++; sg.comments++; }
    else if (e.type === 'join') { totals.joins++; b.joins++; sg.joins++; }
    else if (e.type === 'follow') { totals.follows++; b.follows++; sg.follows++; }
    else if (e.type === 'gift') {
      const d = Number(e.diamonds) || 0, n = Number(e.repeatCount) || 1;
      totals.gifts += n; totals.diamonds += d; b.gifts += n; b.diamonds += d; sg.gifts += n; sg.diamonds += d;
      const g = gifters.get(name) || { username: name, gifts: 0, diamonds: 0 }; g.gifts += n; g.diamonds += d; gifters.set(name, g);
    }
  }
  totals.uniqueChatters = chatters.size; totals.uniqueGifters = gifters.size;

  let peak = { viewers: 0, at: null }, vTotal = 0;
  for (const s of samples) {
    const ms = new Date(s.at).getTime(), v = Number(s.viewers); if (!Number.isFinite(ms) || !Number.isFinite(v)) continue;
    const b = at(ms); b.vSum += v; b.vN++; const sg = seg(s.segment); sg.vSum += v; sg.vN++; vTotal += v;
    if (v > peak.viewers) peak = { viewers: v, at: new Date(ms).toISOString() };
  }
  const avgViewers = samples.length ? Math.round(vTotal / samples.length) : 0;

  const timeline = buckets.map(b => ({ t: new Date(b.t).toISOString(), comments: b.comments, joins: b.joins, gifts: b.gifts, diamonds: b.diamonds, follows: b.follows, viewers: b.vN ? Math.round(b.vSum / b.vN) : null }));
  const segments = [...segs.values()].map(s => {
    const minutes = Math.max(0.5, s.vN * 0.5); // one sample every 30 s
    const avg = s.vN ? Math.round(s.vSum / s.vN) : null;
    return { name: s.name, comments: s.comments, joins: s.joins, gifts: s.gifts, diamonds: s.diamonds, follows: s.follows, avgViewers: avg, minutes: s.vN ? Math.round(minutes * 10) / 10 : null,
      commentsPerMin: s.vN ? Math.round(10 * s.comments / minutes) / 10 : null, diamondsPerMin: s.vN ? Math.round(10 * s.diamonds / minutes) / 10 : null,
      viewersVsAvg: avg !== null && avgViewers ? Math.round(100 * (avg - avgViewers) / avgViewers) : null };
  }).sort((a, b) => (b.diamonds - a.diamonds) || (b.comments - a.comments));

  return {
    since: since.toISOString(), bucketMinutes: bucketMs / 60000, totals, avgViewers, peak, timeline, segments,
    topGifters: [...gifters.values()].sort((a, b) => b.diamonds - a.diamonds).slice(0, 10),
    topChatters: [...chatters.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([username, comments]) => ({ username, comments })),
  };
}
