const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- Settings (set these as environment variables) ----------
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
let BOT_USERNAME = process.env.BOT_USERNAME || '';           // found automatically if empty
const WEBAPP_URL = process.env.WEBAPP_URL || '';            // your https link
const ADSGRAM_BLOCK_ID = process.env.ADSGRAM_BLOCK_ID || ''; // from Adsgram dashboard
const MONETAG_ZONE = process.env.MONETAG_ZONE || '';         // zone number from your Monetag dashboard (rewarded ads)
const DRA_USD = 0.0001;                                      // 1 dra = $0.0001

// Ads and limits
// Ad cards. Normal ads (15 + 10 + 5 = 30 a day) pay REWARD. Bonus ads unlock with active friends and pay BONUS_REWARD.
const REWARD = Number(process.env.REWARD_PER_AD || 4);             // dra per normal ad (4 dra = $0.004). KEEP BELOW WHAT AN AD EARNS YOU.
const BONUS_REWARD = Number(process.env.BONUS_REWARD_PER_AD || 2); // dra per bonus ad
const ADSGRAM_REWARD = Number(process.env.ADSGRAM_REWARD || 20); // dra per Adsgram ad
const GAME_AD_BONUS = Number(process.env.GAME_AD_BONUS ?? 20); // optional extra dra for watching one ad after a game win (0 = off)
const MONETAG_REWARD = Number(process.env.MONETAG_REWARD || 40);  // dra per Monetag ad
const SLOTS = [
  { id: 'adsgram', title: 'Adsgram ad', network: 'adsgram', limit: Number(process.env.ADS_ADSGRAM || 10), reward: ADSGRAM_REWARD, needRefs: 0 },
  { id: 'monetag', title: 'Monetag ad', network: 'monetag', limit: Number(process.env.ADS_MONETAG || 15), reward: MONETAG_REWARD, needRefs: 0 },
  { id: 'partner', title: 'Random company ad', network: 'partner', limit: Number(process.env.ADS_PARTNER || 5), reward: REWARD, needRefs: 0 },
  { id: 'bonus1', title: 'Bonus ad 1', network: 'monetag', limit: Number(process.env.ADS_BONUS || 10), reward: BONUS_REWARD, needRefs: Number(process.env.BONUS1_REFS || 5) },
  { id: 'bonus2', title: 'Bonus ad 2', network: 'monetag', limit: Number(process.env.ADS_BONUS || 10), reward: BONUS_REWARD, needRefs: Number(process.env.BONUS2_REFS || 10) },
];
const COOLDOWN = Number(process.env.COOLDOWN_SECONDS || 30);

// Referrals
const REF_BONUS = Number(process.env.REF_BONUS || 100);              // dra paid to the inviter when a friend becomes active
const FRIEND_BONUS = Number(process.env.FRIEND_BONUS ?? 50);       // dra the invited friend gets when they count (0 = none)
// Extra rewards for the inviter when this many friends have counted. Format "friends:dra,friends:dra"
const MILESTONES = String(process.env.REF_MILESTONES ?? '5:100,10:300,25:1000')
  .split(',').map((x) => x.split(':').map(Number)).filter((p) => p[0] > 0 && p[1] > 0).sort((a, b) => a[0] - b[0]);
const MIN_REFS_TO_WITHDRAW = Number(process.env.MIN_REFS_TO_WITHDRAW || 2); // verified friends needed before withdrawing

// Daily login reward
const LOGIN_REWARD = Number(process.env.LOGIN_REWARD || 10);
const LOGIN_DAY7_REWARD = Number(process.env.LOGIN_DAY7_REWARD || 100);

// Withdrawals
const MIN_WITHDRAW = Number(process.env.MIN_WITHDRAW || 300); // in dra (300 dra = $0.03)
const MIN_BEP20 = Number(process.env.MIN_WITHDRAW_BEP20 || MIN_WITHDRAW); // on-chain fees can be higher, so you may set this bigger
// Join gate: users must be members of your payout channel and your group before they can use the app.
// Set PAYOUT_CHANNEL and GROUP_CHAT to @username (or a numeric chat id). The bot must be an ADMIN in both. Leave empty to switch the gate off.
// For a private chat also set PAYOUT_LINK / GROUP_LINK to its invite link.
const gateEntry = (id, label, chat, link) => {
  chat = String(chat || '').trim();
  if (!chat) return null;
  if (!link && /^@/.test(chat)) link = 'https://t.me/' + chat.slice(1);
  return { id, label, chat, link: link || '' };
};
const GATE = [
  gateEntry('payout', 'Payout channel', process.env.PAYOUT_CHANNEL, process.env.PAYOUT_LINK),
  gateEntry('group', 'Group', process.env.GROUP_CHAT, process.env.GROUP_LINK),
].filter(Boolean);
const WELCOME_BONUS = Number(process.env.WELCOME_BONUS ?? 200); // dra every new user gets once (after joining the channels), so they can play games

// Loyalty bonus: after LOYALTY_COUNT PAID withdrawals (each at least LOYALTY_MIN dra) the user gets LOYALTY_BONUS dra (50000 dra = $5).
const LOYALTY_COUNT = Number(process.env.LOYALTY_COUNT ?? 30);          // 0 turns the rule off
const LOYALTY_BONUS = Number(process.env.LOYALTY_BONUS ?? 50000);       // dra
const LOYALTY_MIN = Number(process.env.LOYALTY_MIN ?? 1000);            // smallest withdrawal (dra) that counts toward it
const LOYALTY_MAX_WINNERS = Number(process.env.LOYALTY_MAX_WINNERS ?? 10); // most people who can ever get it (0 = no limit)
// All payouts are made in USDT value (10000 dra = 1 USDT), except GRAM, which you pay at the GRAM price of that day.
const METHODS = [
  { id: 'xrocket', label: 'xRocket (USDT)', hint: 'Your xRocket Telegram ID or @username', valid: /^@?[A-Za-z0-9_]{4,32}$/, min: MIN_WITHDRAW },
  { id: 'faucetpay', label: 'FaucetPay (USDT)', hint: 'The email of your FaucetPay account', valid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, min: MIN_WITHDRAW },
  { id: 'bep20', label: 'USDT (BEP20)', hint: 'Wallet address starting with 0x (BNB Smart Chain only)', valid: /^0x[a-fA-F0-9]{40}$/, min: MIN_BEP20 },
  { id: 'gram', label: 'GRAM (TON)', hint: 'Your TON wallet address', valid: /^([A-Za-z0-9_-]{48}|-?\d:[0-9a-fA-F]{64})$/, min: MIN_WITHDRAW },
];

// Extra anti-cheat layer: how many earning accounts may use the same internet address (IP). 0 = off.
// Keep it generous: many people on mobile data share one IP.
const MAX_PER_IP = Number(process.env.MAX_ACCOUNTS_PER_IP || 5);

// Lucky spin (OFF unless you set LOTTERY_ENABLED=1; read the README legal note first)
const LOTTERY_ENABLED = process.env.LOTTERY_ENABLED === '1';
const SPIN_MIN = Number(process.env.SPIN_MIN || 10);
const SPIN_MAX = Number(process.env.SPIN_MAX || 200);
const SPIN_DAILY = Number(process.env.SPIN_DAILY || 2);
// Prizes: multiplier and chance in basis points (10000 = 100%). A user gets their stake back or more 35% of the time. Average payback is 62%, so the app keeps 38%.
const PRIZES = [
  { mult: 0, bps: 5500 },
  { mult: 0.5, bps: 1000 },
  { mult: 1, bps: 2500 },
  { mult: 2, bps: 700 },
  { mult: 5, bps: 250 },
  { mult: 10, bps: 50 },
];

