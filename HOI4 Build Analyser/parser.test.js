// Smoke test for parser.js against real sample saves in test-saves/.
// Run with: node parser.test.js
const fs = require("fs");
const path = require("path");
const { parseSave, dateSortKey } = require("./parser.js");

const dir = path.join(__dirname, "test-saves");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".hoi4"));

let failures = 0;
function assertEq(actual, expected, label) {
	if (actual !== expected) {
		failures++;
		console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	} else {
		console.log(`ok   ${label}: ${JSON.stringify(actual)}`);
	}
}
function assertTrue(cond, label, extra) {
	if (!cond) {
		failures++;
		console.log(`FAIL ${label}${extra ? " (" + extra + ")" : ""}`);
	} else {
		console.log(`ok   ${label}`);
	}
}

console.log(`Parsing ${files.length} save(s) from ${dir} ...`);
const parsed = [];
for (const f of files) {
	const t0 = Date.now();
	const text = fs.readFileSync(path.join(dir, f), "utf8");
	const result = parseSave(text);
	const ms = Date.now() - t0;
	console.log(`  ${f}: date=${result.date} countries=${Object.keys(result.countries).length} (${ms}ms, ${(text.length / 1e6).toFixed(1)}MB)`);
	parsed.push({ file: f, ...result });
}

parsed.sort((a, b) => a.dateSortKey - b.dateSortKey);
console.log("\nSorted order:", parsed.map((p) => `${p.file}(${p.date})`).join(" -> "));

const byDate = {};
for (const p of parsed) byDate[p.date] = p;

console.log("\n--- ENG focus progression ---");
for (const p of parsed) {
	const f = p.countries.ENG && p.countries.ENG.focus;
	console.log(`${p.date}: current=${f && f.current} progress=${f && f.progress} completedCount=${f && f.completed.length}`);
}

if (byDate["1938.7.1.1"] && byDate["1938.8.1.1"] && byDate["1938.9.1.1"]) {
	const jul = byDate["1938.7.1.1"].countries.ENG.focus;
	const aug = byDate["1938.8.1.1"].countries.ENG.focus;
	const sep = byDate["1938.9.1.1"].countries.ENG.focus;
	assertEq(jul.current, "uk_waves_focus", "ENG current focus in July");
	assertEq(jul.progress, 34, "ENG July progress");
	assertEq(aug.current, "uk_waves_focus", "ENG current focus in August");
	assertEq(aug.progress, 65, "ENG August progress");
	assertEq(sep.current, "air_rearmament_focus", "ENG current focus in September");
	assertTrue(sep.completed.includes("uk_waves_focus"), "ENG September completed list includes uk_waves_focus");
	assertTrue(!jul.completed.includes("uk_waves_focus"), "ENG July completed list does NOT yet include uk_waves_focus");
	assertEq(aug.completed.length - jul.completed.length, 0, "ENG completed count unchanged July->August (still mid-focus)");
	assertEq(sep.completed.length - aug.completed.length, 1, "ENG completed count +1 August->September (uk_waves_focus finished)");

	console.log("\n--- ENG political power ---");
	console.log(`July PP=${jul ? "?" : ""}`);
	const julPP = byDate["1938.7.1.1"].countries.ENG.politics.political_power;
	console.log(`July political_power = ${julPP}`);
	assertTrue(Math.abs(julPP - 77.23112) < 0.001, "ENG July political_power ~= 77.23112", `got ${julPP}`);

	console.log("\n--- GER technology dated entries ---");
	const gerTech = byDate["1938.7.1.1"].countries.GER.technology;
	const engines1 = gerTech.done.find((t) => t.id === "engines_1");
	assertTrue(!!engines1, "GER has a done entry for engines_1");
	if (engines1) assertEq(engines1.date, "1936.1.1.12", "GER engines_1 completion date");
	const construction3 = gerTech.inProgress.find((t) => t.id === "construction3");
	assertTrue(!!construction3, "GER has an in-progress entry for construction3 (no level yet)");

	console.log("\n--- ENG production lines ---");
	const engProd = byDate["1938.7.1.1"].countries.ENG.production;
	console.log(`naval_lines: ${engProd.naval_lines.length}, military_lines: ${engProd.military_lines.length}`);
	assertTrue(engProd.naval_lines.length > 0, "ENG has naval_lines entries");
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
