"use client";

interface DemoToggleProps {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

export default function DemoToggle({ enabled, onToggle }: DemoToggleProps) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!enabled)}
      className={`relative inline-flex h-7 w-[52px] shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
        enabled ? "bg-blue-500" : "bg-border"
      }`}
    >
      <span className="sr-only">Toggle demo mode</span>
      <span
        className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
          enabled ? "translate-x-6" : "translate-x-0.5"
        }`}
      />
      <span className="ml-2 text-xs font-medium text-card-foreground whitespace-nowrap absolute left-14">
        Demo
      </span>
    </button>
  );
}