// Tic tac toe against the server (user plays X, the app plays O and moves first)
const TTT_DAILY = Number(process.env.TTT_DAILY ?? 5);         // games per day (0 turns the game off)
const TTT_WIN = Number(process.env.TTT_WIN || 150);           // dra won
const TTT_LOSE = Number(process.env.TTT_LOSE || 100);         // dra lost
const TTT_MISTAKE = Number(process.env.TTT_MISTAKE ?? 0.9);   // EASY mode: chance (0 to 1) that the app plays a random move instead of the best one
const TTT_MISTAKE_HARD = Number(process.env.TTT_MISTAKE_HARD ?? 0); // HARD mode (after the daily win limit): 0 = the app never makes a mistake
const GAME_DAILY_CAP = Number(process.env.GAME_DAILY_CAP ?? 500);   // dra a user can win from games per day. After that, tic tac toe becomes very hard. 0 = no limit
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
function tttWinner(b) {
  for (const [a, c, d] of LINES) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
  return b.every(Boolean) ? 'draw' : '';
}
const memo = new Map();
function minimax(b, turn) { // score for O (the app): 1 = O wins, -1 = X wins
  const key = b.map((c) => c || '-').join('') + turn;
  if (memo.has(key)) return memo.get(key);
  const sc = minimaxRaw(b, turn);
  memo.set(key, sc);
  return sc;
}
function minimaxRaw(b, turn) {
  const w = tttWinner(b);
  if (w === 'O') return 1;
  if (w === 'X') return -1;
  if (w === 'draw') return 0;
  let best = turn === 'O' ? -2 : 2;
  for (let i = 0; i < 9; i++) {
    if (b[i]) continue;
    b[i] = turn;
    const sc = minimax(b, turn === 'O' ? 'X' : 'O');
    b[i] = '';
    best = turn === 'O' ? Math.max(best, sc) : Math.min(best, sc);
  }
  return best;
}
function aiMove(b, mistake) {
  const empty = [];
  for (let i = 0; i < 9; i++) if (!b[i]) empty.push(i);
  if (crypto.randomInt(0, 1000) < mistake * 1000) return empty[crypto.randomInt(0, empty.length)];
  let best = -2, moves = [];
  for (const i of empty) {
    b[i] = 'O';
    const sc = minimax(b, 'X');
    b[i] = '';
    if (sc > best) { best = sc; moves = [i]; } else if (sc === best) moves.push(i);
  }
  return moves[crypto.randomInt(0, moves.length)];
}
function tttFinish(u, w) {
  const g = u.ttt;
  g.active = false;
  g.result = w === 'X' ? 'win' : w === 'O' ? 'lose' : 'draw';
  const st = u.stats || (u.stats = {});
  st[g.result] = (st[g.result] || 0) + 1;
  u.tttTotal = (u.tttTotal || 0) + 1;
  logEv(u, 'ttt:' + g.result, w === 'X' ? TTT_WIN : w === 'O' ? -TTT_LOSE : 0);
  payRef(u); // playing the game may be the last thing the inviter was waiting for
  if (w === 'X') { credit(u, TTT_WIN); u.gameWinToday = (u.gameWinToday || 0) + TTT_WIN; if (GAME_AD_BONUS > 0) u.pending = { kind: 'ttt', amount: GAME_AD_BONUS }; } // win is paid at once; the ad bonus is optional (see /api/claim-game)
  else if (w === 'O') u.balance = round2(Math.max(0, u.balance - TTT_LOSE));
}

// A friend only counts for the inviter after watching REF_MIN_ADS ads and playing one tic tac toe game.
const REF_MIN_ADS = Number(process.env.REF_MIN_ADS ?? 5);
const REF_NEED_TTT = process.env.REF_NEED_TTT !== '0';
const TASK_WAIT = Number(process.env.TASK_WAIT_SECONDS || 10); // seconds a user must wait before claiming a "open a link" task

const ADMIN_KEY = process.env.ADMIN_KEY || '';
const HIGH_DAY = Number(process.env.HIGH_EARN_PER_DAY || 2500); // dra a day above which an account is flagged
const ADMIN_CHAT_ID = (process.env.ADMIN_CHAT_ID || '').trim(); // your own Telegram id: the bot tells you about each new withdrawal
const ALLOWED_PHONE_PREFIX = (process.env.ALLOWED_PHONE_PREFIX || '').replace(/\D/g, ''); // e.g. 234 = Nigeria only. Empty = any country.
const REQUIRE_PHONE = process.env.REQUIRE_PHONE !== '0';   // set REQUIRE_PHONE=0 to skip the phone-number check
const PHONE_SALT =process.env.PHONE_SALT || BOT_TOKEN;      // used to hash phone numbers
const DEV = process.env.DEV === '1'; // testing in a normal browser. NEVER use on the live server.
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
const DATABASE_URL = process.env.DATABASE_URL || '';        // PostgreSQL connection string (use this for the live app)

// ---------- Data storage ----------
// With DATABASE_URL set, data lives in PostgreSQL and survives restarts. Without it, a local file is used (testing only).
const storage = require('./storage');
let db = null;
let save = () => {};
let closeStorage = null;
const round2 = (n) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

function getUser(tgUser) {
  const id = String(tgUser.id);
  if (!db.users[id]) {
    db.users[id] = { id, name: tgUser.first_name || 'User', balance: 0, totalEarned: 0, joinedAt: Date.now() };
    save();
  }
  const u = db.users[id];
  // fill in fields (also upgrades older saved users)
  const d = {
    day: today(), slots: {}, spinsToday: 0, lastAdAt: 0, adsTotal: 0, activeDays: [], verified: false, deviceIds: [],
    referredBy: null, referrals: [], refActive: 0, refPaid: false, streak: 0, lastClaimDay: '', tttToday: 0, ttt: null, pending: null, stats: {}, banned: false, tttTotal: 0, tasksDone: {}, taskStart: {}, gameWinToday: 0, refBal: 0, loyBal: 0, joinOk: 0, welcome: 0, paidW: 0,
  };
  for (const k of Object.keys(d)) if (u[k] === undefined) u[k] = d[k];
  if (u.day !== today()) {
    u.day = today();
    u.slots = {};
    u.spinsToday = 0;
    u.tttToday = 0;
    u.gameWinToday = 0;
    if (u.ttt && u.ttt.active) tttFinish(u, 'O'); // a game left unfinished overnight counts as a loss
    u.ttt = null;
  }
  return u;
}

const gameCapReached = (u) => GAME_DAILY_CAP > 0 && (u.gameWinToday || 0) >= GAME_DAILY_CAP;
const slotById = (id) => SLOTS.find((s) => s.id === id);
const isLocked = (u, s) => u.refActive < s.needRefs;
const dailyLimit = (u) => SLOTS.filter((s) => !isLocked(u, s)).reduce((a, s) => a + s.limit, 0);
const adsDone = (u) => SLOTS.reduce((a, s) => a + (u.slots[s.id] || 0), 0);
const needsTtt = () => REF_NEED_TTT && TTT_DAILY > 0;
const friendQualified = (f) => !!(f && f.verified && !f.banned && f.adsTotal >= REF_MIN_ADS && (!needsTtt() || (f.tttTotal || 0) >= 1));
const refsVerified = (u) => u.referrals.filter((id) => friendQualified(db.users[id])).length;
// Permanent ban. The ban also removes the account from its inviter's friends, so nobody can farm invites with a second account.
function banUser(u, why, did) {
  if (u.banned) return;
  u.banned = true;
  u.bannedReason = why;
  u.bannedAt = Date.now();
  if (did) u.banDevice = did;
  const inviter = u.referredBy && db.users[u.referredBy];
  if (inviter) inviter.referrals = inviter.referrals.filter((id) => id !== u.id);
  save();
}
// Wallets: 'main' (ads, games, tasks, daily, welcome), 'ref' (invite bonuses), 'loy' (loyalty bonus). Each is withdrawn on its own.
const WALLET_KEY = { main: 'balance', ref: 'refBal', loy: 'loyBal' };
function credit(u, amount, wallet) {
  const k = WALLET_KEY[wallet] || 'balance';
  u[k] = round2((u[k] || 0) + amount);
  u.totalEarned = round2(u.totalEarned + amount);
}

// Short activity log per user (last 40 events) so you can see how an account earns. [time, type, dra]
function logEv(u, type, amt) {
  if (!u.log) u.log = [];
  u.log.push([Date.now(), type, Math.round((amt || 0) * 100) / 100]);
  if (u.log.length > 40) u.log.shift();
}

// ---------- Telegram login check ----------
function verifyInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (calc.length !== hash.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (Date.now() / 1000 - authDate > 86400) return null;
  try {
    return JSON.parse(params.get('user'));
  } catch (e) {
    return null;
  }
}

