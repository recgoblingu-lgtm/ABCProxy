
const express = require("express");
const dns = require("node:dns").promises;
const net = require("node:net");
const path = require("node:path");

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

app.disable("x-powered-by");
app.use(express.static(PUBLIC_DIR));

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => n < 0 || n > 255)) return true;

  return (
    p[0] === 0 ||
    p[0] === 10 ||
    p[0] === 127 ||
    p[0] >= 224 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 198 && (p[1] === 18 || p[1] === 19))
  );
}

function isPrivateIPv6(ip) {
  const value = ip.toLowerCase().split("%")[0];

  if (value === "::" || value === "::1") return true;
  if (/^f[cd]/.test(value) || /^fe[89ab]/.test(value)) return true;

  if (value.startsWith("::ffff:")) {
    const embedded = value.slice(7);
    if (net.isIP(embedded) === 4) return isPrivateIPv4(embedded);
  }

  return false;
}

async function validateUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid website URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS websites are supported.");
  }

  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not allowed.");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Private and local hosts are not allowed.");
  }

  const ipVersion = net.isIP(hostname);

  if (ipVersion === 4 && isPrivateIPv4(hostname)) {
    throw new Error("Private IP addresses are not allowed.");
  }

  if (ipVersion === 6 && isPrivateIPv6(hostname)) {
    throw new Error("Private IP addresses are not allowed.");
  }

  if (!ipVersion) {
    let addresses;

    try {
      addresses = await dns.lookup(hostname, { all: true });
    } catch {
      throw new Error("The website could not be resolved.");
    }

    if (
      !addresses.length ||
      addresses.some(entry =>
        entry.family === 4
          ? isPrivateIPv4(entry.address)
          : isPrivateIPv6(entry.address)
      )
    ) {
      throw new Error("The host is private or unavailable.");
    }
  }

  return url;
}

app.get("/proxy", async (req, res) => {
  const input = req.query.url;

  if (typeof input !== "string" || input.length > 2048) {
    return res.status(400).send("Provide a valid URL.");
  }

  try {
    let target = await validateUrl(input);
    let response;

    for (let redirects = 0; redirects <= 4; redirects++) {
      response = await fetch(target, {
        redirect: "manual",
        signal: AbortSignal.timeout(12000),
        headers: {
          "User-Agent": "AbC-Proxy/1.0",
          "Accept": "text/html,text/plain,application/json"
        }
      });

      if (![301, 302, 303, 307, 308].includes(response.status)) {
        break;
      }

      const location = response.headers.get("location");
      if (!location || redirects === 4) {
        return res.status(502).send("Too many redirects.");
      }

      await response.body?.cancel();
      target = await validateUrl(new URL(location, target).href);
    }

    if (!response || !response.ok) {
      await response?.body?.cancel();
      return res.status(502).send("The website returned an error.");
    }

    const type = response.headers.get("content-type") || "";

    if (
      !type.includes("text/html") &&
      !type.includes("text/plain") &&
      !type.includes("application/json")
    ) {
      await response.body?.cancel();
      return res.status(415).send("This proxy supports HTML, text, and JSON only.");
    }

    const declaredLength = Number(response.headers.get("content-length"));

    if (declaredLength > 2 * 1024 * 1024) {
      await response.body?.cancel();
      return res.status(413).send("The response is too large.");
    }

    const body = await response.text();

    if (Buffer.byteLength(body, "utf8") > 2 * 1024 * 1024) {
      return res.status(413).send("The response is too large.");
    }

    res.set("Cache-Control", "no-store");
    res.type(type.includes("text/html") ? "html" : "text");
    res.send(body);
  } catch (error) {
    res.status(400).send(error.message || "Unable to load the website.");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AbC Proxy running on port ${PORT}`);
});
