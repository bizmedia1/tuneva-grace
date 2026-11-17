
const {
  readJSON,
  writeJSON
} = require("../lib/github-storage");

const {
  verifySessionToken,
  getCookie,
  setCors
} = require("../lib/auth");

const USERS_FILE = "data/users.json";
const EARNINGS_FILE = "data/earnings.json";

const INITIAL_BALANCE = 0;

const TAP_POINTS = 350;
const TAP_REWARD = 100;
const DAILY_TAP_LIMIT = 3000;

const VIDEO_REWARD = 1750;

const VIDEO_REWARDS = {
  "seyi-vibes": {
    title: "Seyi Vibes",
    reward: VIDEO_REWARD
  },

  "bigger-escapes": {
    title: "For Bigger Escapes",
    reward: VIDEO_REWARD
  },

  "bigger-fun": {
    title: "For Bigger Fun",
    reward: VIDEO_REWARD
  },

  "bigger-joyrides": {
    title: "For Bigger Joyrides",
    reward: VIDEO_REWARD
  }
};

function send(res, status, data) {
  return res.status(status).json(data);
}

function todayInNigeria() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function createId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 12)
  );
}

function newAccount() {
  return {
    balance: INITIAL_BALANCE,
    todayDate: todayInNigeria(),
    todayEarnings: 0,

    tapPoints: 0,
    tapCount: 0,

    tapDailyPoints: 0,
    tapDailyEarnings: 0,

    videoEarnings: 0,
    claimedVideos: [],
    processedEvents: [],
    history: [],
    lastTapAt: 0
  };
}

function normalizeAccount(account) {
  const fresh = newAccount();

  const saved = account && typeof account === "object"
    ? account
    : {};

  return {
    ...fresh,
    ...saved,

    claimedVideos: Array.isArray(saved.claimedVideos)
      ? saved.claimedVideos
      : [],

    processedEvents: Array.isArray(saved.processedEvents)
      ? saved.processedEvents
      : [],

    history: Array.isArray(saved.history)
      ? saved.history
      : []
  };
}

function resetDailyIfNeeded(account) {
  const today = todayInNigeria();

  if (account.todayDate !== today) {
    account.todayDate = today;
    account.todayEarnings = 0;

    account.tapDailyPoints = 0;
    account.tapDailyEarnings = 0;
  }
}

