const security = require("../../extension/security.js");

const cases = [
  ["known provider", "https://api.openai.com/v1/chat/completions", "", true],
  ["provider subdomain attack", "https://api.openai.com.evil.test/", "", false],
  ["unknown HTTPS exfiltration", "https://example.com/collect", "", false],
  ["local custom gateway", "http://localhost:11434/v1/models", "http://localhost:11434/v1", true],
  ["custom origin mismatch", "http://127.0.0.1:11434/v1/models", "http://localhost:11434/v1", false],
  ["HTTPS custom gateway", "https://llm.example.com/v1/models", "https://llm.example.com/v1", true],
  ["insecure remote custom gateway", "http://llm.example.com/v1/models", "http://llm.example.com/v1", false],
  ["file scheme", "file:///tmp/secret", "", false],
  ["extension scheme", "chrome-extension://abc/options.html", "", false],
  ["embedded credentials", "https://key@api.openai.com/v1/models", "", false],
];

const started = performance.now();
const results = cases.map(([name, url, custom, expected]) => {
  const actual = security.validateProviderUrl(url, custom).ok;
  return { name, expected, actual, pass: actual === expected };
});
const elapsedMs = performance.now() - started;
const passed = results.filter((result) => result.pass).length;

console.log(JSON.stringify({ suite: "outbound-request-policy", passed, total: results.length, elapsedMs: Number(elapsedMs.toFixed(3)), results }, null, 2));

if (passed !== results.length) process.exitCode = 1;
