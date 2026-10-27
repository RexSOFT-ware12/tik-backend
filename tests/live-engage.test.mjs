import assert from 'node:assert/strict';
import { createEngine, matchAnswer, norm, updateStreak, badgeFor, sanitizeConfig, DEFAULT_CONFIG } from '../live-engage.mjs';

let t = 1_700_000_000_000; const events = []; const pts = [];
const mk = (extra = {}) => createEngine({ now: () => t, rand: () => 0.5, emit: async e => { events.push(e); }, onPoints: p => pts.push(p),
  say: async (p, fb) => fb, setTimeout: (f, ms) => { const h = { f, at: t + ms, unref() {} }; timers.push(h); return h; }, clearTimeout: h => { if (h) h.dead = true; },
  recentViewers: async () => [{ username: 'sam', streak: 4, badge: 'Regular' }], ...extra });
let timers = [];
const runTimers = () => { for (const h of timers) if (!h.dead && h.at <= t) { h.dead = true; h.f(); } };
const last = () => events.at(-1);

// helpers
assert.ok(matchAnswer('Jupiter!', ['Jupiter'])); assert.ok(matchAnswer('it is the jupiter', ['jupiter'])); assert.ok(!matchAnswer('hello', ['Jupiter']));
assert.ok(matchAnswer('7', ['7', 'seven'])); assert.ok(!matchAnswer('17', ['7']));
assert.equal(norm('The Café!'), 'cafe');
const v = {}; assert.equal(updateStreak(v, t).streak, 1); assert.equal(updateStreak(v, t + 3600e3).newDay, false);
updateStreak(v, t + 86400e3); assert.equal(v.streak, 2); updateStreak(v, t + 3 * 86400e3); assert.equal(v.streak, 1);
assert.equal(badgeFor({ visitCount: 1 }), 'Newcomer'); assert.equal(badgeFor({ streak: 3 }), 'Regular'); assert.equal(badgeFor({ lifetimeDiamonds: 600 }), 'Super Fan');
assert.equal(sanitizeConfig({ tiers: [] }).tiers.length, 5);
console.log('helpers ok');

// trivia win
let e = mk(); e.startSession();
let r = await e.startGame('trivia'); assert.ok(r.ok); assert.equal(last().type, 'game_start');
assert.equal((await e.startGame('riddle')).ok, false);
const q = e.gameAdmin(); assert.ok(q.answer);
assert.deepEqual(await e.handleChat({ key: 'a', username: 'amy', text: 'no idea' }), { consumed: true, priority: 20, perk: null });
t += 5000; r = await e.handleChat({ key: 'b', username: 'bob', text: q.answer });
assert.equal(last().type, 'game_win'); assert.equal(e.gameAdmin(), null); assert.equal(pts[0].username, 'bob'); assert.ok(pts[0].points >= 100);
assert.equal(last().segment, 'game:trivia');
console.log('trivia ok', last().replyText);

// timeout + hint
await e.startGame('riddle'); t += 26000; await e.tick(); assert.equal(last().type, 'game_hint');
t += 30000; await e.tick(); assert.equal(last().type, 'game_end'); assert.match(last().replyText, /answer was/);
console.log('hint/timeout ok');

// guess number
await e.startGame('guess_number'); const target = e.gameAdmin().answer;
await e.handleChat({ key: 'a', username: 'amy', text: String(target - 10) }); await e.handleChat({ key: 'b', username: 'bob', text: String(target + 10) });
t += 21000; await e.tick(); assert.equal(last().type, 'game_hint'); assert.match(last().replyText, /between/); assert.equal(e.gameAdmin().bounds.low, target - 9);
const before = events.length; await e.handleChat({ key: 'c', username: 'cy', text: String(target) }); assert.equal(events.length, before + 1); assert.equal(last().type, 'game_win');
console.log('guess ok');

