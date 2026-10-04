// Cron schedules with an explicit IANA timezone. DST behavior of the
// underlying cron-parser 5.10.1, verified in Phase 8 (decision 0007):
//   - a local time skipped by spring-forward runs one hour later (02:30 -> 03:30)
//   - a local time repeated by fall-back runs once, at its first occurrence
import { CronExpressionParser } from "cron-parser";

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Throws a readable error for an invalid expression or timezone. */
export function nextOccurrences(cron: string, timezone: string, after: Date, count: number): Date[] {
  if (!validTimezone(timezone)) throw new Error(`Unknown timezone ${timezone}.`);
  if (cron.trim().split(/\s+/).length !== 5)
    throw new Error("Use a five-field cron expression: minute hour day month weekday.");
  let it: ReturnType<typeof CronExpressionParser.parse>;
  try {
    it = CronExpressionParser.parse(cron, { tz: timezone, currentDate: after });
  } catch (e) {
    throw new Error(`Invalid cron expression: ${(e as Error).message}`);
  }
  const out: Date[] = [];
  for (let i = 0; i < count; i++) out.push(it.next().toDate());
  return out;
}

export function nextOccurrence(cron: string, timezone: string, after: Date): Date {
  return nextOccurrences(cron, timezone, after, 1)[0]!;
}