function publicAccount(account) {
  return {
    balance: account.balance,
    todayEarnings: account.todayEarnings,

    tapPoints: account.tapPoints,
    tapCount: account.tapCount,

    tapDailyPoints: account.tapDailyPoints,
    tapDailyEarnings: account.tapDailyEarnings,

    tapLimitReached:
      account.tapDailyEarnings >= DAILY_TAP_LIMIT,

    videoEarnings: account.videoEarnings,
    claimedVideos: account.claimedVideos,
    history: account.history
  };
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  const allowedOrigin = process.env.TUNEVA_FRONTEND_ORIGIN;

  if (
    allowedOrigin &&
    req.headers.origin &&
    req.headers.origin !== allowedOrigin
  ) {
    return send(res, 403, {
      ok: false,
      message: "Origin not allowed."
    });
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");

    return send(res, 405, {
      ok: false,
      message: "Method not allowed."
    });
  }

  try {
    const token = getCookie(req, "tuneva_session");
    const session = verifySessionToken(token);

    if (!session || !session.sub) {
      return send(res, 401, {
        ok: false,
        message: "Please log in again."
      });
    }

    const usersResult = await readJSON(USERS_FILE, {
      users: []
    });

    const users = Array.isArray(usersResult.data)
      ? usersResult.data
      : Array.isArray(usersResult.data?.users)
        ? usersResult.data.users
        : [];

    const user = users.find(function (item) {
      return item.id === session.sub && item.status === "active";
    });

    if (!user) {
      return send(res, 401, {
        ok: false,
        message: "Your account could not be verified."
      });
    }

    const earningsResult = await readJSON(
      EARNINGS_FILE,
      { users: {} }
    );

    const database =
      earningsResult.data &&
      typeof earningsResult.data === "object"
        ? earningsResult.data
        : { users: {} };

    if (
      !database.users ||
      typeof database.users !== "object"
    ) {
      database.users = {};
    }

    let account = normalizeAccount(
      database.users[user.id]
    );

    resetDailyIfNeeded(account);

    // GET ACCOUNT EARNINGS

    if (req.method === "GET") {
      database.users[user.id] = account;

      await writeJSON(
        EARNINGS_FILE,
        database,
        earningsResult.sha
      );

      return send(res, 200, {
        ok: true,
        earnings: publicAccount(account)
      });
    }

    // POST EARNINGS ACTION

    const body = req.body || {};

    const action = String(body.action || "");
    const eventId = String(body.eventId || "");

    if (
      !eventId ||
      eventId.length > 100 ||
      !/^[a-zA-Z0-9_-]+$/.test(eventId)
    ) {
      return send(res, 400, {
        ok: false,
        message: "A valid event ID is required."
      });
    }

    // PREVENT DUPLICATE EVENTS

    if (account.processedEvents.includes(eventId)) {
      return send(res, 200, {
        ok: true,
        duplicate: true,
        earnings: publicAccount(account)
      });
    }

    // TAP REWARDS

    if (action === "tap") {
      // ENFORCE DAILY TAP EARNINGS LIMIT

      if (
        account.tapDailyEarnings + TAP_REWARD >
        DAILY_TAP_LIMIT
      ) {
        return send(res, 200, {
          ok: true,
          limitReached: true,
          message: "You have reached your daily Tap Tap earnings limit of ₦3,000.",
          earnings: publicAccount(account)
        });
      }

      const now = Date.now();

      if (now - Number(account.lastTapAt || 0) < 200) {
        return send(res, 429, {
          ok: false,
          message: "Please slow down and try again."
        });
      }

      account.lastTapAt = now;

      account.tapPoints += TAP_POINTS;
      account.tapCount += 1;

      account.tapDailyPoints += TAP_POINTS;
      account.tapDailyEarnings += TAP_REWARD;

      account.balance += TAP_REWARD;
      account.todayEarnings += TAP_REWARD;

      account.history.unshift({
        id: eventId,
        title: "Tap Rewards",
        subtitle: "Tap Tap",
        amount: TAP_REWARD,
        date: new Date().toISOString(),
        currency: "NGN"
      });
    }

    // VIDEO REWARDS

    else if (action === "video") {
      const videoId = String(body.videoId || "");

      const video = VIDEO_REWARDS[videoId];

      if (!video) {
        return send(res, 400, {
          ok: false,
          message: "Unknown video reward."
        });
      }

      if (account.claimedVideos.includes(videoId)) {
        return send(res, 409, {
          ok: false,
          message: "This video reward has already been claimed."
        });
      }

      // Record the claimed video.

      account.claimedVideos.push(videoId);

      // Add the reward.

      account.videoEarnings += video.reward;
      account.balance += video.reward;
      account.todayEarnings += video.reward;

      // Record the correct video title.

      account.history.unshift({
        id: eventId,
        title: "Video Rewards",
        subtitle: video.title,
        amount: video.reward,
        date: new Date().toISOString(),
        currency: "NGN"
      });
    }

    else {
      return send(res, 400, {
        ok: false,
        message: "Invalid earnings action."
      });
    }

    // SAVE PROCESSED EVENT

    account.processedEvents.push(eventId);

    account.processedEvents =
      account.processedEvents.slice(-1000);

    account.history =
      account.history.slice(0, 500);

    database.users[user.id] = account;

    await writeJSON(
      EARNINGS_FILE,
      database,
      earningsResult.sha
    );

    return send(res, 200, {
      ok: true,
      earnings: publicAccount(account)
    });

  } catch (error) {
    console.error("[TUNEVA EARNINGS]", error);

    return send(res, 500, {
      ok: false,
      message: "Unable to save earnings. Please try again."
    });
  }
};