function auth(req, res, next) {
  const initData = req.get('x-init-data') || '';
  let tgUser = null;
  if (initData && BOT_TOKEN) tgUser = verifyInitData(initData);
  if (!tgUser && DEV) tgUser = { id: 1, first_name: 'Test' };
  if (!tgUser) return res.status(401).json({ error: 'Open this app from Telegram.' });

  const u = getUser(tgUser);

  // Device lock: one device belongs to one account.
  const did = String(req.get('x-device-id') || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
  req.deviceConflict = false;
  req.ipKey = crypto.createHash('sha256').update(PHONE_SALT + (req.ip || '')).digest('hex').slice(0, 32); // we keep only a hash of the IP
  if (did.length >= 16) {
    const owner = db.devices[did];
    if (!owner) {
      db.devices[did] = u.id;
      if (!u.deviceIds.includes(did)) u.deviceIds.push(did);
      save();
    } else if (owner !== u.id && !u.allowShared) {
      // Rule: the SECOND account opened on a device is banned for good. The first account is not touched.
      banUser(u, 'Opened a second account on the same device', did);
    }
  }
  if (u.banned) req.deviceConflict = true;
  req.user = u;
  next();
}

// Blocks earning/withdrawing unless the account is verified and not a duplicate on someone's device.
function guardEarn(req, res) {
  if (DEV) return true;
  const u = req.user;
  if (u.banned) {
    res.status(403).json({ error: 'This account is permanently banned (a second account on the same device).' });
    return false;
  }
  if (req.deviceConflict) {
    res.status(403).json({ error: 'Another account already uses this device.' });
    return false;
  }
  if (GATE.length && !u.joinOk) {
    res.status(403).json({ error: 'Join our channel and group first.' });
    return false;
  }
  if (!u.verified) {
    res.status(403).json({ error: 'Verify your phone number in the bot chat first.' });
    return false;
  }
  if (!u.deviceIds || !u.deviceIds.length) {
    res.status(403).json({ error: 'Close and reopen the app, then try again.' });
    return false;
  }
  // IP limit: too many earning accounts on one network address.
  if (MAX_PER_IP > 0 && req.ipKey) {
    const list = (db.ips[req.ipKey] = db.ips[req.ipKey] || []);
    if (!list.includes(u.id)) {
      if (list.length >= MAX_PER_IP) {
        res.status(403).json({ error: 'Too many accounts are using this network. Try a different network.' });
        return false;
      }
      list.push(u.id);
      save();
    }
  }
  return true;
}

function nextLoginDay(u) {
  if (u.lastClaimDay === today()) return u.streak;
  if (u.lastClaimDay === yesterday()) return (u.streak % 7) + 1;
  return 1;
}

function taskView(u) {
  const done = u.tasksDone || {};
  return Object.values(db.tasks || {})
    .filter((t) => t.active && (done[t.id] || !t.max || t.claims < t.max))
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((t) => ({ id: t.id, title: t.title, type: t.type, link: t.link, reward: t.reward, done: !!done[t.id] }));
}

const loyaltyWinners = () => Object.values(db.users).filter((x) => x && x.loyalty).length;

function view(u, deviceConflict) {
  const day = nextLoginDay(u);
  return {
    name: u.name,
    balance: round2(u.balance),
    refBal: round2(u.refBal || 0),
    loyBal: round2(u.loyBal || 0),
    gate: GATE.length ? { joined: !!u.joinOk, welcome: WELCOME_BONUS, channels: GATE.map(({ id, label, link }) => ({ id, label, link })) } : null,
    totalEarned: round2(u.totalEarned),
    adsLeft: Math.max(0, dailyLimit(u) - adsDone(u)),
    dailyLimit: dailyLimit(u),
    reward: REWARD,
    bonusReward: BONUS_REWARD,
    slots: SLOTS.map((s) => ({
      id: s.id, title: s.title, network: s.network, reward: s.reward, limit: s.limit,
      done: u.slots[s.id] || 0, needRefs: s.needRefs, locked: isLocked(u, s),
    })),
    usdPerDra: DRA_USD,
    minWithdraw: MIN_WITHDRAW,
    methods: METHODS.map(({ id, label, hint, min }) => ({ id, label, hint, min })),
    cooldown: COOLDOWN,
    verified: DEV ? true : !!u.verified,
    deviceConflict: !!deviceConflict,
    banned: !!u.banned,
    secondsToNextAd: Math.max(0, Math.ceil((u.lastAdAt + COOLDOWN * 1000 - Date.now()) / 1000)),
    // invites
    inviteLink: BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=ref_${u.id}` : '',
    refBonus: REF_BONUS,
    friendsVerified: refsVerified(u),
    friendsActive: u.refActive,
    minRefsToWithdraw: MIN_REFS_TO_WITHDRAW,
    bonusSteps: SLOTS.filter((s) => s.needRefs > 0).map((s) => ({ refs: s.needRefs, ads: s.limit, reward: s.reward })),
    // daily login
    canClaimDaily: u.lastClaimDay !== today(),
    loginDay: day,
    loginAmount: day === 7 ? LOGIN_DAY7_REWARD : LOGIN_REWARD,
    loginNormal: LOGIN_REWARD,
    loginDay7: LOGIN_DAY7_REWARD,
    loginReward: LOGIN_REWARD,
    loginDay7: LOGIN_DAY7_REWARD,
    loyalty: LOYALTY_COUNT > 0
      ? { need: LOYALTY_COUNT, done: Math.min(u.paidW || 0, LOYALTY_COUNT), bonus: LOYALTY_BONUS, minAmount: LOYALTY_MIN, got: !!u.loyalty, full: !u.loyalty && LOYALTY_MAX_WINNERS > 0 && loyaltyWinners() >= LOYALTY_MAX_WINNERS, spotsLeft: LOYALTY_MAX_WINNERS > 0 ? Math.max(0, LOYALTY_MAX_WINNERS - loyaltyWinners()) : null }
      : null,
    myWithdrawals: db.withdrawals.filter((w) => w.userId === u.id).slice(-5).reverse().map((w) => ({ id: w.id, amount: w.amount, usd: w.usd, method: w.method, status: w.status, at: w.at })),
    pending: u.pending ? { kind: u.pending.kind, amount: u.pending.amount } : null,
    tasks: taskView(u),
    taskWait: TASK_WAIT,
    refRule: { ads: REF_MIN_ADS, ttt: needsTtt() },
    // the inviter can follow each friend's progress toward counting
    myFriends: (u.referrals || []).slice(-100).reverse().map((id) => db.users[id]).filter(Boolean).map((f) => ({
      name: String(f.name || 'Friend').slice(0, 20),
      ads: Math.min(f.adsTotal || 0, REF_MIN_ADS), adsNeed: REF_MIN_ADS,
      games: needsTtt() ? Math.min(f.tttTotal || 0, 1) : 0, gamesNeed: needsTtt() ? 1 : 0,
      done: friendQualified(f),
    })),
    friendBonus: FRIEND_BONUS,
    milestones: MILESTONES.map(([n, amt]) => ({ friends: n, reward: amt, done: !!(u.milestones && u.milestones[n]) })),
    refNote: u.referredBy && !friendQualified(u)
      ? `The friend who invited you gets credit after you watch ${REF_MIN_ADS} ads${needsTtt() ? ' and play 1 tic tac toe game' : ''} (ads: ${Math.min(u.adsTotal, REF_MIN_ADS)}/${REF_MIN_ADS}${needsTtt() ? ', game: ' + ((u.tttTotal || 0) >= 1 ? 'done' : 'not yet') : ''}).`
      : '',
    // tic tac toe
    ttt: TTT_DAILY > 0
      ? { left: Math.max(0, TTT_DAILY - u.tttToday), limit: TTT_DAILY, win: TTT_WIN, lose: TTT_LOSE, active: !!(u.ttt && u.ttt.active), board: u.ttt ? u.ttt.board : null, result: u.ttt ? u.ttt.result : '' }
      : null,
    // lucky spin
    lottery: LOTTERY_ENABLED
      ? { min: SPIN_MIN, max: SPIN_MAX, spinsLeft: Math.max(0, SPIN_DAILY - u.spinsToday), prizes: PRIZES.map((p) => ({ mult: p.mult, percent: p.bps / 100 })) }
      : null,
  };
}

// ---------- API ----------
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1)); // so the real visitor IP is read behind a host like Render
app.use(express.json({ limit: '10kb' }));
// The page and the token picture. Works with the files inside a "public" folder, or all together in one folder.
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/dra.svg', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dra.svg')));

app.get('/api/config', (req, res) => res.json({ adsgramBlockId: ADSGRAM_BLOCK_ID, monetagZone: MONETAG_ZONE }));

// One-time welcome bonus (default 200 dra) so a new user can play right away.
function welcome(u, deviceConflict) {
  if (!(WELCOME_BONUS > 0) || u.welcome || u.banned || deviceConflict || !(u.verified || DEV)) return;
  if (GATE.length && !u.joinOk) return;
  u.welcome = Date.now();
  credit(u, WELCOME_BONUS);
  logEv(u, 'welcome', WELCOME_BONUS);
}
// Asks Telegram if the user is in every gate chat. Returns null when fine, or an error { code, error }.
async function checkJoin(u) {
  for (const c of GATE) {
    let r;
    try { r = await tg('getChatMember', { chat_id: c.chat, user_id: Number(u.id) }); } catch (e) { r = null; }
    if (!(r && r.ok)) return { code: 503, error: 'Cannot check your membership right now. Try again later.' };
    const st = r.result && r.result.status;
    if (!(['member', 'administrator', 'creator'].includes(st) || (st === 'restricted' && r.result.is_member))) return { code: 400, error: `Join the ${c.label} first, then tap the button again.` };
  }
  return null;
}
app.post('/api/me', auth, (req, res) => {
  const u = req.user;
  if (!GATE.length) { const had = u.welcome; welcome(u, req.deviceConflict); if (!had && u.welcome) save(); }
  res.json(view(u, req.deviceConflict));
});
app.post('/api/check-join', auth, async (req, res) => {
  const u = req.user;
  if (u.banned || req.deviceConflict) return res.status(403).json({ error: 'This account cannot use the app.' });
  if (GATE.length && !u.joinOk) {
    const bad = await checkJoin(u);
    if (bad) return res.status(bad.code).json({ error: bad.error });
    u.joinOk = Date.now();
  }
  welcome(u, req.deviceConflict);
  save();
  res.json(view(u, req.deviceConflict));
});

// When a friend has watched enough ads on enough days, the inviter gets the bonus (once).
// Pays the inviter (once) as soon as the friend counts: 5 ads watched and 1 tic tac toe game played.
function payRef(u) {
  if (!u.referredBy || u.refPaid) return;
  if (!friendQualified(u)) return;
  const inviter = db.users[u.referredBy];
  if (inviter && inviter.verified && !inviter.banned) {
    credit(inviter, REF_BONUS, 'ref');
    logEv(inviter, 'ref', REF_BONUS);
    inviter.refActive += 1;
    u.refPaid = true;
    if (FRIEND_BONUS > 0) credit(u, FRIEND_BONUS); // welcome bonus for the invited friend
    // milestone rewards for the inviter
    if (!inviter.milestones) inviter.milestones = {};
    let extra = 0;
    for (const [n, amt] of MILESTONES) {
      if (inviter.refActive >= n && !inviter.milestones[n]) { inviter.milestones[n] = true; credit(inviter, amt, 'ref'); extra += amt; }
    }
    // tell the inviter in the bot chat
    if (BOT_TOKEN) {
      const next = MILESTONES.find(([n]) => inviter.refActive < n);
      const text = `🎉 A friend just counted! +${REF_BONUS} dra` + (extra ? `, plus a milestone bonus of +${extra} dra` : '') + `.\nFriends counted so far: ${inviter.refActive}.` + (next ? ` ${next[0] - inviter.refActive} more to earn +${next[1]} dra.` : '');
      tg('sendMessage', { chat_id: inviter.id, text }).catch(() => {});
    }
  }
}
function trackActive(u) {
  u.adsTotal += 1;
  if (!u.activeDays.includes(today())) u.activeDays.push(today());
  payRef(u);
}

// Called after the user finishes watching an ad.
// An ad can only pay if its network is really set up (Block ID / zone in Render). Otherwise nobody could have watched one.
const adNetworkReady = (network) => DEV || (network === 'adsgram' ? !!ADSGRAM_BLOCK_ID : network === 'monetag' ? !!MONETAG_ZONE : network === 'partner' ? !!(ADSGRAM_BLOCK_ID || MONETAG_ZONE) : true);
app.post('/api/ad-complete', auth, (req, res) => {
  if (!guardEarn(req, res)) return;
  const u = req.user;
  const slot = slotById(req.body && req.body.slot);
  if (!slot) return res.status(400).json({ error: 'Unknown ad.' });
  if (!adNetworkReady(slot.network)) return res.status(503).json({ error: 'Ads are not available yet. Try again later.' });
  if (isLocked(u, slot)) return res.status(403).json({ error: `Invite ${slot.needRefs} active friends to unlock this bonus ad.` });
  if ((u.slots[slot.id] || 0) >= slot.limit) return res.status(429).json({ error: `${slot.title} limit reached. Come back tomorrow.` });
  if (Date.now() - u.lastAdAt < COOLDOWN * 1000) return res.status(429).json({ error: 'Please wait a bit before the next ad.' });
  u.slots[slot.id] = (u.slots[slot.id] || 0) + 1;
  u.lastAdAt = Date.now();
  credit(u, slot.reward);
  logEv(u, 'ad:' + slot.id, slot.reward);
  trackActive(u);
  save();
  res.json(view(u));
});

// Daily login reward. Day 7 pays more, then the cycle starts again. Missing a day resets to day 1.
app.post('/api/daily-claim', auth, (req, res) => {
  if (!guardEarn(req, res)) return;
  const u = req.user;
  if (u.lastClaimDay === today()) return res.status(400).json({ error: 'You already claimed today. Come back tomorrow.' });
  u.streak = nextLoginDay(u);
  u.lastClaimDay = today();
  credit(u, u.streak === 7 ? LOGIN_DAY7_REWARD : LOGIN_REWARD);
  logEv(u, 'daily', u.streak === 7 ? LOGIN_DAY7_REWARD : LOGIN_REWARD);
  save();
  res.json(view(u));
});

// Tic tac toe: the server keeps the board and plays the other side, so results cannot be faked.
app.post('/api/ttt/start', auth, (req, res) => {
  if (!(TTT_DAILY > 0)) return res.status(403).json({ error: 'Tic tac toe is not available.' });
  if (!guardEarn(req, res)) return;
  const u = req.user;
  if (u.ttt && u.ttt.active) return res.json(view(u)); // finish the game you started
  u.pending = null; // an unclaimed optional bonus simply expires
  if (u.tttToday >= TTT_DAILY) return res.status(429).json({ error: 'No games left today.' });
  if (u.balance < TTT_LOSE) return res.status(400).json({ error: `You need at least ${TTT_LOSE} dra to play.` });
  const board = Array(9).fill('');
  const hard = gameCapReached(u);
  board[aiMove(board, hard ? TTT_MISTAKE_HARD : TTT_MISTAKE)] = 'O';
  u.ttt = { active: true, board, result: '', hard };
  u.tttToday += 1;
  save();
  res.json(view(u));
});

app.post('/api/ttt/move', auth, (req, res) => {
  if (!guardEarn(req, res)) return;
  const u = req.user;
  const g = u.ttt;
  if (!g || !g.active) return res.status(400).json({ error: 'Start a game first.' });
  const i = Number(req.body && req.body.cell);
  if (!Number.isInteger(i) || i < 0 || i > 8 || g.board[i]) return res.status(400).json({ error: 'Pick an empty square.' });
  g.board[i] = 'X';
  let w = tttWinner(g.board);
  if (!w) {
    g.board[aiMove(g.board, g.hard ? TTT_MISTAKE_HARD : TTT_MISTAKE)] = 'O';
    w = tttWinner(g.board);
  }
  if (w) tttFinish(u, w);
  save();
  res.json(view(u));
});

// Promo codes. You make them on /admin/codes-page?key=YOUR_ADMIN_KEY. Each user can use a code once.
const codeFails = new Map(); // user id -> { n, until }: too many wrong guesses locks them out for a while
app.post('/api/redeem', auth, (req, res) => {
  if (!guardEarn(req, res)) return;
  const u = req.user;
  const f = codeFails.get(u.id);
  if (f && f.until > Date.now()) return res.status(429).json({ error: 'Too many wrong codes. Try again in a few minutes.' });
  const code = String((req.body && req.body.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
  const wrong = (msg) => {
    const x = codeFails.get(u.id) || { n: 0, until: 0 };
    x.n += 1;
    if (x.n >= 5) { x.until = Date.now() + 10 * 60000; x.n = 0; }
    codeFails.set(u.id, x);
    return res.status(400).json({ error: msg });
  };
  const c = code && (db.codes || {})[code];
  if (!c || !c.active) return wrong('This code is not valid.');
  if (c.expires && Date.now() > c.expires) return wrong('This code has expired.');
  if (!u.codes) u.codes = {};
  if (u.codes[code]) return res.status(400).json({ error: 'You already used this code.' });
  if (c.max && c.used >= c.max) return res.status(400).json({ error: 'This code has been fully used.' });
  c.used = (c.used || 0) + 1;
  u.codes[code] = Date.now();
  credit(u, c.reward);
  logEv(u, 'code:' + code, c.reward);
  codeFails.delete(u.id);
  save();
  res.json(Object.assign(view(u), { redeemed: c.reward }));
});

// Tasks (join a channel, open a link). You add them on /admin/tasks-page?key=YOUR_ADMIN_KEY
const claiming = new Set();
function findTask(req) {
  const t = (db.tasks || {})[String((req.body && req.body.id) || '')];
  return t && t.active ? t : null;
}
app.post('/api/task-start', auth, (req, res) => {
  if (!guardEarn(req, res)) return;
  const u = req.user, t = findTask(req);
  if (!t) return res.status(404).json({ error: 'This task is not available.' });
  if (!u.taskStart) u.taskStart = {};
  if (!u.taskStart[t.id]) u.taskStart[t.id] = Date.now();
  save();
  res.json(view(u));
});
app.post('/api/task-claim', auth, async (req, res) => {
  if (!guardEarn(req, res)) return;
  const u = req.user, t = findTask(req);
  if (!t) return res.status(404).json({ error: 'This task is not available.' });
  if (!u.tasksDone) u.tasksDone = {};
  if (u.tasksDone[t.id]) return res.status(400).json({ error: 'You already did this task.' });
  if (t.max && t.claims >= t.max) return res.status(400).json({ error: 'This task is full.' });
  const lock = u.id + ':' + t.id;
  if (claiming.has(lock)) return res.status(429).json({ error: 'Please wait.' });
  claiming.add(lock);
  try {
    if (t.type === 'channel') {
      let ok = false;
      try {
        const r = await tg('getChatMember', { chat_id: t.chat, user_id: Number(u.id) });
        const st = r && r.ok && r.result && r.result.status;
        ok = ['member', 'administrator', 'creator'].includes(st) || (st === 'restricted' && r.result.is_member);
        if (!(r && r.ok)) return res.status(503).json({ error: 'Cannot check this task right now. Try again later.' });
      } catch (e) {
        return res.status(503).json({ error: 'Cannot check this task right now. Try again later.' });
      }
      if (!ok) return res.status(400).json({ error: 'Join the channel first, then tap CLAIM.' });
    } else {
      const started = (u.taskStart && u.taskStart[t.id]) || 0;
      if (!started || Date.now() - started < TASK_WAIT * 1000) return res.status(400).json({ error: 'Open the link and wait a few seconds, then tap CLAIM.' });
    }
    if (u.tasksDone[t.id] || (t.max && t.claims >= t.max)) return res.status(400).json({ error: 'Not available.' });
    u.tasksDone[t.id] = Date.now();
    t.claims = (t.claims || 0) + 1;
    credit(u, t.reward);
    logEv(u, 'task:' + t.id, t.reward);
    save();
    res.json(view(u));
  } finally {
    claiming.delete(lock);
  }
});

// Optional bonus after a game win: the page shows an ad, then calls this. Games never need it.
app.post('/api/claim-game', auth, (req, res) => {
  if (!guardEarn(req, res)) return;
  const u = req.user;
  if (!u.pending) return res.status(400).json({ error: 'Nothing to claim.' });
  if (!adNetworkReady('partner')) return res.status(503).json({ error: 'Ads are not available yet. Try again later.' });
  credit(u, u.pending.amount);
  logEv(u, 'adbonus', u.pending.amount);
  u.pending = null;
  save();
  res.json(view(u));
});

// Lucky spin: the user stakes dra and gets a random multiplier.
app.post('/api/spin', auth, (req, res) => {
  if (!LOTTERY_ENABLED) return res.status(403).json({ error: 'Lucky spin is not available.' });
  if (!guardEarn(req, res)) return;
  const u = req.user;
  const stake = Math.floor(Number(req.body && req.body.stake));
  if (!(stake >= SPIN_MIN && stake <= SPIN_MAX)) return res.status(400).json({ error: `Stake must be between ${SPIN_MIN} and ${SPIN_MAX} dra.` });
  if (stake > u.balance) return res.status(400).json({ error: 'Not enough dra.' });
  if (u.spinsToday >= SPIN_DAILY) return res.status(429).json({ error: 'No spins left today.' });
  u.pending = null; // an unclaimed optional bonus simply expires

  const roll = crypto.randomInt(0, 10000); // fair random number from the server
  let acc = 0, prize = PRIZES[0];
  for (const p of PRIZES) {
    acc += p.bps;
    if (roll < acc) { prize = p; break; }
  }
  const win = Math.floor(stake * prize.mult);
  u.balance = round2(u.balance - stake);
  if (win > 0) { credit(u, win); u.gameWinToday = (u.gameWinToday || 0) + win; } // winnings are paid at once; the ad bonus is optional
  if (win >= stake && GAME_AD_BONUS > 0) u.pending = { kind: 'spin', amount: GAME_AD_BONUS };
  const st = u.stats || (u.stats = {});
  st.spinIn = (st.spinIn || 0) + stake;
  st.spinOut = (st.spinOut || 0) + win;
  u.spinsToday += 1;
  logEv(u, 'spin', win - stake);
  save();
  res.json(Object.assign(view(u), { spin: { stake, multiplier: prize.mult, win } }));
});

app.post('/api/withdraw', auth, async (req, res) => {
  if (!guardEarn(req, res)) return;
  const u = req.user;
  // The membership check is the only slow step, so it comes first; everything after it runs without waiting.
  if (GATE.length) {
    const bad = await checkJoin(u);
    if (bad) {
      if (bad.code === 400) u.joinOk = 0; // they left: they must join again
      return res.status(bad.code).json({ error: bad.error });
    }
  }
  const method = METHODS.find((m) => m.id === (req.body && req.body.method));
  const wallet = WALLET_KEY[req.body && req.body.wallet] ? req.body.wallet : 'main';
  const wkey = WALLET_KEY[wallet];
  const account = String((req.body && req.body.account) || '').trim().slice(0, 200);
  const friends = refsVerified(u);
  if (friends < MIN_REFS_TO_WITHDRAW) return res.status(400).json({ error: `Invite ${MIN_REFS_TO_WITHDRAW} friends first (you have ${friends}).` });
  if (!method) return res.status(400).json({ error: 'Choose a withdrawal method.' });
  if (!method.valid.test(account)) return res.status(400).json({ error: `Invalid ${method.label} details. ${method.hint}.` });
  const amount = round2(u[wkey] || 0);
  if (amount < method.min) return res.status(400).json({ error: `Minimum withdrawal for ${method.label} is ${method.min} dra (this wallet has ${amount}).` });
  if (u.ttt && u.ttt.active) return res.status(400).json({ error: 'Finish your tic tac toe game first.' });
  const pending = db.withdrawals.find((w) => w.userId === u.id && w.status === 'pending');
  if (pending) return res.status(400).json({ error: 'You already have a pending withdrawal.' });

  // One payout account can only belong to one user.
  const key = (method.id === 'xrocket' ? account.replace(/^@/, '') : account).toLowerCase().replace(/\s+/g, '');
  const owner = db.payouts[key];
  if (owner && owner !== u.id) return res.status(400).json({ error: 'This payout account is already used by another user.' });
  db.payouts[key] = u.id;

  db.withdrawals.push({
    id: db.withdrawals.length + 1,
    userId: u.id,
    name: u.name,
    wallet,
    amount,
    usd: Math.round(amount * DRA_USD * 1e6) / 1e6,
    method: method.label,
    account,
    status: 'pending',
    at: new Date().toISOString(),
  });
  u[wkey] = 0;
  logEv(u, 'withdraw', -amount);
  save();
  if (ADMIN_CHAT_ID) tg('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `💸 New withdrawal #${db.withdrawals.length}: ${u.name}, ${amount} dra ($${(amount * DRA_USD).toFixed(4)}) via ${method.label}. Open your review page to approve it.` }).catch(() => {});
  res.json(view(u));
});

// ---------- Admin (you) ----------
function admin(req, res, next) {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(403).send('No');
  next();
}
// Tasks: add, list and turn off (turned-off tasks stay in the list but users no longer see them)
const TASKS_PAGE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tasks</title>\n<style>body{font:16px system-ui,sans-serif;background:#150704;color:#ffe9cf;margin:0 auto;padding:16px;max-width:560px}input,select,button{width:100%;box-sizing:border-box;font:inherit;padding:12px;margin:6px 0;border-radius:10px;border:1px solid #7a2e12;background:#2a0d06;color:#ffe9cf}button{background:#e8400c;border:0;font-weight:700;color:#fff}.t{border:1px solid #7a2e12;border-radius:12px;padding:12px;margin:10px 0}.t b{display:block}.t small{opacity:.75;display:block;word-break:break-all}.off{background:#5a1d0e;width:auto;padding:8px 14px}#msg{margin-top:8px;color:#ffd66b}</style>\n<h2>Tasks</h2><div id="list">Loading...</div>\n<h3>Add a task</h3>\n<input id="title" placeholder="Title, for example: Join our channel">\n<select id="type"><option value="channel">Join a Telegram channel (checked automatically)</option><option value="link">Open a link (not checked)</option></select>\n<input id="link" placeholder="Link, for example: https://t.me/yourchannel">\n<input id="chat" placeholder="Channel username, for example: @yourchannel (channel tasks only)">\n<input id="reward" type="number" inputmode="numeric" placeholder="Reward in dra, for example: 200">\n<input id="max" type="number" inputmode="numeric" placeholder="Most people who can claim it (0 = no limit)">\n<button id="add">ADD TASK</button><div id="msg"></div>\n<p><small>For a channel task, add your bot as an ADMIN of the channel, or the check cannot work.</small></p>\n<script>\nvar key=new URLSearchParams(location.search).get(\'key\')||\'\';\nvar q=\'?key=\'+encodeURIComponent(key);\nfunction $(i){return document.getElementById(i)}\nfunction say(t){$(\'msg\').textContent=t}\nfunction load(){fetch(\'/admin/tasks\'+q).then(function(r){return r.json()}).then(function(a){\n var l=$(\'list\');l.textContent=\'\';\n if(!a.length){l.textContent=\'No tasks yet.\';return}\n a.forEach(function(t){var d=document.createElement(\'div\');d.className=\'t\';\n  var b=document.createElement(\'b\');b.textContent=\'#\'+t.id+\' \'+t.title+(t.active?\'\':\' (off)\');\n  var s=document.createElement(\'small\');s.textContent=t.type+\' | \'+t.reward+\' dra | done by \'+t.claims+(t.max?\' of \'+t.max:\'\')+\' | \'+t.link;\n  d.appendChild(b);d.appendChild(s);\n  if(t.active){var x=document.createElement(\'button\');x.className=\'off\';x.textContent=\'TURN OFF\';x.onclick=function(){fetch(\'/admin/tasks/\'+t.id+\'/off\'+q,{method:\'POST\'}).then(load)};d.appendChild(x)}\n  l.appendChild(d)})}).catch(function(){$(\'list\').textContent=\'Could not load. Check the key in the link.\'})}\n$(\'add\').onclick=function(){\n var body={title:$(\'title\').value,type:$(\'type\').value,link:$(\'link\').value,chat:$(\'chat\').value,reward:Number($(\'reward\').value),max:Number($(\'max\').value||0)};\n fetch(\'/admin/tasks\'+q,{method:\'POST\',headers:{\'content-type\':\'application/json\'},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(d){\n  if(d.error){say(d.error);return}say(\'Task added\');[\'title\',\'link\',\'chat\',\'reward\',\'max\'].forEach(function(i){$(i).value=\'\'});load()})};\nload();\n</script>';
app.get('/admin/tasks-page', admin, (req, res) => res.type('html').send(TASKS_PAGE));
app.get('/admin/tasks', admin, (req, res) => res.json(Object.values(db.tasks).sort((a, b) => Number(a.id) - Number(b.id))));
app.post('/admin/tasks', admin, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 80);
  const type = b.type === 'link' ? 'link' : 'channel';
  const link = String(b.link || '').trim();
  const reward = Math.floor(Number(b.reward));
  const max = Math.max(0, Math.floor(Number(b.max) || 0));
  let chat = String(b.chat || '').trim();
  if (!title) return res.status(400).json({ error: 'Write a title.' });
  if (!/^https:\/\/[^\s]+$/.test(link)) return res.status(400).json({ error: 'The link must start with https://' });
  if (!(reward >= 1 && reward <= 1000000)) return res.status(400).json({ error: 'Write the reward in dra (a number).' });
  if (type === 'channel') {
    if (!chat) { const m = /^https:\/\/t\.me\/([A-Za-z0-9_]{4,32})\/?$/.exec(link); if (m) chat = '@' + m[1]; }
    if (!/^@[A-Za-z0-9_]{4,32}$/.test(chat)) return res.status(400).json({ error: 'Write the channel username, like @yourchannel.' });
  } else chat = '';
  const id = String(Object.keys(db.tasks).length + 1);
  db.tasks[id] = { id, title, type, link, chat, reward, max, claims: 0, active: true, at: Date.now() };
  save();
  res.json(db.tasks[id]);
});
app.post('/admin/tasks/:id/off', admin, (req, res) => {
  const t = db.tasks[req.params.id];
  if (!t) return res.status(404).send('Not found');
  t.active = false;
  save();
  res.send('ok');
});
// Banned accounts:  /admin/banned?key=YOUR_ADMIN_KEY
app.get('/admin/banned', admin, (req, res) => res.json(Object.values(db.users).filter((u) => u.banned).map((u) => ({ id: u.id, name: u.name, reason: u.bannedReason, at: u.bannedAt }))));
// Lift a ban by mistake (for example a family phone):  POST /admin/unban/USER_ID?key=YOUR_ADMIN_KEY
// This account is then allowed to share a device with the other account, and the first account is not touched.
app.post('/admin/unban/:id', admin, (req, res) => {
  const u = db.users[req.params.id];
  if (!u || !u.banned) return res.status(404).send('Not found');
  u.banned = false;
  u.allowShared = true;
  save();
  res.send('ok');
});
// Game results so far:  /admin/stats?key=YOUR_ADMIN_KEY  (use it to tune TTT_MISTAKE)
app.get('/admin/stats', admin, (req, res) => {
  const t = { users: 0, tttWin: 0, tttLose: 0, tttDraw: 0, spinStaked: 0, spinPaidOut: 0 };
  for (const u of Object.values(db.users)) {
    t.users++;
    const st = u.stats || {};
    t.tttWin += st.win || 0; t.tttLose += st.lose || 0; t.tttDraw += st.draw || 0;
    t.spinStaked += st.spinIn || 0; t.spinPaidOut += st.spinOut || 0;
  }
  const g = t.tttWin + t.tttLose + t.tttDraw;
  t.tttPlayerWinPercent = g ? Math.round((1000 * t.tttWin) / g) / 10 : null;
  t.spinPaybackPercent = t.spinStaked ? Math.round((1000 * t.spinPaidOut) / t.spinStaked) / 10 : null;
  res.json(t);
});
// See requests:  /admin/withdrawals?key=YOUR_ADMIN_KEY
app.get('/admin/withdrawals', admin, (req, res) => res.json(db.withdrawals));
// After you pay someone, mark it:  POST /admin/withdrawals/3/paid?key=YOUR_ADMIN_KEY   (the review page has a button for this)
app.post('/admin/withdrawals/:id/paid', admin, (req, res) => {
  const w = db.withdrawals.find((x) => x.id === Number(req.params.id));
  if (!w) return res.status(404).send('Not found');
  if (w.status === 'rejected') return res.status(400).send('This one was rejected.');
  const first = w.status !== 'paid'; // marking it twice must not count twice
  w.status = 'paid';
  w.doneAt = new Date().toISOString();
  const u = db.users[w.userId];
  if (first && u) tg('sendMessage', { chat_id: u.id, text: `✅ Your withdrawal of ${w.amount} dra ($${(w.usd || 0).toFixed(4)}) has been paid.` }).catch(() => {});
  if (first && LOYALTY_COUNT > 0 && u && !u.banned && w.wallet !== 'loy' && w.amount >= LOYALTY_MIN) {
    u.paidW = (u.paidW || 0) + 1;
    if (u.paidW >= LOYALTY_COUNT && !u.loyalty && (LOYALTY_MAX_WINNERS <= 0 || loyaltyWinners() < LOYALTY_MAX_WINNERS)) {
      u.loyalty = Date.now();
      credit(u, LOYALTY_BONUS, 'loy');
      tg('sendMessage', { chat_id: u.id, text: `🐉 Loyalty bonus! You completed ${LOYALTY_COUNT} withdrawals and got +${LOYALTY_BONUS} dra ($${(LOYALTY_BONUS * DRA_USD).toFixed(2)}). Thank you for staying with us!` }).catch(() => {});
    }
  }
  save();
  res.json(w);
});
// Reject a pending withdrawal:  POST /admin/withdrawals/3/reject?key=...&mode=refund   (mode=refund gives the dra back, mode=ban bans the account and keeps the dra)
app.post('/admin/withdrawals/:id/reject', admin, (req, res) => {
  const w = db.withdrawals.find((x) => x.id === Number(req.params.id));
  if (!w) return res.status(404).send('Not found');
  if (w.status !== 'pending') return res.status(400).send('Only pending withdrawals can be rejected.');
  const u = db.users[w.userId];
  const mode = req.query.mode === 'ban' ? 'ban' : 'refund';
  w.status = 'rejected';
  w.doneAt = new Date().toISOString();
  w.rejectMode = mode;
  if (u) {
    if (mode === 'refund') {
      const k = WALLET_KEY[w.wallet] || 'balance';
      u[k] = round2((u[k] || 0) + w.amount);
      tg('sendMessage', { chat_id: u.id, text: `Your withdrawal of ${w.amount} dra was not approved. The dra were returned to your wallet.` }).catch(() => {});
    } else {
      banUser(u, 'Banned by admin after reviewing a withdrawal');
    }
  }
  save();
  res.json(w);
});

