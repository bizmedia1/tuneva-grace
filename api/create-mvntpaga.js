
const crypto = require("crypto");

const {
  readJSON,
  writeJSON
} = require("../lib/github-storage");

const {
  normalizeUsername,
  normalizeEmail,
  validUsername,
  hashPassword
} = require("../lib/auth");

const PAYMENTS_FILE = "data/payments.json";
const USERS_FILE = "data/users.json";

const ACTIVATION_AMOUNT_KOBO = 530000;
const ACTIVATION_EXPIRY_MINUTES = 50;

function send(res, status, data) {
  return res.status(status).json(data);
}

function makeReference() {
  return (
    "tv_" + Date.now() + "_" +
    crypto.randomBytes(5).toString("hex")
  ).slice(0, 32);
}

function makePaymentId() {
  return "PAY-TUNEVA-" + crypto.randomBytes(12).toString("hex");
}

function makeStatusToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256")
    .update(String(token))
    .digest("hex");
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return send(res, 405, {
      status: false,
      message: "Method not allowed."
    });
  }

  try {
    const secretKey = process.env.MOVANTRA_SECRET_KEY;

    if (!secretKey) {
      return send(res, 500, {
        status: false,
        message: "Payment service is not configured."
      });
    }

    const body = req.body || {};

    const customerName = String(
      body.customer_name || body.name || ""
    ).trim();

    const customerEmail = normalizeEmail(
      body.customer_email || body.email
    );

    const customerPhone = String(
      body.customer_phone || body.phone || ""
    ).trim();

    const username = normalizeUsername(body.username);
    const password = String(body.password || "");

    if (!customerName || !customerEmail) {
      return send(res, 400, {
        status: false,
        message: "Name and email are required."
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      return send(res, 400, {
        status: false,
        message: "Enter a valid email address."
      });
    }

    if (!validUsername(username)) {
      return send(res, 400, {
        status: false,
        message: "Username must be 3–20 characters using letters, numbers or underscores."
      });
    }

    if (password.length < 8 || password.length > 128) {
      return send(res, 400, {
        status: false,
        message: "Password must be at least 8 characters."
      });
    }

    const suppliedAmount = body.amount_kobo !== undefined
      ? Number(body.amount_kobo)
      : body.amount !== undefined
        ? Math.round(Number(body.amount) * 100)
        : ACTIVATION_AMOUNT_KOBO;

    if (
      !Number.isSafeInteger(suppliedAmount) ||
      suppliedAmount !== ACTIVATION_AMOUNT_KOBO
    ) {
      return send(res, 400, {
        status: false,
        code: "invalid_activation_amount",
        message: "Tuneva activation costs exactly NGN 5,300."
      });
    }

    const [userFile, paymentFile] = await Promise.all([
      readJSON(USERS_FILE, { users: [] }),
      readJSON(PAYMENTS_FILE, { payments: [] })
    ]);

    const users = Array.isArray(userFile.data?.users)
      ? userFile.data.users
      : [];

    const payments = Array.isArray(paymentFile.data?.payments)
      ? paymentFile.data.payments
      : [];

    const usernameExists = users.some(user =>
      normalizeUsername(user.username) === username
    );

    const emailExists = users.some(user =>
      normalizeEmail(user.email) === customerEmail
    );

    const pendingExists = payments.some(payment =>
      payment.status === "pending" &&
      (
        normalizeUsername(payment.username) === username ||
        normalizeEmail(payment.email) === customerEmail
      )
    );

    if (usernameExists || emailExists || pendingExists) {
      return send(res, 409, {
        status: false,
        code: "account_exists",
        message: "This username or email is already registered or awaiting activation."
      });
    }

    const passwordHash = await hashPassword(password);

    const reference = makeReference();

    const movantraBody = {
      amount_kobo: ACTIVATION_AMOUNT_KOBO,
      customer_name: customerName,
      customer_email: customerEmail,
      reference,
      expiry_minutes: ACTIVATION_EXPIRY_MINUTES
    };

    if (customerPhone) {
      movantraBody.customer_phone = customerPhone;
    }

    if (process.env.PAGA_CALLBACK_URL) {
      movantraBody.callback_url = process.env.PAGA_CALLBACK_URL;
    }

    const providerResponse = await fetch(
      "https://api.movantrapay.com/v1/paga/dynamic-accounts",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(movantraBody)
      }
    );

    let result;

    try {
      result = await providerResponse.json();
    } catch (_) {
      return send(res, 502, {
        status: false,
        message: "Invalid response from payment provider."
      });
    }

    if (!providerResponse.ok || !result || result.status !== true) {
      console.error("[TUNEVA] Movantra account error:", result);

      return send(res, 502, {
        status: false,
        message: result?.message ||
          "Unable to create your payment account."
      });
    }

    if (
      !result.account_number ||
      !result.account_name ||
      !result.bank_name
    ) {
      return send(res, 502, {
        status: false,
        message: "Payment provider returned incomplete account details."
      });
    }

    const providerReference = String(
      result.reference || reference
    ).trim();

    if (!providerReference) {
      return send(res, 502, {
        status: false,
        message: "Invalid payment reference."
      });
    }

    const paymentId = makePaymentId();
    const statusToken = makeStatusToken();
    const createdAt = new Date().toISOString();

    const paymentRecord = {
      id: paymentId,
      customerName,
      username,
      email: customerEmail,
      phone: customerPhone,
      passwordHash,

      amount: ACTIVATION_AMOUNT_KOBO / 100,
      amountKobo: ACTIVATION_AMOUNT_KOBO,

      method: "paga",
      provider: "movantra",

      reference: providerReference,
      status: "pending",
      statusTokenHash: hashToken(statusToken),

      createdAt,
      processedAt: null,

      activation: true,
      activationExpiresAt:
        result.expires_at ||
        new Date(
          Date.now() +
          ACTIVATION_EXPIRY_MINUTES * 60 * 1000
        ).toISOString(),

      pofPass: null,
      pofGeneratedAt: null,
      pofUsed: false,
      pofUsedAt: null
    };

    if (
      payments.some(item =>
        String(item.reference || "") === providerReference
      )
    ) {
      return send(res, 409, {
        status: false,
        message: "Payment reference already exists."
      });
    }

    await writeJSON(
      PAYMENTS_FILE,
      {
        ...(paymentFile.data || {}),
        payments: [paymentRecord, ...payments]
      },
      paymentFile.sha
    );

    return send(res, 200, {
      status: true,
      paymentId,
      statusToken,
      reference: providerReference,
      account_number: result.account_number,
      account_name: result.account_name,
      bank_name: result.bank_name,
      amount_kobo: ACTIVATION_AMOUNT_KOBO,
      fee_kobo: result.fee_kobo ?? null,
      net_kobo: result.net_kobo ?? null,
      status_text: result.status_text || "pending",
      expires_at: paymentRecord.activationExpiresAt,
      mode: result.mode || null
    });

  } catch (error) {
    console.error("[TUNEVA] Payment creation error:", error);

    return send(res, 500, {
      status: false,
      message: "Unable to create your payment account."
    });
  }
};
