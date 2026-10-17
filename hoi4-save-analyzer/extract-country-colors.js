// Build-time tool (Node only): reads common/countries/colors.txt and pulls each tracked
// tag's color_ui (the brighter variant HOI4 itself uses for UI elements like the country
// picker, as opposed to `color`, the duller one used for map painting) as {r,g,b}. Bakes to
// country-colors.json. Values are mostly `rgb {r g b}`; Japan's mod entry uses `hsv {h s v}`
// instead (with v occasionally >1, an HOI4-ism — clamped before converting).
//
// Re-run whenever the mod's country color definitions change:
//   node extract-country-colors.js "<mod folder>" "<base game folder>"
const fs = require("fs");
const path = require("path");
const { walkAndCapture, TARGET_TAGS } = require("./parser.js");

function hsvToRgb(h, s, v) {
	h = ((h % 1) + 1) % 1;
	s = Math.min(Math.max(s, 0), 1);
	v = Math.min(Math.max(v, 0), 1);
	const i = Math.floor(h * 6);
	const f = h * 6 - i;
	const p = v * (1 - s);
	const q = v * (1 - f * s);
	const u = v * (1 - (1 - f) * s);
	let r, g, b;
	switch (i % 6) {
		case 0: [r, g, b] = [v, u, p]; break;
		case 1: [r, g, b] = [q, v, p]; break;
		case 2: [r, g, b] = [p, v, u]; break;
		case 3: [r, g, b] = [p, q, v]; break;
		case 4: [r, g, b] = [u, p, v]; break;
		default: [r, g, b] = [v, p, q]; break;
	}
	return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function main() {
	const modDir = process.argv[2];
	const gameDir = process.argv[3];
	if (!modDir || !gameDir) {
		console.error("Usage: node extract-country-colors.js <mod folder> <base game folder>");
		process.exit(1);
	}
	const modFile = path.join(modDir, "common", "countries", "colors.txt");
	const gameFile = path.join(gameDir, "common", "countries", "colors.txt");
	const text = fs.readFileSync(fs.existsSync(modFile) ? modFile : gameFile, "utf8");

	const entries = walkAndCapture(text, (k) => TARGET_TAGS.includes(k));
	const out = {};
	for (const tag of TARGET_TAGS) {
		const bodies = entries.get(tag) || [];
		if (!bodies.length) { console.warn(`${tag}: not found in colors.txt`); continue; }
		const body = bodies[bodies.length - 1];
		const m = /color_ui\s*=\s*(rgb|hsv)\s*\{\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\}/i.exec(body);
		if (!m) { console.warn(`${tag}: no color_ui field`); continue; }
		const [, kind, a, b, c] = m;
		out[tag] = kind.toLowerCase() === "hsv" ? hsvToRgb(Number(a), Number(b), Number(c)) : { r: Number(a), g: Number(b), b: Number(c) };
	}

	console.log(`Found colors for ${Object.keys(out).length}/${TARGET_TAGS.length} tracked tags.`);
	fs.writeFileSync(path.join(__dirname, "country-colors.json"), JSON.stringify(out));
	console.log("Wrote country-colors.json");
}

main();