// ---------- Finding cheaters ----------
// Risk signals for every user. Nothing here bans anyone by itself: you read the flags and decide.
function riskReport() {
  const ipsOf = {}; // user id -> the lists of accounts that share a network with it
  for (const list of Object.values(db.ips || {})) for (const id of list) (ipsOf[id] = ipsOf[id] || []).push(list);
  const now = Date.now();
  return Object.values(db.users).map((u) => {
    const flags = []; let score = 0;
    const add = (pts, text) => { score += pts; flags.push(text); };
    const ageDays = Math.max(1, (now - (u.joinedAt || now)) / 86400000);
    const shared = Math.max(0, ...((ipsOf[u.id] || []).map((l) => l.length - 1)));
    if (shared >= 1) add(shared >= 3 ? 30 : 15, 'Shares a network with ' + shared + ' other account' + (shared > 1 ? 's' : ''));
    if ((u.deviceIds || []).length > 1) add(25, 'Used ' + u.deviceIds.length + ' devices');
    if (u.banned) add(40, 'Banned: ' + (u.bannedReason || ''));
    const perDay = (u.totalEarned || 0) / ageDays;
    if (perDay > HIGH_DAY && ageDays >= 1) add(20, 'Earns about ' + Math.round(perDay) + ' dra a day (very high)');
    const ads = (u.log || []).filter((e) => String(e[1]).startsWith('ad:')).map((e) => e[0]);
    if (ads.length >= 8) {
      const gaps = ads.slice(1).map((t, i) => (t - ads[i]) / 1000);
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / gaps.length);
      if (sd < 2 && mean < 600) add(30, 'Ads at robot-like intervals (every ' + Math.round(mean) + 's, almost no variation)');
    }
    const friends = (u.referrals || []).map((id) => db.users[id]).filter(Boolean);
    const sameNet = friends.filter((f) => (ipsOf[u.id] || []).some((l) => l.includes(f.id))).length;
    if (sameNet >= 2) add(30, sameNet + ' of the friends they invited use the same network');
    const wd = db.withdrawals.filter((w) => w.userId === u.id);
    if (wd.length && wd[0] && (new Date(wd[0].at).getTime() - (u.joinedAt || 0)) < 86400000) add(10, 'Asked to withdraw within 24 hours of joining');
    const wins = ((u.stats || {}).win || 0), played = wins + ((u.stats || {}).lose || 0) + ((u.stats || {}).draw || 0);
    if (played >= 20 && wins / played > 0.9) add(15, 'Wins ' + Math.round((100 * wins) / played) + '% of tic tac toe games');
    return {
      id: u.id, name: u.name, score, flags, banned: !!u.banned,
      joined: u.joinedAt, ageDays: Math.round(ageDays * 10) / 10,
      balance: round2(u.balance || 0), refBal: round2(u.refBal || 0), loyBal: round2(u.loyBal || 0), totalEarned: round2(u.totalEarned || 0),
      ads: u.adsTotal || 0, games: u.tttTotal || 0, friends: refsVerified(u), invitedBy: u.referredBy || null,
      withdrawals: wd.length, log: (u.log || []).slice(-12).reverse(),
    };
  }).sort((a, b) => b.score - a.score);
}
app.get('/admin/users', admin, (req, res) => res.json(riskReport()));
app.post('/admin/ban/:id', admin, (req, res) => {
  const u = db.users[req.params.id];
  if (!u) return res.status(404).send('Not found');
  banUser(u, 'Banned by admin');
  save();
  res.send('ok');
});

