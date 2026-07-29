export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    message?: string;
    email?: string;
    name?: string;
  }>;
}) {
  const params = await searchParams;
  const isConnected = params.status === "success";
  const isError = params.status === "error";

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-md p-8 max-w-lg w-full">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          Timesheet Co-pilot
        </h1>
        <p className="text-gray-500 text-sm mb-6">
          Your daily timesheet, drafted for you.
        </p>

        {isConnected && (
          <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
            <p className="text-green-800 font-medium mb-1">
              You&apos;re connected
              {params.email ? ` as ${params.email}` : ""}.
            </p>
            <p className="text-green-700 text-sm">
              You&apos;ll get your first summary this afternoon. If you
              can&apos;t wait, message the bot &quot;wrap up my day&quot; in
              Slack.
            </p>
          </div>
        )}

        {isError && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
            {params.message || "Something went wrong. Please try again."}
          </div>
        )}

        {!isConnected && (
          <>
            <div className="space-y-4 text-gray-700 text-sm leading-relaxed mb-6">
              <div>
                <h2 className="font-semibold text-gray-900 mb-1">
                  What it does
                </h2>
                <p>
                  It reads your Google Calendar, uses AI to match your meetings
                  to the right Scoro project, and sends you a private Slack
                  message each afternoon with a draft of your timesheet.
                </p>
              </div>

              <div>
                <h2 className="font-semibold text-gray-900 mb-1">
                  How it helps
                </h2>
                <p>
                  Instead of filling in your timesheet from memory at the end of
                  the week, you get a two-minute review each day. You can add or
                  correct time just by chatting with the bot in Slack.
                </p>
              </div>

              <div>
                <h2 className="font-semibold text-gray-900 mb-1">
                  What happens after connecting
                </h2>
                <p>
                  Every weekday afternoon you&apos;ll get a Slack DM with your
                  draft timesheet for the day. You can also ask for it any time
                  by messaging the bot &quot;wrap up my day&quot;.
                </p>
              </div>

              <div>
                <h2 className="font-semibold text-gray-900 mb-1">
                  Your privacy
                </h2>
                <ul className="list-disc list-inside space-y-1 text-gray-600">
                  <li>It only reads your own calendar.</li>
                  <li>Only you see your own summary.</li>
                  <li>
                    Nothing is ever submitted to Scoro without you confirming it.
                  </li>
                  <li>
                    All entries are drafts until you submit your week yourself.
                  </li>
                  <li>
                    It does not read your Slack messages in channels.
                  </li>
                  <li>You can disconnect at any time.</li>
                </ul>
              </div>
            </div>

            <a
              href="/api/auth/google"
              className="block text-center w-full px-4 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              Connect your Google Calendar
            </a>
          </>
        )}
      </div>
    </div>
  );
}
