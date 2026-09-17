// Regenerates index.html from index.template.html by inlining:
//   - WORKER_BLOB_SOURCE: parser.js + worker.js, so the app's background Worker can be
//     built from a Blob (works even when index.html is opened via file://, see the
//     comment above its usage in the template for why that's necessary).
//   - PARSER_SOURCE / TIMELINE_BUILDER_SOURCE: parser.js and timeline-builder.js, inlined
//     directly as <script> bodies so the main thread has window.HOI4Parser/TimelineBuilder
//     without a separate <script src>. index.html must stay openable on its own (double
//     click, no server) — external <script src="parser.js"> tags would 404 the moment
//     someone shares just the .html file, so these get baked in exactly like everything else.
//   - FOCUS_TREES: focus-trees.json (from extract-focus-trees.js)
//   - LAW_IDEAS: law-ideas.json (from extract-idea-metadata.js)
//   - CHARACTER_NAMES: character-names.json (from extract-character-names.js)
//   - TECH_YEARS: tech-years.json (from extract-tech-years.js)
//   - EQUIPMENT_CATEGORIES: equipment-categories.json (from extract-equipment-categories.js)
//
// Edit index.template.html (not index.html directly — it gets overwritten here) for any
// HTML/CSS/JS changes, then run: node build.js
const fs = require("fs");

let html = fs.readFileSync("index.template.html", "utf8");

const parserSrc = fs.readFileSync("parser.js", "utf8");
const timelineBuilderSrc = fs.readFileSync("timeline-builder.js", "utf8");
const workerWrapper = fs.readFileSync("worker.js", "utf8").replace(/^importScripts\(.*\);?\r?\n/m, "");
const workerBlobSource = JSON.stringify(parserSrc + "\n" + workerWrapper);

const focusTrees = fs.readFileSync("focus-trees.json", "utf8");
const lawIdeas = fs.readFileSync("law-ideas.json", "utf8");
const characterNames = fs.readFileSync("character-names.json", "utf8");
const techYears = fs.readFileSync("tech-years.json", "utf8");
const equipmentCategories = fs.readFileSync("equipment-categories.json", "utf8");

// Using a replacer FUNCTION (not a plain string) for every substitution below: the file
// contents being spliced in (JS source, JSON data) can legitimately contain "$"-sequences
// (e.g. "$&", "$1", regex end-anchors) that String.replace would otherwise reinterpret as
// its own special replacement patterns and silently corrupt the output.
const inline = (marker, content) => {
	html = html.replace(marker, () => content);
};

inline("/*__WORKER_BLOB_SOURCE__*/", workerBlobSource);
inline("/*__PARSER_SOURCE__*/", parserSrc);
inline("/*__TIMELINE_BUILDER_SOURCE__*/", timelineBuilderSrc);
inline("/*__FOCUS_TREES__*/", focusTrees);
inline("/*__LAW_IDEAS__*/", lawIdeas);
inline("/*__CHARACTER_NAMES__*/", characterNames);
inline("/*__TECH_YEARS__*/", techYears);
inline("/*__EQUIPMENT_CATEGORIES__*/", equipmentCategories);

fs.writeFileSync("index.html", html);
console.log("Wrote index.html, size:", fs.statSync("index.html").size);
