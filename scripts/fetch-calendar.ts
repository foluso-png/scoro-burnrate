import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Load .env.local
// ---------------------------------------------------------------------------
const envPath = path.resolve(__dirname, "..", ".env.local");
const envContent = fs.readFileSync(envPath, "utf-8");
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;
  process.env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env.local");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------
const TOKENS_PATH = path.resolve(__dirname, "..", "data", "google-tokens.json");

interface Tokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  [key: string]: unknown;
}

function loadTokens(): Tokens {
  if (!fs.existsSync(TOKENS_PATH)) {
    console.error("data/google-tokens.json not found. Run the OAuth flow at /connect first.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf-8"));
}

function saveTokens(tokens: Tokens): void {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

async function getAccessToken(): Promise<string> {
  const tokens = loadTokens();

  if (tokens.access_token && tokens.expiry_date > Date.now() + 60_000) {
    console.log("Token still valid, reusing.");
    return tokens.access_token;
  }

  console.log("Token expired, refreshing...");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Token refresh failed: ${res.status} ${body}`);
    process.exit(1);
  }

  const data = await res.json();
  tokens.access_token = data.access_token;
  tokens.expiry_date = Date.now() + data.expires_in * 1000;
  if (data.refresh_token) {
    tokens.refresh_token = data.refresh_token;
  }
  saveTokens(tokens);
  console.log("Token refreshed and saved.");
  return tokens.access_token;
}

// ---------------------------------------------------------------------------
// Fetch today's events
// ---------------------------------------------------------------------------
interface GCalEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email: string; self?: boolean }>;
}

interface FormattedEvent {
  start: string;
  end: string;
  title: string;
  attendees: string[];
  isInternal: boolean;
}

function formatTime(isoOrDate: string): string {
  const d = new Date(isoOrDate);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function fetchTodayEvents(accessToken: string): Promise<FormattedEvent[]> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  const params = new URLSearchParams({
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
  });

  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Calendar API failed: ${res.status} ${body}`);
    process.exit(1);
  }

  const data = await res.json();
  const items: GCalEvent[] = data.items || [];

  return items
    .filter((e) => e.start?.dateTime && e.end?.dateTime) // skip all-day events
    .map((e) => {
      const otherAttendees = (e.attendees || [])
        .filter((a) => !a.self)
        .map((a) => a.email);

      const internalDomains = ["@campfire.co.uk", "@resource.calendar.google.com"];
      const isInternalEmail = (email: string) => internalDomains.some((d) => email.endsWith(d));

      const externalDomains = otherAttendees
        .filter((email) => !isInternalEmail(email))
        .map((email) => email.split("@")[1]);

      const uniqueDomains = [...new Set(externalDomains)];

      const isInternal =
        otherAttendees.length === 0 ||
        otherAttendees.every(isInternalEmail);

      return {
        start: formatTime(e.start!.dateTime!),
        end: formatTime(e.end!.dateTime!),
        title: e.summary || "(no title)",
        attendees: uniqueDomains,
        isInternal,
      };
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Fetch Google Calendar Events ===\n");

  const accessToken = await getAccessToken();
  console.log("");

  const today = new Date();
  const dateLabel = today.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  console.log(`Fetching events for: ${dateLabel}\n`);

  const events = await fetchTodayEvents(accessToken);

  const outPath = path.resolve(__dirname, "..", "data", "today-events.json");
  fs.writeFileSync(outPath, JSON.stringify(events, null, 2), "utf-8");

  if (events.length === 0) {
    console.log("No events found for today — calendar is empty.");
    console.log(`\nSaved empty array to ${outPath}`);
    return;
  }

  console.log(`Found ${events.length} event(s):\n`);
  for (const e of events) {
    const external = e.attendees.length > 0 ? e.attendees.join(", ") : "";
    const tag = e.isInternal ? "[internal]" : `[external: ${external}]`;
    console.log(`  ${e.start}–${e.end}  ${e.title}  ${tag}`);
  }

  console.log(`\nSaved to ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
