import { listRegisteredUsers, loadTokens } from "@/lib/google-auth";
import { loadLastRun, LastRunRecord } from "@/lib/last-run";
import { loadUserPrefs, UserPrefs } from "@/lib/user-prefs";

interface UserRow {
  slackId: string;
  name: string | null;
  email: string | null;
  lastRun: LastRunRecord | null;
  prefs: UserPrefs;
}

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const slackIds = await listRegisteredUsers();

  const users: UserRow[] = await Promise.all(
    slackIds.map(async (slackId) => {
      const [tokens, lastRun, prefs] = await Promise.all([
        loadTokens(slackId),
        loadLastRun(slackId),
        loadUserPrefs(slackId),
      ]);
      return {
        slackId,
        name: tokens?.name ?? null,
        email: tokens?.email ?? null,
        lastRun,
        prefs,
      };
    })
  );

  users.sort((a, b) =>
    (a.name || a.email || a.slackId).localeCompare(
      b.name || b.email || b.slackId
    )
  );

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">
          Timesheet Co-pilot — Admin
        </h1>
        <p className="text-gray-500 text-sm mb-6">
          {users.length} registered user{users.length !== 1 ? "s" : ""}
        </p>

        {users.length === 0 ? (
          <p className="text-gray-600">No users have connected yet.</p>
        ) : (
          <div className="bg-white rounded-lg shadow overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-gray-100 text-gray-600 uppercase text-xs">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Slack ID</th>
                  <th className="px-4 py-3">Delivery</th>
                  <th className="px-4 py-3">Last run</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Entries</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {users.map((u) => (
                  <tr key={u.slackId} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {u.name || "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {u.email || "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-500 font-mono text-xs">
                      {u.slackId}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {u.prefs.paused ? (
                        <span className="text-amber-700 bg-amber-50 px-2 py-0.5 rounded text-xs font-medium">
                          Paused
                        </span>
                      ) : (
                        formatHour(u.prefs.deliveryHour)
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {u.lastRun
                        ? formatTimestamp(u.lastRun.timestamp)
                        : "Never"}
                    </td>
                    <td className="px-4 py-3">
                      {u.lastRun ? (
                        <span
                          className={
                            u.lastRun.status === "ok"
                              ? "text-green-700 bg-green-50 px-2 py-0.5 rounded text-xs font-medium"
                              : "text-red-700 bg-red-50 px-2 py-0.5 rounded text-xs font-medium"
                          }
                        >
                          {u.lastRun.status === "ok" ? "OK" : "Error"}
                        </span>
                      ) : (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {u.lastRun ? u.lastRun.entryCount : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatHour(hour: number): string {
  const h = hour % 12 || 12;
  const ampm = hour < 12 ? "am" : "pm";
  return `${h}${ampm}`;
}