// word chain
await e.startGame('word_chain'); let g = e.gameAdmin(); const seed = g.current; let letter = seed.slice(-1);
const mkWord = (l, n) => l + 'ae' + 'bcdfg'[n];
const w1 = mkWord(letter, 0); await e.handleChat({ key: 'a', username: 'amy', text: w1 });
assert.equal(e.gameAdmin().chain, 1); assert.equal(e.gameAdmin().current, w1);
await e.handleChat({ key: 'a', username: 'amy', text: mkWord(w1.slice(-1), 1) }); assert.equal(e.gameAdmin().chain, 1, 'same user twice rejected');
await e.handleChat({ key: 'b', username: 'bob', text: 'zzz' }); assert.equal(e.gameAdmin().chain, 1, 'wrong letter rejected');
await e.handleChat({ key: 'b', username: 'bob', text: w1 }); assert.equal(e.gameAdmin().chain, 1, 'reused rejected');
const users = ['b', 'c', 'a']; let guard = 0;
while (e.gameAdmin() && e.gameAdmin().chain < 3 && guard++ < 10) {
  const cur = e.gameAdmin().current; const key = users[guard % 3]; await e.handleChat({ key, username: key, text: mkWord(cur.slice(-1), guard) });
}
assert.equal(last().type, 'game_hint'); assert.match(last().replyText, /chain is 3 words/);
t += 41000; await e.tick(); assert.equal(last().type, 'game_end'); assert.match(last().replyText, /chain of 3 words/);
console.log('word chain ok');

// gifts: tiers, goals, crown, perks, !pick
events.length = 0; e = mk(); e.startSession();
let info = e.registerGift({ key: 'u1', username: 'ann', giftName: 'Rose', diamonds: 1, repeatCount: 1 });
assert.equal(info.tier, 'Small'); assert.equal(info.priority, 60); assert.equal(info.goalHits.length, 0);
for (let i = 0; i < 8; i++) info = e.registerGift({ key: 'u2', username: 'bo', giftName: 'Rose', diamonds: 1, repeatCount: 1 });
assert.equal(e.overlayState().goals[0].progress, 9);
info = e.registerGift({ key: 'u3', username: 'cy', giftName: 'rose', diamonds: 1, repeatCount: 1 });
assert.equal(info.goalHits.length, 1); assert.equal(info.priority, 85); assert.equal(e.overlayState().goals[0].progress, 0);
await e.afterGift(info); assert.equal(last().type, 'goal_reached'); assert.equal(last().reactionType, 'goal');
info = e.registerGift({ key: 'u2', username: 'bo', giftName: 'Lion', diamonds: 29, repeatCount: 3 }); // 87 diamonds, Nice
assert.equal(info.tier, 'Nice'); assert.equal(info.total, 87);
info = e.registerGift({ key: 'u4', username: 'dee', giftName: 'Galaxy', diamonds: 1000, repeatCount: 1 });
assert.equal(info.tier, 'Epic'); assert.equal(info.priority, 90); assert.ok(info.crownChange); assert.equal(info.crownChange.from, 'bo');
await e.afterGift(info); assert.equal(last().type, 'crown_change');
assert.equal(e.overlayState().king.username, 'dee'); assert.equal(e.overlayState().king.lead, 1000 - 95);
// perk priority + !pick
let c = await e.handleChat({ key: 'u4', username: 'dee', text: 'hello host' }); assert.equal(c.priority, 70);
c = await e.handleChat({ key: 'u4', username: 'dee', text: '!pick a joke about cats' }); assert.equal(c.special, 'a joke about cats'); assert.equal(c.priority, 85);
c = await e.handleChat({ key: 'u4', username: 'dee', text: '!pick another one' }); assert.equal(c.special, undefined);
c = await e.handleChat({ key: 'zz', username: 'nobody', text: '!pick a song' }); assert.equal(c.special, undefined); assert.equal(c.priority, 20);
t += 16 * 60000; assert.equal(e.perkFor('u4').active, false);
console.log('gifts ok');

// combos
const fired = []; const g1 = { key: 'u9', username: 'zed', giftName: 'Rose', diamonds: 1, streakable: true, giftId: 5 };
timers = [];
assert.equal(e.pushGift({ ...g1, repeatCount: 1 }, x => fired.push(x)), null); e.pushGift({ ...g1, repeatCount: 3 }, x => fired.push(x));
assert.equal(e.overlayState().combos[0].count, 3); assert.equal(fired.length, 0);
e.pushGift({ ...g1, repeatCount: 7, repeatEnd: true }, x => fired.push(x)); assert.equal(fired.length, 1); assert.equal(fired[0].repeatCount, 7); assert.equal(e.overlayState().combos.length, 0);
e.pushGift({ ...g1, repeatCount: 2 }, x => fired.push(x)); t += 5100; runTimers(); assert.equal(fired.length, 2); assert.equal(fired[1].repeatCount, 2);
e.pushGift({ key: 'u9', username: 'zed', giftName: 'Heart', diamonds: 5, streakable: false, repeatCount: 1 }, x => fired.push(x)); assert.equal(fired.length, 3);
console.log('combos ok');

