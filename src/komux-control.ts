export type ZoomOwnPane = (zoomed: boolean) => Promise<boolean | undefined>;

export function komuxZoom(env: Record<string, string | undefined> = process.env): ZoomOwnPane | undefined {
  const { KOMUX_SOCKET: socket, KOMUX_PANE_ID: pane } = env;
  if (!socket || !pane || !/^\d+$/.test(pane)) return undefined;
  const paneId = Number(pane);
  return async (zoomed) => {
    const reply = await request(socket, { method: "pane.zoom", params: { paneId, zoomed } }).catch(() => undefined);
    if (!reply || typeof reply !== "object" || !("ok" in reply) || reply.ok !== true) return undefined;
    const result = (reply as { result?: { wasZoomed?: unknown } }).result;
    return typeof result?.wasZoomed === "boolean" ? result.wasZoomed : undefined;
  };
}

function request(path: string, body: unknown, timeoutMs = 1000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let received = "";
    let open: { end: () => void } | undefined;
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      open?.end();
      outcome();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("komux did not answer"))), timeoutMs);
    Bun.connect({
      unix: path,
      socket: {
        open(connection) {
          open = connection;
          connection.write(`${JSON.stringify(body)}\n`);
        },
        data(_connection, data) {
          received += data.toString();
          const newline = received.indexOf("\n");
          if (newline < 0) return;
          finish(() => {
            try {
              resolve(JSON.parse(received.slice(0, newline)));
            } catch (error) {
              reject(error);
            }
          });
        },
        close() {
          finish(() => reject(new Error("komux closed the connection")));
        },
        error(_connection, error) {
          finish(() => reject(error));
        },
      },
    }).catch((error: Error) => finish(() => reject(error)));
  });
}
