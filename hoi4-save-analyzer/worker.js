// Web Worker: parses one save file's text per message so the main thread / UI never blocks.
importScripts("parser.js");

self.onmessage = (e) => {
	const { id, name, text } = e.data;
	try {
		const result = self.HOI4Parser.parseSave(text);
		self.postMessage({ id, name, ok: true, result });
	} catch (err) {
		self.postMessage({ id, name, ok: false, error: String((err && err.stack) || err) });
	}
};