const REVIEW_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review</title>
<style>body{font:15px system-ui,sans-serif;background:#150704;color:#ffe9cf;margin:0 auto;padding:12px;max-width:620px}h2{margin:14px 0 6px}button{font:inherit;font-weight:700;border:0;border-radius:10px;padding:10px 12px;margin:4px 4px 0 0;color:#fff;background:#e8400c}.ok{background:#1f7a3a}.no{background:#5a1d0e}.ban{background:#8a1020}.tab{background:#2a0d06;border:1px solid #7a2e12}.tab.on{background:#e8400c}.card{border:1px solid #7a2e12;border-radius:12px;padding:12px;margin:10px 0;background:#1d0a05}.card b{font-size:17px}small{opacity:.75}.flag{color:#ffd66b;display:block;margin-top:3px}.safe{color:#7be0a0}.acct{background:#2a0d06;padding:6px 8px;border-radius:8px;word-break:break-all;margin:6px 0;user-select:all}.log{font-size:12px;opacity:.8;margin-top:6px}input{font:inherit;width:100%;box-sizing:border-box;padding:10px;border-radius:10px;border:1px solid #7a2e12;background:#2a0d06;color:#ffe9cf}</style>
<div><button class="tab on" id="t1">Withdrawals</button><button class="tab" id="t2">Users</button></div>
<div id="out">Loading...</div>
<script>
var key=new URLSearchParams(location.search).get('key')||'',q='?key='+encodeURIComponent(key),view=1,users=[],wds=[];
function $(i){return document.getElementById(i)}
function ago(t){var m=Math.round((Date.now()-t)/60000);return m<60?m+'m':m<1440?Math.round(m/60)+'h':Math.round(m/1440)+'d'}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e}
function post(u,after){fetch(u+(u.indexOf('?')>-1?'&':'?')+'key='+encodeURIComponent(key),{method:'POST'}).then(function(r){return r.text()}).then(function(){load()})}
function risk(u){var d=el('div');if(!u.flags.length){d.appendChild(el('span','safe','No warning signs'))}else u.flags.forEach(function(f){d.appendChild(el('span','flag','⚠ '+f))});return d}
function facts(u){return el('small','', 'Joined '+u.ageDays+' days ago | earned '+u.totalEarned+' dra | ads '+u.ads+' | games '+u.games+' | friends counted '+u.friends+' | withdrawals '+u.withdrawals)}
function logs(u){var t=u.log.map(function(e){return ago(e[0])+' '+e[1]+' '+(e[2]>0?'+':'')+e[2]}).join(' · ');return el('div','log',t||'No activity yet')}
function show(){var o=$('out');o.textContent='';
 if(view==1){var p=wds.filter(function(w){return w.status==='pending'}),r=wds.filter(function(w){return w.status!=='pending'}).slice(-15).reverse();
  o.appendChild(el('h2','','Waiting for your approval ('+p.length+')'));
  if(!p.length)o.appendChild(el('small','','Nothing pending.'));
  p.forEach(function(w){var u=users.find(function(x){return x.id===w.userId})||{flags:[],log:[],score:0};var c=el('div','card');
   c.appendChild(el('b','','#'+w.id+' '+w.name+' wants '+w.amount+' dra ($'+(w.usd||0).toFixed(4)+')'));c.appendChild(el('div','', w.method+' | '+(w.wallet||'main')+' wallet'));
   c.appendChild(el('div','acct',w.account));c.appendChild(risk(u));if(u.id)c.appendChild(facts(u));if(u.id)c.appendChild(logs(u));
   var b1=el('button','ok','MARK PAID (I sent it)');b1.onclick=function(){if(confirm('Only tap this after you have sent the money.'))post('/admin/withdrawals/'+w.id+'/paid')};
   var b2=el('button','no','REJECT + REFUND');b2.onclick=function(){if(confirm('Give the dra back to the user?'))post('/admin/withdrawals/'+w.id+'/reject?mode=refund')};
   var b3=el('button','ban','REJECT + BAN');b3.onclick=function(){if(confirm('Ban this user and keep their dra?'))post('/admin/withdrawals/'+w.id+'/reject?mode=ban')};
   c.append(b1,b2,b3);o.appendChild(c)});
  o.appendChild(el('h2','','Recently done'));
  r.forEach(function(w){o.appendChild(el('div','', '#'+w.id+' '+w.name+' '+w.amount+' dra - '+w.status+(w.rejectMode?' ('+w.rejectMode+')':'')))})}
 else{var s=el('input');s.placeholder='Search name or id';s.oninput=function(){draw(s.value)};o.appendChild(s);var box=el('div');o.appendChild(box);
  function draw(f){box.textContent='';users.filter(function(u){return !f||(u.name+' '+u.id).toLowerCase().indexOf(f.toLowerCase())>-1}).slice(0,80).forEach(function(u){var c=el('div','card');
   c.appendChild(el('b','',u.name+' (id '+u.id+') risk '+u.score+(u.banned?' BANNED':'')));c.appendChild(el('div','','main '+u.balance+' | referral '+u.refBal+' | loyalty '+u.loyBal));c.appendChild(risk(u));c.appendChild(facts(u));c.appendChild(logs(u));
   if(u.banned){var a=el('button','ok','UNBAN');a.onclick=function(){post('/admin/unban/'+u.id)};c.appendChild(a)}else{var b=el('button','ban','BAN');b.onclick=function(){if(confirm('Ban '+u.name+'?'))post('/admin/ban/'+u.id)};c.appendChild(b)}
   box.appendChild(c)})}draw('')}}
