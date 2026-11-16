// Evidence harness for the R-55 proof (not repo tooling): occupies a port during the acceptance
// run and logs every request it receives. The runner must never send one here.
//   node C:/Temp/r55-port3000-sentinel.js [port]      (default 3000)
const fs = require("node:fs");
const http = require("node:http");

const port = Number(process.argv[2] ?? 3000);
const LOG = `C:/Temp/r55-port${port}-hits.log`;
fs.writeFileSync(LOG, "");
http
  .createServer((req, res) => {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${req.method} ${req.url}\n`);
    res.end("this is not the acceptance server");
  })
  .listen(port, () => console.log(`sentinel listening on port ${port}; requests are logged to ${LOG}`));
