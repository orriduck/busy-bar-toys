/** Simulated BUSY upstream. No network egress and no actual BUSY credentials. */
let draws = 0,
  uploads = 0,
  clears = 0;
export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/__demo/state")
      return Response.json({ demo: true, draws, uploads, clears });
    const auth = request.headers.get("Authorization");
    if (
      ![
        "Bearer demo-token",
        "Bearer demo-blocked",
        "Bearer demo-offline",
      ].includes(auth ?? "")
    )
      return Response.json({ error: "fake_token_required" }, { status: 401 });
    if (url.pathname === "/busybar/status")
      return Response.json({ device: { serial_number: "DEMO-BUSY-BAR-0001" } });
    if (url.pathname === "/busybar/version")
      return Response.json({ version: "DEMO" });
    if (auth === "Bearer demo-offline")
      return Response.json({ error: "simulated_offline" }, { status: 503 });
    if (
      auth === "Bearer demo-blocked" &&
      request.method === "POST" &&
      url.pathname === "/busybar/display/draw"
    )
      return Response.json(
        { error: "simulated_priority_conflict" },
        { status: 409 },
      );
    if (request.method === "POST" && url.pathname === "/busybar/display/draw") {
      draws++;
      return Response.json({ success: true });
    }
    if (
      request.method === "DELETE" &&
      url.pathname === "/busybar/display/draw"
    ) {
      clears++;
      return Response.json({ success: true });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/busybar/assets/upload"
    ) {
      uploads++;
      return Response.json({ success: true });
    }
    return Response.json({ error: "demo_endpoint_forbidden" }, { status: 403 });
  },
} satisfies ExportedHandler;