function load(){Promise.all([fetch('/admin/withdrawals'+q).then(function(r){return r.json()}),fetch('/admin/users'+q).then(function(r){return r.json()})]).then(function(a){wds=a[0];users=a[1];show()}).catch(function(){$('out').textContent='Could not load. Check the key in the link.'})}
$('t1').onclick=function(){view=1;$('t1').className='tab on';$('t2').className='tab';show()};
$('t2').onclick=function(){view=2;$('t2').className='tab on';$('t1').className='tab';show()};
load();
</script>`;
const CODES_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Promo codes</title>
<style>body{font:16px system-ui,sans-serif;background:#150704;color:#ffe9cf;margin:0 auto;padding:16px;max-width:560px}input,button{width:100%;box-sizing:border-box;font:inherit;padding:12px;margin:6px 0;border-radius:10px;border:1px solid #7a2e12;background:#2a0d06;color:#ffe9cf}button{background:#e8400c;border:0;font-weight:700;color:#fff}.t{border:1px solid #7a2e12;border-radius:12px;padding:12px;margin:10px 0}.t b{display:block;font-size:20px;letter-spacing:.08em}.t small{opacity:.75;display:block}.off{background:#5a1d0e;width:auto;padding:8px 14px}#msg{margin-top:8px;color:#ffd66b}</style>
<h2>Promo codes</h2><div id="list">Loading...</div>
<h3>Make a code</h3>
<input id="code" placeholder="Code (leave empty to make a random one)" autocapitalize="characters">
<input id="reward" type="number" inputmode="numeric" placeholder="Reward in dra, for example: 100">
<input id="max" type="number" inputmode="numeric" placeholder="How many people can use it, for example: 20">
<input id="days" type="number" inputmode="numeric" placeholder="Valid for how many days (empty = no end date)">
<button id="add">MAKE CODE</button><div id="msg"></div>
<p><small>Each person can use a code once. Total cost = reward x number of people.</small></p>
<script>
var key=new URLSearchParams(location.search).get('key')||'';
var q='?key='+encodeURIComponent(key);
function $(i){return document.getElementById(i)}
function say(t){$('msg').textContent=t}
function load(){fetch('/admin/codes'+q).then(function(r){return r.json()}).then(function(a){
 var l=$('list');l.textContent='';
 if(!a.length){l.textContent='No codes yet.';return}
 a.forEach(function(c){var d=document.createElement('div');d.className='t';
  var b=document.createElement('b');b.textContent=c.code+(c.active?'':' (off)');
  var s=document.createElement('small');s.textContent=c.reward+' dra | used '+c.used+' of '+c.max+(c.expires?' | ends '+new Date(c.expires).toLocaleDateString():'');
  d.appendChild(b);d.appendChild(s);
  if(c.active){var x=document.createElement('button');x.className='off';x.textContent='TURN OFF';x.onclick=function(){fetch('/admin/codes/'+c.code+'/off'+q,{method:'POST'}).then(load)};d.appendChild(x)}
  l.appendChild(d)})}).catch(function(){$('list').textContent='Could not load. Check the key in the link.'})}
$('add').onclick=function(){
 var body={code:$('code').value,reward:Number($('reward').value),max:Number($('max').value),days:Number($('days').value||0)};
 fetch('/admin/codes'+q,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(d){
  if(d.error){say(d.error);return}say('Code made: '+d.code);['code','reward','max','days'].forEach(function(i){$(i).value=''});load()})};
load();
</script>`;
app.get('/admin/codes-page', admin, (req, res) => res.type('html').send(CODES_PAGE));
app.get('/admin/codes', admin, (req, res) => res.json(Object.values(db.codes || {}).sort((a, b) => b.at - a.at)));
app.post('/admin/codes', admin, (req, res) => {
  const b = req.body || {};
  const reward = Math.floor(Number(b.reward));
  const max = Math.floor(Number(b.max));
  const days = Math.max(0, Number(b.days) || 0);
  let code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
  if (!(reward >= 1 && reward <= 1000000)) return res.status(400).json({ error: 'Write the reward in dra (a number).' });
  if (!(max >= 1 && max <= 1000000)) return res.status(400).json({ error: 'Write how many people can use it (at least 1).' });
  if (!code) { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; do { code = Array.from({ length: 8 }, () => A[crypto.randomInt(0, A.length)]).join(''); } while (db.codes[code]); }
  if (code.length < 4) return res.status(400).json({ error: 'A code needs at least 4 letters or numbers.' });
  if (db.codes[code]) return res.status(400).json({ error: 'This code already exists.' });
  db.codes[code] = { code, reward, max, used: 0, active: true, expires: days ? Date.now() + days * 86400000 : 0, at: Date.now() };
  save();
  res.json(db.codes[code]);
});
app.post('/admin/codes/:code/off', admin, (req, res) => {
  const c = (db.codes || {})[String(req.params.code).toUpperCase()];
  if (!c) return res.status(404).send('Not found');
  c.active = false;
  save();
  res.send('ok');
});
app.get('/admin/review-page', admin, (req, res) => res.type('html').send(REVIEW_PAGE));

