const fs = require("fs");
const path = require("path");

const envContent = fs.readFileSync(path.resolve(__dirname, "..", ".env.local"), "utf-8");
for (const line of envContent.split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}

const BASE = "https://" + process.env.SCORO_SUBDOMAIN + ".scoro.com/api/v2";

async function getEntry(id) {
  const res = await fetch(BASE + "/timeEntries/view/" + id, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: process.env.SCORO_API_KEY,
      company_account_id: process.env.SCORO_ACCOUNT_ID,
    }),
  });
  return res.json();
}

async function main() {
  for (const id of [163860, 163861]) {
    console.log("=== Time Entry " + id + " ===");
    const result = await getEntry(id);
    delete result.apiKey;
    console.log(JSON.stringify(result, null, 2));
    console.log("");
  }
}
main();
