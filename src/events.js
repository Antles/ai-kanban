// Server-Sent Events fan-out so the board (or an agent) can watch changes live.
export class EventHub {
  constructor() {
    this.clients = new Set();
  }

  subscribe(req, res, project) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const client = { res, project: project ? project.toUpperCase() : null };
    this.clients.add(client);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      this.clients.delete(client);
    });
  }

  publish(event) {
    const payload = `event: change\ndata: ${JSON.stringify({ ...event, at: new Date().toISOString() })}\n\n`;
    for (const client of this.clients) {
      if (!client.project || client.project === event.project) client.res.write(payload);
    }
  }

  closeAll() {
    for (const client of this.clients) client.res.end();
    this.clients.clear();
  }
}
