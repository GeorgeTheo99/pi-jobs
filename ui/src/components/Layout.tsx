import { CalendarClock, Inbox, Settings } from "lucide-react";
import { useMemo } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { api } from "@/lib/api";
import { WAITING_STATES, groupItems } from "@/lib/items";
import { usePoll, useRefreshOnChange } from "@/lib/usePoll";

const NAV = [
  { to: "/", label: "Inbox", icon: Inbox, end: true, badge: true },
  { to: "/jobs", label: "Jobs", icon: CalendarClock, end: false, badge: false },
  { to: "/settings", label: "Settings", icon: Settings, end: false, badge: false },
];

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-7" />
      <span className="text-[15px] font-extrabold tracking-[-0.02em]">pi-jobs</span>
    </div>
  );
}

/** How many items wait on the owner: runs to approve and proposals to decide on. */
function useWaitingCount(): number {
  const { data, refresh } = usePoll(() => api.runs(undefined, 200), 5000);
  useRefreshOnChange(refresh);
  return useMemo(() => (data ? groupItems(data).filter((item) => WAITING_STATES.includes(item.state)).length : 0), [data]);
}

function Badge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-amber px-1.5 text-[11px] leading-5 font-bold text-midnight tabular-nums">
      {count}
    </span>
  );
}

export function Layout() {
  const waiting = useWaitingCount();
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[220px_1fr]">
      <aside className="sticky top-0 hidden h-dvh self-start border-r border-steel/30 bg-inkwell/70 md:block">
        <div className="flex flex-col gap-6 px-3 py-5">
          <div className="px-2">
            <Brand />
          </div>
          <nav aria-label="Main" className="flex flex-col gap-1">
            {NAV.map(({ to, label, icon: Icon, end, badge }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex min-h-10 items-center gap-2.5 rounded-[10px] px-3 text-[13px] font-semibold transition-colors duration-150 ${
                    isActive ? "bg-channel text-bone" : "text-fog hover:bg-channel/60 hover:text-bone"
                  }`
                }
              >
                <Icon aria-hidden className="size-4" />
                {label}
                {badge && <Badge count={waiting} />}
              </NavLink>
            ))}
          </nav>
        </div>
      </aside>

      <header className="flex items-center px-4 pt-[calc(12px+var(--safe-top))] pb-1 md:hidden">
        <Brand />
      </header>

      <main className="mx-auto w-full max-w-[1040px] px-4 pt-5 pb-[calc(88px+var(--safe-bottom))] sm:px-8 md:pt-9 md:pb-12">
        <Outlet />
      </main>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-steel/40 bg-abyss/95 pb-[var(--safe-bottom)] backdrop-blur md:hidden"
      >
        {NAV.map(({ to, label, icon: Icon, end, badge }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${isActive ? "text-amber" : "text-fog"}`
            }
          >
            <span className="relative">
              <Icon aria-hidden className="size-5" />
              {badge && waiting > 0 && (
                <span className="absolute -top-1.5 -right-2.5 min-w-4 rounded-full bg-amber px-1 text-center text-[10px] leading-4 font-bold text-midnight">
                  {waiting}
                </span>
              )}
            </span>
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
