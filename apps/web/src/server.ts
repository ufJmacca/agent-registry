import http from "node:http";

const port = 3000;
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Agent Registry</title>
  </head>
  <body>
    <main>
      <h1>Agent Registry</h1>
      <p>Web console placeholder for tenant admins and publishers.</p>
    </main>
  </body>
</html>`;

http
  .createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  })
  .listen(port, () => {
    console.log(`web placeholder listening on http://0.0.0.0:${port}`);
  });
