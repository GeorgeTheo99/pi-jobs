import { Check, Copy, LoaderCircle } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { AGENT_LABELS, type AgentId, type RunStatus } from "@/lib/api";

const STATUS_STYLES: Record<RunStatus, { label: string; className: string }> = {
  queued: { label: "Queued", className: "border-steel/70 text-fog" },
  running: { label: "Running", className: "border-amber/45 bg-amber/10 text-amber" },
  succeeded: { label: "Succeeded", className: "border-green/40 bg-green/10 text-green" },
  failed: { label: "Failed", className: "border-red/45 bg-red/10 text-red" },
  timed_out: { label: "Timed out", className: "border-red/45 bg-red/10 text-red" },
  canceled: { label: "Canceled", className: "border-steel/70 text-fog" },
};

export function StatusPill({ status }: { status: RunStatus }) {
  const { label, className } = STATUS_STYLES[status];
  return (
    <span
      className={`control-label inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] whitespace-nowrap ${className}`}
    >
      {status === "running" ? (
        <LoaderCircle aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />
      ) : (
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
      )}
      {label}
    </span>
  );
}

export function AgentBadge({ agent, inherited = false }: { agent: AgentId; inherited?: boolean }) {
  return (
    <span className="control-label inline-flex items-center rounded-full border border-steel/60 px-2.5 py-[3px] whitespace-nowrap text-bone">
      {AGENT_LABELS[agent]}
      {inherited && <span className="ml-1 font-semibold text-fog">· default</span>}
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors duration-150 disabled:opacity-50 ${
        checked ? "border-amber/60 bg-amber/25" : "border-steel/70 bg-inkwell"
      }`}
    >
      <span
        aria-hidden
        className={`size-4 rounded-full transition-transform duration-150 ease-out ${
          checked ? "translate-x-[19px] bg-amber" : "translate-x-[3px] bg-fog"
        }`}
      />
    </button>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
    >
      {copied ? <Check className="size-4 text-green" /> : <Copy className="size-4" />}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: (props: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error || hint ? `${id}-note` : undefined;
  return (
    <div className="grid content-start gap-1.5">
      <label htmlFor={id} className="text-[13px] font-semibold text-bone">
        {label}
      </label>
      {children({ id, "aria-invalid": Boolean(error), "aria-describedby": describedBy })}
      {(error || hint) && (
        <p id={describedBy} className={`text-[12px] leading-snug ${error ? "text-red" : "text-fog"}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export function PageHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="page-heading truncate">{title}</h1>
        {meta && <div className="mt-1.5 text-[13px] text-fog">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function ErrorNote({ error }: { error: Error | string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-[10px] border border-red/40 bg-red/10 px-3.5 py-2.5 text-[13px] text-red">
      {typeof error === "string" ? error : error.message}
    </p>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy className="grid gap-px overflow-hidden rounded-[14px] border border-steel/40">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-[60px] animate-pulse bg-inkwell/60 motion-reduce:animate-none" />
      ))}
    </div>
  );
}