// For an uptime pinger, and for the intro page (it checks that the real app is awake; it must be readable from another website).
app.get('/health', (req, res) => { res.set('Access-Control-Allow-Origin', '*'); res.set('Cache-Control', 'no-store'); res.json({ ok: true, app: 'newcash' }); });

const ready = storage.open({ databaseUrl: DATABASE_URL, file: DB_FILE }).then((st) => {
  db = st.db;
  save = st.save;
  closeStorage = st.close;
  console.log('Data storage: ' + (st.kind === 'postgres' ? 'PostgreSQL' : 'local file'));
  if (st.kind === 'file' && !DEV) console.warn('WARNING: data is saved in a local file. Most hosts erase it on restart. Set DATABASE_URL.');
  app.listen(PORT, () => console.log(`App running on port ${PORT}`));
});
ready.catch((e) => { console.error('Could not open the data storage:', e.message); process.exit(1); });

// Save everything before the app stops (hosts send SIGTERM when they restart or redeploy).
async function shutdown() {
  try { if (closeStorage) await closeStorage(); } catch (e) { console.error('Save on exit failed:', e.message); }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---------- Bot: invites, phone verification, and the button that opens the app ----------
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

const openApp = (chatId, text) =>
  tg('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: [[{ text: '▶ Open app', web_app: { url: WEBAPP_URL } }]] },
  });

