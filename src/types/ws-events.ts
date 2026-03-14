import { z } from "zod";

export const WsEventTypeSchema = z.enum([
  "telemetry",
  "terminal_out",
  "worker_status",
  "system",
]);

export const WsEventSchema = z.object({
  type: WsEventTypeSchema,
  payload: z.unknown(),
});

export type WsEventType = z.infer<typeof WsEventTypeSchema>;
export type WsEvent = z.infer<typeof WsEventSchema>;

