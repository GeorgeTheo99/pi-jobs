import { describeSchedule, duration, relativeTime, repoName, summarizePayload } from "./format";

const NOW = Date.parse("2026-11-09T12:00:00Z");

test("relativeTime picks the largest whole unit", () => {
  expect(relativeTime("2026-11-09T15:00:00Z", NOW)).toBe("in 3 hours");
  expect(relativeTime("2026-11-09T11:55:00Z", NOW)).toBe("5 minutes ago");
  expect(relativeTime("2026-11-09T12:00:20Z", NOW)).toBe("in under a minute");
  expect(relativeTime("2026-11-09T11:59:50Z", NOW)).toBe("just now");
});

test("duration formats running and finished runs", () => {
  expect(duration(null, null, NOW)).toBe("—");
  expect(duration("2026-11-09T11:59:15Z", null, NOW)).toBe("45s");
  expect(duration("2026-11-09T11:00:00Z", "2026-11-09T11:12:05Z")).toBe("12m 5s");
  expect(duration("2026-11-09T09:30:00Z", null, NOW)).toBe("2h 30m");
});

test("describeSchedule names presets and common steps, and passes other cron through", () => {
  expect(describeSchedule(null)).toBe("No schedule");
  expect(describeSchedule("0 6 * * *")).toBe("Daily 6:00");
  expect(describeSchedule("*/10 * * * *")).toBe("Every 10 min");
  expect(describeSchedule("0 */2 * * *")).toBe("Every 2 hours");
  expect(describeSchedule("30 7 * * *")).toBe("Daily 7:30");
  expect(describeSchedule("0 9 * * 1-5")).toBe("Weekdays 9:00");
  expect(describeSchedule("5 4 1 * *")).toBe("5 4 1 * *");
});

test("repoName uses the last path segment", () => {
  expect(repoName("/Users/me/local_code/model-gateway/")).toBe("model-gateway");
});

test("summarizePayload picks a headline and labels plain fields", () => {
  const summary = summarizePayload(
    JSON.stringify({
      id: "home-server/e123",
      kind: "problem",
      release: null,
      has_diagnostics: true,
      attempts: 2,
      context: { page: "/automations" },
      description: "Let me reorder scenes",
      receivedAt: "2026-11-22T22:55:21.845Z",
    }),
  );
  expect(summary.headline).toBe("Let me reorder scenes");
  expect(summary.fields.map((f) => f.label)).toEqual(["Id", "Kind", "Has diagnostics", "Attempts", "Received at"]);
  expect(summary.fields[2].value).toBe("Yes");
  expect(summary.fields[4].value).not.toContain("2026-11-22T");
});

test("summarizePayload prefers a title and handles text, arrays and nothing", () => {
  expect(summarizePayload('{"description": "Details", "title": "Crash when saving"}').headline).toBe("Crash when saving");
  expect(summarizePayload("plain text body\nsecond line")).toEqual({ headline: "plain text body", fields: [] });
  expect(summarizePayload("[1, 2]")).toEqual({ headline: null, fields: [] });
  expect(summarizePayload(null)).toEqual({ headline: null, fields: [] });
  expect(summarizePayload("x".repeat(300)).headline).toHaveLength(200);
});