const askNumber = (chatId) =>
  tg('sendMessage', {
    chat_id: chatId,
    text: 'Welcome! To stop fake accounts, please verify your phone number. Tap the button below. Your number is stored only as a scrambled code.',
    reply_markup: {
      keyboard: [[{ text: '📱 Share my number', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });

// Link a new user to the friend who invited them (only once, and only before they verify).
function setReferrer(user, refId) {
  const inviter = db.users[refId];
  if (user.banned || !inviter || inviter.id === user.id || user.referredBy || user.verified) return;
  if (inviter.referredBy === user.id) return; // no circles
  user.referredBy = inviter.id;
  inviter.referrals.push(user.id);
  save();
}

async function handleContact(m, user) {
  const chatId = m.chat.id;
  if (user.banned) return tg('sendMessage', { chat_id: chatId, text: 'This account is banned.' });
  // The contact must be the person's own number, not a forwarded one.
  if (m.contact.user_id !== m.from.id) {
    return tg('sendMessage', { chat_id: chatId, text: 'Please share your OWN number using the button.' });
  }
  const digits = String(m.contact.phone_number || '').replace(/\D/g, '');
  if (ALLOWED_PHONE_PREFIX && !digits.startsWith(ALLOWED_PHONE_PREFIX)) {
    return tg('sendMessage', { chat_id: chatId, text: `Sorry, this app is only for phone numbers starting with +${ALLOWED_PHONE_PREFIX}.` });
  }
  const h = crypto.createHash('sha256').update(PHONE_SALT + digits).digest('hex');
  const owner = db.phones[h];
  if (owner && owner !== user.id) {
    return tg('sendMessage', { chat_id: chatId, text: 'This number is already linked to another account.' });
  }
  db.phones[h] = user.id;
  user.verified = true;
  save();
  return openApp(chatId, 'Verified ✅ Tap the button to start earning.');
}

async function pollBot() {
  try {
    const me = await tg('getMe', {});
    if (me && me.result && me.result.username) BOT_USERNAME = me.result.username;
  } catch (e) {
    /* set BOT_USERNAME yourself if this fails */
  }
  let offset = 0;
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 30 });
      for (const upd of r.result || []) {
        offset = upd.update_id + 1;
        const m = upd.message;
        if (!m || !m.from || m.chat.type !== 'private') continue;
        const user = getUser(m.from);
        if (m.contact) {
          await handleContact(m, user);
        } else if (m.text && m.text.startsWith('/start')) {
          if (user.banned) { await tg('sendMessage', { chat_id: m.chat.id, text: 'This account is permanently banned because a second account was opened on the same device.' }); continue; }
          const payload = m.text.split(/\s+/)[1] || '';
          if (payload.startsWith('ref_')) setReferrer(user, payload.slice(4));
          if (!REQUIRE_PHONE && !user.verified) { user.verified = true; save(); } // no phone check: device + network limits only
          if (user.verified) await openApp(m.chat.id, 'Welcome back! Tap the button to start.');
          else await askNumber(m.chat.id);
        }
      }
    } catch (e) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
ready.then(() => {
  if (BOT_TOKEN && WEBAPP_URL) pollBot();
  else console.log('Bot not started (set BOT_TOKEN and WEBAPP_URL).');
}).catch(() => {});
