import http from "node:http";

const port = 4000;
const payload = JSON.stringify({
  service: "api",
  status: "ok",
  summary: "REST API placeholder for the agent registry.",
});

http
  .createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(payload);
  })
  .listen(port, () => {
    console.log(`api placeholder listening on http://0.0.0.0:${port}`);
  });
