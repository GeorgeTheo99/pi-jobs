import { CalendarClock, History, Settings } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { api, isActive } from "@/lib/api";
import { usePoll } from "@/lib/usePoll";

const NAV = [
  { to: "/", label: "Jobs", icon: CalendarClock, end: true },
  { to: "/runs", label: "Runs", icon: History, end: false },
  { to: "/settings", label: "Settings", icon: Settings, end: false },
];

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-7" />
      <span className="text-[15px] font-extrabold tracking-[-0.02em]">pi-jobs</span>
    </div>
  );
}

function ActiveCount() {
  const { data } = usePoll(() => api.runs(undefined, 50), 3000);
  const active = data?.filter((run) => isActive(run.status)).length ?? 0;
  if (active === 0) return <span className="text-fog">Idle</span>;
  return (
    <span className="inline-flex items-center gap-2 text-amber">
      <span aria-hidden className="size-1.5 rounded-full bg-amber" />
      {active} active
    </span>
  );
}

const navClass = ({ isActive: active }: { isActive: boolean }) =>
  `flex min-h-10 items-center gap-2.5 rounded-[10px] px-3 text-[13px] font-semibold transition-colors duration-150 ${
    active ? "bg-amber/10 text-amber" : "text-fog hover:bg-channel hover:text-bone"
  }`;

export function Layout() {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[232px_1fr]">
      <aside className="sticky top-0 z-10 self-start border-b border-steel/40 bg-inkwell pt-[var(--safe-top)] md:h-dvh md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-4 px-4 py-3 md:flex-col md:items-stretch md:gap-6 md:px-3 md:py-5">
          <div className="md:px-2">
            <Brand />
          </div>
          <nav aria-label="Main" className="flex gap-1 md:flex-col">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink key={to} to={to} end={end} className={navClass}>
                <Icon aria-hidden className="size-4" />
                <span className="max-sm:sr-only">{label}</span>
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="control-label absolute bottom-5 left-5 hidden md:block">
          <ActiveCount />
        </div>
      </aside>
      <main className="mx-auto w-full max-w-[1120px] px-4 pt-6 pb-[calc(40px+var(--safe-bottom))] sm:px-8 md:pt-9">
        <Outlet />
      </main>
    </div>
  );
}
