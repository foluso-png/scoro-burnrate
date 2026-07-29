{/*
 * -----------------------------------------------------------------------
 * PLACEHOLDER PALETTE — NOT VERIFIED CAMPFIRE BRAND COLOURS
 * -----------------------------------------------------------------------
 * These colours are a warm, campfire-inspired palette chosen for feel,
 * not pulled from an official brand guide. Swap them when the real
 * palette is confirmed. Search for "PLACEHOLDER PALETTE" to find them.
 *
 * --cf-bg:        #20140d   (dark background)
 * --cf-card:      #2A1D14   (card background)
 * --cf-card-bdr:  #3D2B1E   (card border)
 * --cf-gold:      #FAC775   (accent / eyebrow)
 * --cf-cream:     #FDF6EC   (headings / primary text)
 * --cf-warm-grey: #C9B8A8   (body text)
 * --cf-muted:     #8A7968   (secondary text)
 * --cf-ember:     #D85A30   (primary button)
 * --cf-ember-hov: #C04E28   (primary button hover)
 * --cf-success:   #5B9A5F   (success accent)
 * --cf-error:     #D85A30   (error accent — reuses ember)
 * -----------------------------------------------------------------------
 */}

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
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: "#20140d" }}
    >
      {/* Hero */}
      <div className="flex-1 flex items-center justify-center px-4 py-16">
        <div className="w-full max-w-xl text-center">
          {/* Eyebrow */}
          <p
            className="text-[13px] font-medium tracking-wide mb-4 flex items-center justify-center gap-1.5"
            style={{ color: "#FAC775" }}
          >
            <FlameIcon />
            campfire
          </p>

          {/* Heading */}
          <h1
            className="text-[30px] font-bold mb-3"
            style={{ color: "#FDF6EC" }}
          >
            Timesheet co-pilot
          </h1>

          {/* Subheading */}
          <p
            className="text-base leading-relaxed mb-8 max-w-md mx-auto"
            style={{ color: "#C9B8A8" }}
          >
            Connect your calendar once. Get a draft timesheet in Slack every
            evening, ready to review and submit.
          </p>

          {/* Success state */}
          {isConnected && (
            <div
              className="mb-8 mx-auto max-w-sm rounded-lg px-5 py-4 text-left"
              style={{
                backgroundColor: "rgba(91,154,95,0.12)",
                border: "1px solid rgba(91,154,95,0.3)",
              }}
            >
              <p className="font-medium mb-1" style={{ color: "#8FD694" }}>
                You&apos;re connected
                {params.email ? ` as ${params.email}` : ""}.
              </p>
              <p className="text-sm" style={{ color: "#C9B8A8" }}>
                You&apos;ll get your first summary this afternoon. If you
                can&apos;t wait, message the bot &quot;wrap up my day&quot; in
                Slack.
              </p>
            </div>
          )}

          {/* Error state */}
          {isError && (
            <div
              className="mb-8 mx-auto max-w-sm rounded-lg px-5 py-4 text-left text-sm"
              style={{
                backgroundColor: "rgba(216,90,48,0.12)",
                border: "1px solid rgba(216,90,48,0.3)",
                color: "#F0A080",
              }}
            >
              {params.message || "Something went wrong. Please try again."}
            </div>
          )}

          {/* CTA button */}
          {!isConnected && (
            <a
              href="/api/auth/google"
              className="cf-btn-ember inline-block px-6 py-3 text-white font-medium rounded-lg transition-colors"
            >
              Connect Google Calendar
            </a>
          )}
        </div>
      </div>

      {/* Feature cards */}
      {!isConnected && (
        <div className="px-4 pb-12">
          <div className="max-w-3xl mx-auto grid grid-cols-1 sm:grid-cols-3 gap-4">
            <FeatureCard
              icon={<CalendarIcon />}
              title="Reads your calendar"
              description="Matches meetings to Scoro projects automatically."
            />
            <FeatureCard
              icon={<ChatIcon />}
              title="Chat to fix it"
              description="Correct anything wrong, right inside Slack."
            />
            <FeatureCard
              icon={<ShieldIcon />}
              title="You stay in control"
              description="Nothing submits until you approve it."
            />
          </div>

          {/* Privacy line */}
          <p
            className="text-center text-sm mt-6 flex items-center justify-center gap-1.5"
            style={{ color: "#8A7968" }}
          >
            <LockIcon />
            Personal events like lunch are skipped automatically and never
            included.
          </p>
        </div>
      )}

      {/* Privacy details (FAQ-style) */}
      {!isConnected && (
        <div
          className="px-4 pb-16"
          style={{ borderTop: "1px solid #2A1D14" }}
        >
          <div className="max-w-xl mx-auto pt-10">
            <h2
              className="text-lg font-semibold mb-4"
              style={{ color: "#FDF6EC" }}
            >
              Your privacy
            </h2>
            <ul
              className="space-y-2 text-sm leading-relaxed"
              style={{ color: "#C9B8A8" }}
            >
              <li className="flex items-start gap-2">
                <span style={{ color: "#8A7968" }} className="mt-0.5 shrink-0">
                  &bull;
                </span>
                It only reads your own calendar.
              </li>
              <li className="flex items-start gap-2">
                <span style={{ color: "#8A7968" }} className="mt-0.5 shrink-0">
                  &bull;
                </span>
                Only you see your own summary.
              </li>
              <li className="flex items-start gap-2">
                <span style={{ color: "#8A7968" }} className="mt-0.5 shrink-0">
                  &bull;
                </span>
                Nothing is ever submitted to Scoro without you confirming it.
              </li>
              <li className="flex items-start gap-2">
                <span style={{ color: "#8A7968" }} className="mt-0.5 shrink-0">
                  &bull;
                </span>
                All entries are drafts until you submit your week yourself.
              </li>
              <li className="flex items-start gap-2">
                <span style={{ color: "#8A7968" }} className="mt-0.5 shrink-0">
                  &bull;
                </span>
                It does not read your Slack messages in channels.
              </li>
              <li className="flex items-start gap-2">
                <span style={{ color: "#8A7968" }} className="mt-0.5 shrink-0">
                  &bull;
                </span>
                You can disconnect at any time.
              </li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------
 * Inline SVG icon components
 * ------------------------------------------------------------------- */

function FlameIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: "#FAC775" }}
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: "#FAC775" }}
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: "#FAC775" }}
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

/* -------------------------------------------------------------------
 * Feature card component
 * ------------------------------------------------------------------- */

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div
      className="rounded-lg px-5 py-5"
      style={{
        backgroundColor: "#2A1D14",
        border: "1px solid #3D2B1E",
      }}
    >
      <div className="mb-3">{icon}</div>
      <h3
        className="text-sm font-semibold mb-1"
        style={{ color: "#FDF6EC" }}
      >
        {title}
      </h3>
      <p className="text-sm leading-relaxed" style={{ color: "#C9B8A8" }}>
        {description}
      </p>
    </div>
  );
}