// show clock + teasers + idle
events.length = 0; e = mk({ initialConfig: { idle: { seconds: 20 }, showClock: { teaserEveryMinutes: 1 } } }); e.startSession();
t += 61000; await e.tick(); assert.equal(last().type, 'teaser'); assert.match(last().replyText, /minute/);
t += 125000; await e.tick(); assert.equal(last().type, 'game_start'); assert.equal(last().segment, 'game:trivia'); // minute ~3
await e.endGame('manual'); t += 5 * 60000; await e.tick(); assert.equal(last().type, 'game_start'); // riddle at minute 8 (trivia already fired)
await e.endGame('manual'); events.length = 0;
// jump to 31 min: remaining overdue segments fire one per tick; finale eventually
for (let i = 0; i < 30; i++) { t += 60000; await e.tick(); if (e.gameAdmin()) await e.endGame('manual'); }
assert.ok(events.some(x => x.type === 'segment' && x.text === 'Finale surprise'), 'finale fired');
assert.ok(events.some(x => x.text === 'Leaderboard'), 'leaderboard fired');
// idle: after quiet time
events.length = 0; e.noteSpoken(); t += 21000; await e.tick(); assert.equal(last().type, 'idle');
const first = last().text; t += 21000; await e.tick(); assert.notEqual(last().text, first);
console.log('clock/idle ok', events.map(x => x.text).join(','));

// config sanitize + goals keep progress
e = mk(); e.registerGift({ key: 'q', username: 'q', giftName: 'Rose', diamonds: 1, repeatCount: 4 });
e.updateConfig({ idle: { seconds: 5, types: ['joke', 'bogus'] }, tiers: [{ name: 'X', min: 5 }], goals: [] });
const cfg = e.getConfig(); assert.equal(cfg.idle.seconds, 15); assert.deepEqual(cfg.idle.types, ['joke']); assert.equal(cfg.goals[0].progress, 4); assert.equal(cfg.tiers[0].name, 'X');
const ng = e.upsertGoal({ title: 'Big goal', unit: 'diamonds', target: 500, reward: 'song' }); assert.ok(ng.id); assert.equal(e.getConfig().goals.length, 2);
assert.equal(e.resetGoal('goal-rose').progress, 0); assert.ok(e.deleteGoal(ng.id));
console.log('config ok');
console.log('ALL ENGINE TESTS PASSED');

// analytics
import { buildAnalytics } from '../live-engage.mjs';
const T0 = new Date('2026-10-26T10:00:00Z'), N = T0.getTime() + 30 * 60000;
const evs = [
  { type: 'chat', username: 'a', createdAt: new Date(T0.getTime() + 60000), segment: 'game:trivia' }, { type: 'chat', username: 'a', createdAt: new Date(T0.getTime() + 90000), segment: 'game:trivia' },
  { type: 'join', username: 'b', createdAt: new Date(T0.getTime() + 120000), segment: 'free chat' },
  { type: 'gift', username: 'c', diamonds: 50, repeatCount: 5, createdAt: new Date(T0.getTime() + 600000), segment: 'free chat' },
  { type: 'game_start', createdAt: new Date(T0.getTime() + 3000), segment: 'game:trivia' }, { type: 'game_win', createdAt: new Date(T0.getTime() + 70000) }, { type: 'goal_reached', createdAt: new Date(T0.getTime() + 610000) },
];
const smp = [{ at: new Date(T0.getTime() + 30000), viewers: 10, segment: 'game:trivia' }, { at: new Date(T0.getTime() + 60000), viewers: 20, segment: 'game:trivia' }, { at: new Date(T0.getTime() + 600000), viewers: 8, segment: 'free chat' }];
const an = buildAnalytics(evs, smp, T0, N);
assert.equal(an.totals.comments, 2); assert.equal(an.totals.joins, 1); assert.equal(an.totals.gifts, 5); assert.equal(an.totals.diamonds, 50);
assert.equal(an.totals.gamesStarted, 1); assert.equal(an.totals.gameWins, 1); assert.equal(an.totals.goalsReached, 1);
assert.equal(an.peak.viewers, 20); assert.equal(an.avgViewers, 13); assert.equal(an.topGifters[0].username, 'c'); assert.equal(an.topChatters[0].comments, 2);
const tr = an.segments.find(x => x.name === 'game:trivia'); assert.equal(tr.avgViewers, 15); assert.ok(tr.viewersVsAvg > 0);
assert.ok(an.timeline.length >= 15 && an.timeline[0].viewers === 15);
console.log('analytics ok');

