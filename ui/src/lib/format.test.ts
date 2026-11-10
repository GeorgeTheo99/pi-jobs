import { describeSchedule, duration, relativeTime, repoName } from "./format";

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

test("describeSchedule names presets and passes other cron through", () => {
  expect(describeSchedule(null)).toBe("No schedule");
  expect(describeSchedule("0 6 * * *")).toBe("Daily 6:00");
  expect(describeSchedule("*/10 * * * *")).toBe("*/10 * * * *");
});

test("repoName uses the last path segment", () => {
  expect(repoName("/Users/me/local_code/model-gateway/")).toBe("model-gateway");
});
