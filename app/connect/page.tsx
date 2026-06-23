export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; message?: string }>;
}) {
  const params = await searchParams;

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-md p-8 max-w-md w-full">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">
          Timesheet Co-pilot
        </h1>

        {params.status === "success" && (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded text-green-800 text-sm">
            Successfully connected to Google Calendar.
          </div>
        )}

        {params.status === "error" && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-800 text-sm">
            {params.message || "An error occurred during connection."}
          </div>
        )}

        <div>
          <p className="text-gray-600 mb-4">
            Connect your Google Calendar so the matcher can read your real
            events.
          </p>
          <a
            href="/api/auth/google"
            className="block text-center w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
          >
            Connect Google Calendar
          </a>
        </div>
      </div>
    </div>
  );
}
