
const API = "https://api.github.com";

function getConfig() {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  const branch = process.env.GITHUB_BRANCH || "main";

  if (!owner || !repo || !token) {
    throw new Error("GitHub storage environment variables are missing.");
  }

  return { owner, repo, token, branch };
}

function getHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

function getFileURL(owner, repo, path) {
  const safePath = path
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${safePath}`;
}

async function readJSON(path, fallback = {}) {
  const { owner, repo, token, branch } = getConfig();

  const url =
    `${getFileURL(owner, repo, path)}?ref=${encodeURIComponent(branch)}`;

  const response = await fetch(url, {
    headers: getHeaders(token)
  });

  if (response.status === 404) {
    return {
      data: fallback,
      sha: null
    };
  }

  if (!response.ok) {
    throw new Error(
      `GitHub read failed (${response.status}): ${await response.text()}`
    );
  }

  const file = await response.json();

  if (!file.content || !file.sha) {
    throw new Error(`GitHub returned incomplete file data: ${path}`);
  }

  const decoded = Buffer.from(
    file.content.replace(/\s/g, ""),
    "base64"
  ).toString("utf8");

  let data;

  try {
    data = JSON.parse(decoded);
  } catch (_) {
    throw new Error(`Invalid JSON stored in ${path}`);
  }

  return {
    data,
    sha: file.sha
  };
}

async function writeJSON(path, data, existingSHA = null) {
  const { owner, repo, token, branch } = getConfig();

  const url = getFileURL(owner, repo, path);
  const headers = getHeaders(token);

  let sha = existingSHA;

  // If no SHA was supplied, check whether the file already exists.
  if (!sha) {
    const lookup = await fetch(
      `${url}?ref=${encodeURIComponent(branch)}`,
      { headers }
    );

    if (lookup.ok) {
      const existing = await lookup.json();
      sha = existing.sha;
    } else if (lookup.status !== 404) {
      throw new Error(
        `GitHub file lookup failed (${lookup.status}): ${await lookup.text()}`
      );
    }
  }

  const content = Buffer.from(
    JSON.stringify(data, null, 2),
    "utf8"
  ).toString("base64");

  const payload = {
    message: `Update ${path}`,
    content,
    branch
  };

  if (sha) {
    payload.sha = sha;
  }

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(
      `GitHub write failed (${response.status}): ${await response.text()}`
    );
  }

  const result = await response.json();

  return {
    data,
    sha: result.content?.sha || null
  };
}

module.exports = {
  readJSON,
  writeJSON
};
