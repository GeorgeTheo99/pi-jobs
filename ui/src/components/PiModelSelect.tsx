import { usePoll } from "@/lib/usePoll";
import { api, type PiModel } from "@/lib/api";

const GROUPS: [group: string, label: string][] = [
  ["bridge", "Claude Code bridge"],
  ["direct", "Subscriptions"],
  ["cloud", "Cloud"],
  ["local", "Local"],
];

/** Pi's model aliases on the server, grouped like `pi models`: one is "pi:<alias>", none is plain Pi. */
export function PiModelSelect({ value, onChange, id }: { value: string | null; onChange: (alias: string | null) => void; id?: string }) {
  const { data, error } = usePoll(api.piModels, null);
  const models = data?.models ?? [];
  const known = value === null || models.some((m) => m.alias === value);
  const fallback = models.find((m) => m.default);
  const groups = [...GROUPS, ...[...new Set(models.map((m) => m.group))].filter((g) => !GROUPS.some(([known]) => known === g)).map((g) => [g, g] as [string, string])];
  const option = (m: PiModel) => (
    <option key={m.alias} value={m.alias}>
      {m.alias === m.name ? m.alias : `${m.alias} — ${m.name}`}
    </option>
  );
  return (
    <div className="grid gap-1">
      <select id={id} aria-label="Pi model" className="field w-auto py-1 text-[13px]" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Pi's default{fallback ? ` (${fallback.alias})` : ""}</option>
        {!known && <option value={value ?? ""}>{value} (not in pi models now)</option>}
        {groups.map(([group, label]) => {
          const inGroup = models.filter((m) => m.group === group);
          return inGroup.length === 0 ? null : (
            <optgroup key={group} label={label}>
              {inGroup.map(option)}
            </optgroup>
          );
        })}
      </select>
      {(data?.error ?? error) && <p className="text-[12px] text-fog">Pi's models can't be listed: {data?.error ?? error?.message}</p>}
    </div>
  );
}
