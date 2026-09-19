/**
 * NotificationAdapter — the replaceable transport for human decisions.
 *
 * MVP transport is ntfy.sh: a free push service with a real phone app
 * (iOS/Android) and HTTP action buttons, so "Approve exactly $X" on the phone
 * POSTs straight back to the relay's webhook. Swap this file to use Pushover,
 * Telegram, or SMS — budget enforcement never changes, because the notifier
 * is a transport, not the security boundary.
 */

export interface ApprovalNotification {
  approvalId: string;
  title: string;
  body: string;
  approveUrl: string;
  denyUrl: string;
  dashboardUrl: string;
}

const NTFY_SERVER = process.env.NTFY_SERVER ?? "https://ntfy.sh";

function topic(): string {
  const t = process.env.NTFY_TOPIC;
  if (!t) throw new Error("NTFY_TOPIC is not set. Pick a long random topic name and subscribe to it in the ntfy app.");
  return t;
}

export async function sendApprovalPush(n: ApprovalNotification): Promise<void> {
  const res = await fetch(NTFY_SERVER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topic: topic(),
      title: n.title,
      message: n.body,
      priority: 5,
      tags: ["moneybag", "lock"],
      actions: [
        { action: "http", label: "Approve", url: n.approveUrl, method: "POST", clear: true },
        { action: "http", label: "Deny", url: n.denyUrl, method: "POST", clear: true },
        { action: "view", label: "Dashboard", url: n.dashboardUrl },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ntfy publish failed: ${res.status} ${await res.text()}`);
}

export async function sendInfoPush(title: string, message: string, tags: string[] = ["robot"]): Promise<void> {
  try {
    await fetch(NTFY_SERVER, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: topic(), title, message, priority: 3, tags }),
    });
  } catch (err) {
    console.warn("[notify] info push failed:", (err as Error).message);
  }
}