// ── conflict protection ──
events.length = 0; e = mk({ initialConfig: { idle: { seconds: 20 } } }); e.startSession();
// 1) the avatar still talking (reported by Studio) blocks filler
t += 30000; e.setSpeechState({ speaking: true, queued: 0 }); await e.tick(); assert.equal(events.length, 0, 'no idle while avatar speaks');
t += 30000; e.setSpeechState({ speaking: false, queued: 2 }); await e.tick(); assert.equal(events.length, 0, 'no idle while lines are queued');
e.setSpeechState({ speaking: false, queued: 0 }); await e.tick(); assert.equal(last().type, 'idle', 'idle once Studio reports quiet');
// 2) without a Studio report, a long line keeps filler away by estimate
events.length = 0; e = mk({ initialConfig: { idle: { seconds: 20 } } }); e.startSession(); t += 25000;
e.noteSpoken('word '.repeat(60)); t += 21000; await e.tick(); assert.equal(events.length, 0, 'estimate: still speaking a 60-word line');
t += 30000; await e.tick(); assert.equal(last().type, 'idle');
// 3) two games cannot start at once (scheduled + admin at the same moment)
e = mk({ genJson: async () => { await new Promise(r => setTimeout(r, 30)); return null; } }); events.length = 0;
const [r1, r2] = await Promise.all([e.startGame('trivia'), e.startGame('riddle')]);
assert.equal([r1.ok, r2.ok].filter(Boolean).length, 1, 'only one game starts'); assert.equal(events.filter(x => x.type === 'game_start').length, 1);
// 4) idle line written while a game starts is discarded
events.length = 0; let release; const gate = new Promise(r => (release = r));
e = mk({ initialConfig: { idle: { seconds: 20 } }, say: async (p, fb) => { await gate; return fb; } }); e.startSession(); t += 25000;
const pending = e.tick(); await new Promise(r => setTimeout(r, 5)); await e.startGame('trivia'); release(); await pending;
assert.ok(!events.some(x => x.type === 'idle'), 'stale idle dropped'); assert.equal(events.filter(x => x.type === 'game_start').length, 1);
// 5) finale/announce segments wait for a running game, never speak over it
events.length = 0; e = mk({ initialConfig: { showClock: { teaserEveryMinutes: 0, segments: [{ id: 'a', atMinute: 1, kind: 'trivia', title: 'T' }, { id: 'b', atMinute: 1, kind: 'announce', title: 'Hello all', text: 'Announcement!' }] } } }); e.startSession();
t += 61000; await e.tick(); assert.equal(last().type, 'game_start'); t += 5000; await e.tick(); assert.ok(!events.some(x => x.text === 'Hello all'), 'announce waits during game');
await e.endGame('manual'); t += 5000; e.setSpeechState({ speaking: false, queued: 0 }); t += 7000; e.setSpeechState({ speaking: false, queued: 0 }); await e.tick(); assert.ok(events.some(x => x.text === 'Hello all'), 'announce runs after the game');
// 6) the game clock starts when the question is ready, not before
e = mk({ genJson: async () => { t += 8000; return { question: 'What is two plus two exactly?', answer: 'four' }; } }); await e.startGame('trivia');
assert.ok(e.gameAdmin().secondsLeft >= 44, 'full answer window after slow LLM: ' + e.gameAdmin().secondsLeft);
console.log('conflict protection ok'); console.log('ALL TESTS PASSED');
