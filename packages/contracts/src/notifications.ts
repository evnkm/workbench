import { z } from "zod";

export const pushSubscriptionSchema = z.object({
  endpoint: z
    .url()
    .max(2048)
    .refine((value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      const host = url.hostname;
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        (host === "fcm.googleapis.com" ||
          host.endsWith(".push.services.mozilla.com") ||
          host.endsWith(".push.apple.com") ||
          host.endsWith(".notify.windows.com"))
      );
    }, "Unsupported browser push endpoint."),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}=?$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}(==)?$/),
  }),
});
export type BrowserPushSubscription = z.infer<typeof pushSubscriptionSchema>;

export type TurnNotification = { title: string; body: string; tag: string; url: string };
