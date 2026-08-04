import { createServer } from "node:http";

const port = Number(process.env.PORT ?? "3107");
const messages = [];

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
    return;
  }
  if (request.method === "GET" && request.url === "/messages") {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json",
    });
    response.end(JSON.stringify(messages));
    return;
  }
  if (request.method === "DELETE" && request.url === "/messages") {
    messages.length = 0;
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "POST" && request.url === "/emails") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 128_000) request.destroy();
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        messages.push(parsed);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: `test-email-${messages.length}` }));
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"message":"invalid"}');
      }
    });
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(port, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
