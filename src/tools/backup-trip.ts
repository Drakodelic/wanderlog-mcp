import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { TripPlan } from "../types.js";
import { listStateIds, loadState, newStateId, saveState, stateHash } from "./advanced-state.js";

export type BackupRecord = {
  backup_id: string;
  trip_key: string;
  created_at: string;
  label: string;
  trip_title: string;
  start_date: string;
  end_date: string;
  sections: TripPlan["itinerary"]["sections"];
  sha256: string;
};

export async function saveTripBackup(
  ctx: AppContext, trip: TripPlan, label = "Manual snapshot",
): Promise<Omit<BackupRecord, "sections">> {
  const record: BackupRecord = {
    backup_id: newStateId(), trip_key: trip.key, created_at: new Date().toISOString(),
    label: label.slice(0, 120), trip_title: trip.title,
    start_date: trip.startDate, end_date: trip.endDate,
    sections: structuredClone(trip.itinerary.sections),
    sha256: stateHash(trip.itinerary.sections),
  };
  await saveState(ctx, trip.key, "backups", record.backup_id, record);
  const { sections: _sections, ...info } = record;
  return info;
}

export async function readTripBackup(
  ctx: AppContext, trip: string, backupId: string,
): Promise<BackupRecord> {
  const backup = await loadState<BackupRecord>(ctx, trip, "backups", backupId);
  if (backup.trip_key !== trip || !Array.isArray(backup.sections) ||
      stateHash(backup.sections) !== backup.sha256) {
    throw new WanderlogValidationError("Backup integrity check failed.");
  }
  return backup;
}

export const backupTripInputSchema = {
  trip_key: z.string().min(1),
  action: z.enum(["create", "list"]).default("create"),
  label: z.string().max(120).optional(),
};

export const backupTripDescription = [
  "Create or list encrypted local itinerary backups. Backups preserve the full section",
  "objects, including notes, times, places, and reservation metadata.",
  "Requires WANDERLOG_MCP_STATE_KEY and persistent filesystem storage.",
  "The encryption key and local files must be retained to restore backups later.",
  "No Wanderlog itinerary modifications are performed.",
].join(" ");

type Args = { trip_key: string; action?: "create" | "list"; label?: string };

export async function backupTrip(ctx: AppContext, args: Args) {
  try {
    let result: unknown;
    if ((args.action ?? "create") === "list") {
      const ids = await listStateIds(ctx, args.trip_key, "backups");
      const backups: Array<Omit<BackupRecord, "sections">> = [];
      for (const id of ids) {
        const backup = await readTripBackup(ctx, args.trip_key, id);
        const { sections: _sections, ...info } = backup;
        backups.push(info);
      }
      result = { trip_key: args.trip_key, backups };
    } else {
      const trip = await ctx.tripCache.get(args.trip_key);
      result = { created: true, backup: await saveTripBackup(ctx, trip, args.label) };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const message = error instanceof WanderlogError
      ? error.toUserMessage()
      : "Unexpected error: " + (error as Error).message;
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
}
