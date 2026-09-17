// Minimal zero-dependency static file server for local dev/testing of this tool.
// Not part of the shipped app (which is meant to be opened directly as index.html).
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = process.env.PORT || 8934;

const MIME = {
	".html": "text/html", ".js": "text/javascript", ".json": "application/json",
	".hoi4": "text/plain", ".css": "text/css",
};

http.createServer((req, res) => {
	let reqPath = decodeURIComponent(req.url.split("?")[0]);
	if (reqPath === "/") reqPath = "/index.html";
	const filePath = path.join(root, reqPath);
	if (!filePath.startsWith(root)) { res.writeHead(403); res.end(); return; }
	fs.readFile(filePath, (err, data) => {
		if (err) { res.writeHead(404); res.end("Not found: " + reqPath); return; }
		const ext = path.extname(filePath);
		res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
		res.end(data);
	});
}).listen(port, () => console.log(`Dev server on http://localhost:${port}`));
