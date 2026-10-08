import { Type } from "typebox";
import type { CalendarEvent } from "../integrations/types.js";
import { freeSlots, toZonedIso } from "../time.js";
import { defineTool, type ToolContext } from "./types.js";

function describe(e: CalendarEvent, tz: string): string {
  const who = e.attendees.length ? ` with ${e.attendees.join(", ")}` : "";
  const resp = e.responseStatus && e.responseStatus !== "accepted" ? ` [your response: ${e.responseStatus}]` : "";
  return `- ${e.id}: "${e.title}" ${toZonedIso(Date.parse(e.start), tz)} → ${toZonedIso(Date.parse(e.end), tz)}${who}${e.location ? ` @ ${e.location}` : ""}${resp}`;
}

function relate(ctx: ToolContext, e: CalendarEvent): void {
  ctx.app.threads.addRelated(ctx.thread.id, {
    kind: "event",
    title: e.title,
    ref: e.id,
    url: e.htmlLink,
    data: { start: e.start, end: e.end, attendees: e.attendees },
  });
}

function overlaps(events: CalendarEvent[]): string[] {
  const sorted = [...events].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (Date.parse(sorted[j]!.start) < Date.parse(sorted[i]!.end)) out.push(`"${sorted[i]!.title}" overlaps "${sorted[j]!.title}"`);
    }
  }
  return out;
}

export const calendarTools = [
  defineTool({
    name: "list_events",
    label: "Read calendar",
    description: "List calendar events between two date-times (ISO 8601). Also reports conflicts.",
    parameters: Type.Object({ from: Type.String(), to: Type.String() }),
    async run(args, ctx) {
      const tz = ctx.app.settings.get().timezone;
      const cal = ctx.app.integrations.calendar();
      const events = await cal.listEvents(new Date(args.from), new Date(args.to));
      const conflicts = overlaps(events);
      return {
        text: `${cal.name}, times in ${tz}:\n${events.length ? events.map((e) => describe(e, tz)).join("\n") : "No events."}${conflicts.length ? `\nConflicts:\n${conflicts.map((c) => `- ${c}`).join("\n")}` : ""}`,
        details: { count: events.length },
      };
    },
  }),
  defineTool({
    name: "find_free_slots",
    label: "Find free time",
    description: "Find free slots of a given length within working hours between two date-times.",
    parameters: Type.Object({
      from: Type.String(),
      to: Type.String(),
      duration_minutes: Type.Number({ minimum: 5 }),
      include_weekends: Type.Optional(Type.Boolean()),
    }),
    async run(args, ctx) {
      const s = ctx.app.settings.get();
      const from = Math.max(Date.parse(args.from), Date.now());
      const to = Date.parse(args.to);
      const events = await ctx.app.integrations.calendar().listEvents(new Date(from), new Date(to));
      const slots = freeSlots({
        from,
        to,
        durationMin: args.duration_minutes,
        busy: events.filter((e) => e.responseStatus !== "declined").map((e) => ({ start: Date.parse(e.start), end: Date.parse(e.end) })),
        timeZone: s.timezone,
        workdayStart: s.workdayStart,
        workdayEnd: s.workdayEnd,
        includeWeekends: args.include_weekends,
      });
      return {
        text: slots.length
          ? `Free slots (${s.timezone}, working hours ${s.workdayStart}-${s.workdayEnd}):\n${slots.map((x) => `- ${toZonedIso(x.start, s.timezone)} → ${toZonedIso(x.end, s.timezone)}`).join("\n")}`
          : "No free slots in that range.",
      };
    },
  }),
  defineTool({
    name: "create_event",
    label: "Create event",
    description: "Create a calendar event. Events with other attendees send invitations and wait for the owner's confirmation.",
    parameters: Type.Object({
      title: Type.String(),
      start: Type.String({ description: "ISO 8601 with offset" }),
      end: Type.String({ description: "ISO 8601 with offset" }),
      attendees: Type.Optional(Type.Array(Type.String({ description: "Email address" }))),
      location: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
    }),
    confirm: (args) => (args.attendees?.length ?? 0) > 0,
    summarize: (args) =>
      `Create "${args.title}" ${args.start} → ${args.end}${args.attendees?.length ? ` and invite ${args.attendees.join(", ")}` : ""}`,
    async run(args, ctx) {
      const e = await ctx.app.integrations.calendar().createEvent(args);
      relate(ctx, e);
      return { text: `Created event:\n${describe(e, ctx.app.settings.get().timezone)}`, details: { eventId: e.id } };
    },
  }),
  defineTool({
    name: "update_event",
    label: "Move event",
    description: "Change an event's time or details. Changes to events with attendees wait for the owner's confirmation.",
    parameters: Type.Object({
      event_id: Type.String(),
      title: Type.Optional(Type.String()),
      start: Type.Optional(Type.String()),
      end: Type.Optional(Type.String()),
      attendees: Type.Optional(Type.Array(Type.String())),
      location: Type.Optional(Type.String()),
    }),
    confirm: async (args, ctx) => {
      if (args.attendees?.length) return true;
      const events = await ctx.app.integrations.calendar().listEvents(new Date(Date.now() - 365 * 864e5), new Date(Date.now() + 365 * 864e5));
      return (events.find((e) => e.id === args.event_id)?.attendees.length ?? 0) > 0;
    },
    summarize: (args) => `Update event ${args.event_id}${args.start ? ` to ${args.start}` : ""}`,
    async run(args, ctx) {
      const { event_id, ...patch } = args;
      const e = await ctx.app.integrations.calendar().updateEvent(event_id, patch);
      relate(ctx, e);
      return { text: `Updated:\n${describe(e, ctx.app.settings.get().timezone)}` };
    },
  }),
  defineTool({
    name: "delete_event",
    label: "Cancel event",
    description: "Cancel (delete) a calendar event. Always waits for the owner's confirmation.",
    parameters: Type.Object({ event_id: Type.String(), title: Type.Optional(Type.String({ description: "For the confirmation card" })) }),
    confirm: () => true,
    summarize: (args) => `Cancel event ${args.title ? `"${args.title}"` : args.event_id}`,
    async run(args, ctx) {
      await ctx.app.integrations.calendar().deleteEvent(args.event_id);
      return { text: "Event cancelled." };
    },
  }),
  defineTool({
    name: "respond_to_invite",
    label: "Respond to invitation",
    description: "Accept, decline or tentatively accept an invitation. Waits for the owner's confirmation.",
    parameters: Type.Object({
      event_id: Type.String(),
      response: Type.Union([Type.Literal("accepted"), Type.Literal("declined"), Type.Literal("tentative")]),
      title: Type.Optional(Type.String()),
    }),
    confirm: () => true,
    summarize: (args) => `${args.response === "accepted" ? "Accept" : args.response === "declined" ? "Decline" : "Tentatively accept"} ${args.title ? `"${args.title}"` : args.event_id}`,
    async run(args, ctx) {
      const e = await ctx.app.integrations.calendar().respond(args.event_id, args.response);
      return { text: `Responded ${args.response}: ${e.title}` };
    },
  }),
];
